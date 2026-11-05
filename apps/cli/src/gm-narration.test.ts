import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignStore, CommittedTurn } from '../../../packages/domain/src/campaign.ts';
import { GameMasterInterruptedError } from '../../../packages/engine/src/scripted-session.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
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
import { API_KEY_ENV, apiRouteOf, FAKE_ROUTE, GM_API_URL_ENV, GM_ROUTE_ENV } from './gm-api.ts';
import { SCENE_TURN_LIMIT, type Summarizer } from './gm-context.ts';
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
const UNAUTHORIZED = 401;
const NO_DELAY_MS = 0;
const NO_CHARACTER = async () => undefined;
const SUMMARY_WAIT_MS = 1_000;
const STUCK = 'stuck';

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
