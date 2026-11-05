import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignStore, CommittedTurn } from '../../../packages/domain/src/campaign.ts';
import { GM_CONTEXT_RECORDED } from '../../../packages/engine/src/gm-settings.ts';
import { GameMasterInterruptedError } from '../../../packages/engine/src/scripted-session.ts';
import { CHECK_RESOLVED } from '../../../packages/engine/src/turn.ts';
import { CONTEXT_BUDGETS, type ContextPacket, packetParts } from '../../../packages/memory/src/packet.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { type ProviderReply, startProviderServer, textReply } from '../../../packages/testkit/src/provider-server.ts';
import {
  apiGameMaster,
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  gameMasterFor,
  NO_KEY_NOTICE,
  narratedTurn,
  noKeyGameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import {
  API_KEY_ENV,
  apiRouteOf,
  FAKE_ROUTE,
  GM_API_URL_ENV,
  GM_ROUTE_ENV,
  languageInstruction,
  RULES_RETRY_PROMPT,
} from './gm-api.ts';
import { SCENE_TURN_LIMIT, type Summarizer } from './gm-context.ts';
import type { GmProposal } from './gm-proposals.ts';
import { narrationOf } from './gm-segments.ts';
import { hermeticGmEnv } from './gm-test-env.ts';

const CAMPAIGN = 'api-gm';
const KEY = 'sk-ant-gateway-test-key';
const NARRATION = 'Firelight catches the stranger smiling as you sit down.';
const ACTION = 'I sit by the fire';
const SECOND_ACTION = 'I order a drink';
const GM_SECRET = 'SECRET_THE_STRANGER_IS_THE_KING';
const PLAYER_FACT = 'The inn is called the Crossroads.';
const INSERT_FACT = 'INSERT INTO fact (id, campaign_id, statement, layer, visibility) VALUES (?, ?, ?, ?, ?)';
const CANON = 'canon';
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NO_DELAY_MS = 0;
const NO_CHARACTER = async () => undefined;
const SUMMARY_WAIT_MS = 1_000;
const STUCK = 'stuck';
const PORTUGUESE = 'pt-BR';

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-api-gm-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const seededCampaign = async (t: TestContext) => {
  const dataDir = tempDataDir(t);
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  try {
    const insert = connection.database.prepare(INSERT_FACT);
    insert.run(randomUUID(), campaignId, GM_SECRET, CANON, 'gm');
    insert.run(randomUUID(), campaignId, PLAYER_FACT, CANON, 'player');
  } finally {
    connection.close();
  }
  return dataDir;
};

const providerGm = async (t: TestContext, replies: readonly ProviderReply[]) => {
  const provider = await startProviderServer(replies);
  t.after(provider.close);
  const route = { ...apiRouteOf(KEY, { [GM_API_URL_ENV]: provider.url }), retryDelayMs: NO_DELAY_MS };
  return { received: provider.received, gm: apiGameMaster(route) };
};

const play = async (dataDir: string, gm: GameMaster, actions: readonly string[]) => {
  const lines = (async function* () {
    yield* actions;
  })();
  const output: string[] = [];
  for await (const text of createEngineGateway(dataDir, gm).open(CAMPAIGN, 'play', lines, assert.ifError))
    output.push(text);
  return output.slice(1);
};

const lastNarration = (dataDir: string) => readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration;

describe('rpg-42a.28 API game master wiring', () => {
  it('rpg-42a.40 a fake game master receives the campaign language instruction in the packet', async (t) => {
    const dataDir = tempDataDir(t);
    for await (const _ of createEngineGateway(dataDir).create(
      CAMPAIGN,
      undefined,
      NO_CHARACTER,
      undefined,
      PORTUGUESE,
    ));
    const packets: ContextPacket[] = [];
    const gm: GameMaster = {
      narrator: (packet) => {
        packets.push(packet);
        return { narration: NARRATION, segments: [{ text: NARRATION }] };
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    await play(dataDir, gm, [ACTION]);
    assert.ok(packetParts(packets[0] ?? { sections: [] }).instructions.endsWith(languageInstruction(PORTUGUESE)));
  });

  it('records the provider narration from a player-only brief', async (t) => {
    const dataDir = await seededCampaign(t);
    const { received, gm } = await providerGm(t, [textReply(NARRATION)]);
    const [output] = await play(dataDir, gm, [ACTION]);
    assert.match(output ?? '', new RegExp(NARRATION));
    assert.equal(lastNarration(dataDir), NARRATION);
    const sent = JSON.stringify(received[0]?.body);
    assert.ok(sent.includes(ACTION));
    assert.ok(sent.includes(PLAYER_FACT));
    assert.ok(!sent.includes(GM_SECRET));
  });

  it('keeps a narration that leaks a GM secret out of the story', async (t) => {
    const dataDir = await seededCampaign(t);
    const { gm } = await providerGm(t, [textReply(`${NARRATION} ${GM_SECRET}`)]);
    await play(dataDir, gm, [ACTION]);
    assert.equal(lastNarration(dataDir), FAKE_GM_REPLY);
  });

  it('rpg-42a.44 retries a too-long rejection once with a smaller preset and records counts only', async (t) => {
    const dataDir = await seededCampaign(t);
    const tooLong = { status: BAD_REQUEST, body: 'prompt is too long: 300000 tokens' };
    const { received, gm } = await providerGm(t, [tooLong, textReply(NARRATION)]);
    await play(dataDir, gm, [ACTION]);
    assert.equal(received.length, 2);
    assert.equal(lastNarration(dataDir), NARRATION);
    const recorded = readCampaignState(dataDir, CAMPAIGN).changes.find(({ type }) => type === GM_CONTEXT_RECORDED);
    assert.equal(recorded?.payload.budget, CONTEXT_BUDGETS.compact);
    assert.ok(!JSON.stringify(recorded).includes(ACTION));
  });

  it('rpg-42a.44 shows a plain error when the retry is rejected too and stops there', async (t) => {
    const dataDir = await seededCampaign(t);
    const tooLong = { status: BAD_REQUEST, body: 'prompt is too long: 300000 tokens' };
    const { received, gm } = await providerGm(t, [tooLong]);
    const [output] = await play(dataDir, gm, [ACTION]);
    assert.equal(received.length, 2);
    assert.match(output ?? '', /too long for the AI game master/);
  });

  it('tells the player once about a provider error and continues on the fake route', async (t) => {
    const dataDir = await seededCampaign(t);
    const { received, gm } = await providerGm(t, [{ status: UNAUTHORIZED, body: KEY }]);
    const [first, second] = await play(dataDir, gm, [ACTION, SECOND_ACTION]);
    assert.match(first ?? '', /HTTP 401/);
    assert.ok(first?.endsWith(FAKE_GM_REPLY));
    assert.ok(!second?.includes('HTTP'));
    assert.ok(second?.endsWith(FAKE_GM_REPLY));
    assert.equal(received.length, 1);
    for (const text of [first, second]) assert.ok(!text?.includes(KEY));
  });

  it('tells the player once that no provider key is set', async (t) => {
    const dataDir = await seededCampaign(t);
    const [first, second] = await play(dataDir, noKeyGameMaster(), [ACTION, SECOND_ACTION]);
    assert.ok(first?.includes(NO_KEY_NOTICE));
    assert.ok(!second?.includes(NO_KEY_NOTICE));
    assert.ok(second?.endsWith(FAKE_GM_REPLY));
  });

  it('narrates a client session turn before the next snapshot', async (t) => {
    const dataDir = await seededCampaign(t);
    const { gm } = await providerGm(t, [textReply(NARRATION)]);
    const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm);
    t.after(close);
    const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
    const before = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(before.ok);
    const { revision, currentScene, characters } = before.value;
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: revision,
      sceneId: currentScene?.id ?? '',
      actorId: characters[0]?.id ?? '',
      input: ACTION,
    });
    assert.ok(submitted.ok);
    await narrate();
    const after = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(after.ok);
    assert.equal(after.value.turns.at(-1)?.narration, NARRATION);
  });

  it('rpg-cm63.10 hands the GM segments back with the narrated turn', async (t) => {
    const dataDir = await seededCampaign(t);
    const segments = [
      { text: NARRATION },
      { speakerId: 'npc-stranger', text: ACTION, important: true, delivery: { emotion: 'whisper' } },
    ];
    const gm: GameMaster = {
      request: async () => ({ narration: narrationOf(segments), segments }),
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm);
    t.after(close);
    const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
    const before = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(before.ok);
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: before.value.revision,
      sceneId: before.value.currentScene?.id ?? '',
      actorId: before.value.characters[0]?.id ?? '',
      input: ACTION,
    });
    assert.ok(submitted.ok);
    assert.deepEqual(await narrate(), segments);
    assert.deepEqual(await narrate(), []);
  });

  it('rpg-42a.36 narrates from a built packet without waiting for a stuck or failing summarizer', async (t) => {
    const dataDir = await seededCampaign(t);
    const packets: ContextPacket[] = [];
    const narrator = (packet: ContextPacket) => {
      packets.push(packet);
      return { narration: NARRATION, segments: [{ text: NARRATION }] };
    };
    let failures = 0;
    const summarizers: readonly Summarizer[] = [
      async () => {
        failures += 1;
        throw new Error('stale revision');
      },
      () => new Promise(() => {}),
    ];
    for (const summarizer of summarizers) {
      const opened = openClientSession(dataDir, CAMPAIGN, { narrator, summarizer });
      const { session, campaignId, close, narrate } = opened;
      const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
      for (let turn = 0; turn < SCENE_TURN_LIMIT; turn += 1) {
        const snapshot = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
        assert.ok(snapshot.ok);
        const { revision, currentScene, characters } = snapshot.value;
        const submitted = session.submitPlayerAction({
          ...envelope,
          type: 'SubmitPlayerAction',
          actionId: randomUUID(),
          expectedRevision: revision,
          sceneId: currentScene?.id ?? '',
          actorId: characters[0]?.id ?? '',
          input: ACTION,
        });
        assert.ok(submitted.ok);
      }
      const stuck = setTimeout(SUMMARY_WAIT_MS, STUCK);
      assert.notEqual(await Promise.race([narrate().then(() => 'narrated'), stuck]), STUCK);
      if (summarizer === summarizers[0]) await opened.settle();
      close();
    }
    assert.equal(failures, 1);
    const input = packets[0]?.sections.find(({ name }) => name === 'playerInput')?.items;
    assert.deepEqual(input, [ACTION]);
  });

  it('picks the game master from the key, or the built-in narrator when the player asks for it', async (t) => {
    const dataDir = await seededCampaign(t);
    const chosen = await gameMasterFor({ ...hermeticGmEnv(), [API_KEY_ENV]: KEY, [GM_ROUTE_ENV]: FAKE_ROUTE });
    assert.equal(chosen.route, 'fake');
    assert.deepEqual(await play(dataDir, chosen.gm, [ACTION]), [`The Wanderer: ${ACTION}\n${FAKE_GM_REPLY}`]);
    const missing = await gameMasterFor(hermeticGmEnv());
    assert.equal(missing.route, 'fake');
    assert.ok((await play(dataDir, missing.gm, [ACTION]))[0]?.includes(NO_KEY_NOTICE));
    assert.equal((await gameMasterFor({ ...hermeticGmEnv(), [API_KEY_ENV]: KEY })).route, 'api');
  });
});

const EMPTY_PACKET = { sections: [] } as unknown as ContextPacket;
const GM_CALL = { databasePath: '', model: undefined };

const gmReplyOf = async (gm: GameMaster) =>
  'narrator' in gm ? gm.narrator(EMPTY_PACKET) : await gm.request(EMPTY_PACKET, GM_CALL);

const assertJoined = (reply: { narration: string; segments: readonly { text: string }[] }) => {
  assert.ok(reply.segments.length > 0);
  assert.equal(reply.narration, narrationOf(reply.segments));
};

describe('rpg-cm63.3 game master segments on every route', () => {
  it('returns one narrator segment from the built-in and no-key narrators', async () => {
    assert.deepEqual(await gmReplyOf(FAKE_GAME_MASTER), {
      narration: FAKE_GM_REPLY,
      segments: [{ text: FAKE_GM_REPLY }],
    });
    const noKey = noKeyGameMaster();
    for (let turn = 0; turn < 2; turn += 1) assertJoined(await gmReplyOf(noKey));
  });

  it('returns the api segments, then narrator segments after the provider fails', async (t) => {
    const segments = [{ text: NARRATION }, { speakerId: 'npc-stranger', text: 'Sit.' }];
    const toolReply = {
      body: JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'narrate', input: { segments } }] }),
    };
    const { gm } = await providerGm(t, [toolReply, { status: UNAUTHORIZED }]);
    const reply = await gmReplyOf(gm);
    assert.deepEqual(reply.segments, segments);
    assertJoined(reply);
    assertJoined(await gmReplyOf(gm));
    assertJoined(await gmReplyOf(gm));
  });
});

describe('rpg-42a.27 narrated turn outcomes', () => {
  const committed = { turn: { id: 't1', campaignId: 'c1', narration: '' } } as unknown as CommittedTurn;
  const recordingStore = () => {
    const recorded: string[] = [];
    const store = {
      recordNarration: (_c: string, _t: string, text: string) => recorded.push(text),
    } as unknown as CampaignStore;
    return { recorded, store };
  };

  it('records and shows the fallback reply when narration is inconsistent', () => {
    const { recorded, store } = recordingStore();
    const turn = narratedTurn(store, { committed, inconsistent: { ok: false, violations: [] } });
    assert.equal(turn.turn.narration, FAKE_GM_REPLY);
    assert.deepEqual(recorded, [FAKE_GM_REPLY]);
  });

  it('keeps an interrupted turn pending without recording', () => {
    const { recorded, store } = recordingStore();
    const turn = narratedTurn(store, { committed, interrupted: new GameMasterInterruptedError(0) });
    assert.equal(turn.turn.narration, '');
    assert.deepEqual(recorded, []);
  });
});

describe('rpg-42a.58 rules strictness in the GM path', () => {
  const D20_PITCH = 'A fantasy story using the d20-lite rules';
  const HIT = 'Your blade hits the goblin for 5 damage.';
  const CLEAN = 'The goblin snarls and waits for your move.';
  const LOOK = 'I look around the camp';
  const ATTACK = 'I attack the goblin';

  const d20Campaign = async (t: TestContext) => {
    const dataDir = tempDataDir(t);
    const describe = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
    for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, D20_PITCH, describe));
    return dataDir;
  };

  const OUTCOME: GmProposal = { kind: 'outcome', id: 'result', text: 'a mechanical result' };
  const CLAIMING = new Set([HIT, 'Sua lâmina acerta o goblin.']);

  const scriptedGm = (replies: readonly string[], packets: ContextPacket[]): GameMaster => ({
    request: async (packet) => {
      packets.push(packet);
      const narration = replies[Math.min(packets.length, replies.length) - 1] ?? '';
      return {
        narration,
        segments: [{ text: narration }],
        ...(CLAIMING.has(narration) ? { proposals: [OUTCOME] } : {}),
      };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  });

  const retryLines = (packets: readonly ContextPacket[]) =>
    packets.filter((packet) => packetParts(packet).instructions.includes(RULES_RETRY_PROMPT)).length;

  it('as-written rejects a hit with no resolved attack and regenerates once', async (t) => {
    const dataDir = await d20Campaign(t);
    const packets: ContextPacket[] = [];
    await play(dataDir, scriptedGm([HIT, CLEAN], packets), [LOOK]);
    assert.equal(packets.length, 2);
    assert.equal(retryLines(packets), 1);
    assert.equal(lastNarration(dataDir), CLEAN);
  });

  it('as-written falls back after a second rejected narration and never asks a third time', async (t) => {
    const dataDir = await d20Campaign(t);
    const packets: ContextPacket[] = [];
    await play(dataDir, scriptedGm([HIT], packets), [LOOK]);
    assert.equal(packets.length, 2);
    assert.equal(lastNarration(dataDir), FAKE_GM_REPLY);
  });

  it('as-written turns an attack into an engine roll, so the same narration passes without a retry', async (t) => {
    const dataDir = await d20Campaign(t);
    const packets: ContextPacket[] = [];
    await play(dataDir, scriptedGm([HIT], packets), [ATTACK]);
    const state = readCampaignState(dataDir, CAMPAIGN);
    assert.ok(state.events.some(({ type }) => type === CHECK_RESOLVED));
    assert.equal(packets.length, 1);
    assert.equal(lastNarration(dataDir), HIT);
  });

  it('in Portuguese an attack becomes an engine roll and the matching narration is accepted', async (t) => {
    const dataDir = tempDataDir(t);
    const describe = async () => 'Wren, uma batedora. Might 3, Agility 2, Wits 2, Presence 1';
    for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, D20_PITCH, describe, undefined, PORTUGUESE));
    const packets: ContextPacket[] = [];
    const narration = 'Sua lâmina acerta o goblin.';
    await play(dataDir, scriptedGm([narration], packets), ['Eu ataco o goblin']);
    assert.ok(readCampaignState(dataDir, CAMPAIGN).events.some(({ type }) => type === CHECK_RESOLVED));
    assert.equal(packets.length, 1);
    assert.equal(lastNarration(dataDir), narration);
  });

  it('in Portuguese a hit claim with no roll is rejected and regenerated once', async (t) => {
    const dataDir = tempDataDir(t);
    for await (const _ of createEngineGateway(dataDir).create(
      CAMPAIGN,
      D20_PITCH,
      NO_CHARACTER,
      undefined,
      PORTUGUESE,
    ));
    const packets: ContextPacket[] = [];
    await play(dataDir, scriptedGm(['Sua lâmina acerta o goblin.', 'O goblin ruge e espera.'], packets), [
      'Eu olho em volta',
    ]);
    assert.equal(packets.length, 2);
    assert.equal(lastNarration(dataDir), 'O goblin ruge e espera.');
  });

  for (const strictness of ['relaxed', 'off']) {
    it(`${strictness} skips the post-check and the attack roll`, async (t) => {
      const dataDir = await d20Campaign(t);
      createEngineGateway(dataDir).settings(CAMPAIGN, { rulesStrictness: strictness });
      const packets: ContextPacket[] = [];
      await play(dataDir, scriptedGm([HIT], packets), [ATTACK]);
      assert.equal(packets.length, 1);
      assert.equal(lastNarration(dataDir), HIT);
      assert.equal(
        readCampaignState(dataDir, CAMPAIGN).events.some(({ type }) => type === CHECK_RESOLVED),
        false,
      );
    });
  }
});
