import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignStore, CommittedTurn } from '../../../packages/domain/src/campaign.ts';
import { ledgerTotals } from '../../../packages/domain/src/gm.ts';
import { GM_PROPOSAL_INPUT } from '../../../packages/engine/src/check-offer.ts';
import {
  CLAUDE_CODE_REQUEST_OVERHEAD_TOKENS,
  GM_CONTEXT_RECORDED,
  MAX_RATIO,
} from '../../../packages/engine/src/gm-settings.ts';
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
  ProviderError,
  RULES_RETRY_PROMPT,
} from './gm-api.ts';
import { fakeSummarizer, SCENE_TURN_LIMIT, type Summarizer } from './gm-context.ts';
import type { GmProposal } from './gm-proposals.ts';
import { narrationOf } from './gm-segments.ts';
import { hermeticGmEnv } from './gm-test-env.ts';

const CAMPAIGN = 'api-gm';
const KEY = 'sk-ant-gateway-test-key';
const NARRATION = 'Firelight catches the stranger smiling as you sit down.';
const EARLIER_NARRATION = 'The stranger glances up from the bar and waits for you to speak.';
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
const SUMMARY_WAIT_MS = 5_000;
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

const CALIBRATION_RATIO = 1.7;
const RATIO_TOLERANCE = 0.2;

const lastNarration = (dataDir: string) => readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration;

type OpenedSession = ReturnType<typeof openClientSession>;

const submitActions = (session: OpenedSession['session'], campaignId: string, count: number) => {
  const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
  for (let turn = 0; turn < count; turn += 1) {
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
};

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
    const [output] = await play(dataDir, gm, [ACTION]);
    assert.equal(lastNarration(dataDir), '');
    assert.ok(output?.endsWith(FAKE_GM_REPLY));
  });

  it('narrates the next turn when an earlier turn stays pending', async (t) => {
    const dataDir = await seededCampaign(t);
    const gm: GameMaster = {
      request: async (packet) => {
        const text = JSON.stringify(packet).includes(SECOND_ACTION) ? NARRATION : `${NARRATION} ${GM_SECRET}`;
        return { narration: text, segments: [{ text }] };
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const output = await play(dataDir, gm, [ACTION, SECOND_ACTION]);
    assert.deepEqual(
      readCampaignState(dataDir, CAMPAIGN)
        .turns.slice(-2)
        .map(({ narration }) => narration),
      ['', NARRATION],
    );
    assert.ok(output.at(-1)?.includes(NARRATION));
    assert.ok(!output.at(-1)?.includes(FAKE_GM_REPLY));
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

  it('rpg-42a.147: a single-turn Claude Code run calibrates the ratio by its own overhead, a multi-turn run does not', async (t) => {
    const dataDir = await seededCampaign(t);
    const claudeCodeGm = (ratio: number, multiTurn: boolean): GameMaster => ({
      calibratesContext: true,
      contextRoute: 'claude-code',
      request: async (packet) => ({
        narration: NARRATION,
        segments: [{ text: NARRATION }],
        usage: {
          model: 'sonnet',
          inputTokens: CLAUDE_CODE_REQUEST_OVERHEAD_TOKENS + ratio * packet.usedTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1,
        },
        ...(multiTurn ? { multiTurn } : {}),
      }),
      summarizer: FAKE_GAME_MASTER.summarizer,
    });
    const ratios = () =>
      readCampaignState(dataDir, CAMPAIGN)
        .changes.filter(({ type }) => type === GM_CONTEXT_RECORDED)
        .map(({ payload }) => Number(payload.ratio));
    await play(dataDir, claudeCodeGm(CALIBRATION_RATIO, false), [ACTION]);
    const [first] = ratios();
    assert.ok(Math.abs((first ?? 0) - CALIBRATION_RATIO) < RATIO_TOLERANCE);
    await play(dataDir, claudeCodeGm(MAX_RATIO, true), [SECOND_ACTION]);
    assert.equal(ratios().at(-1), first);
  });

  it('rpg-42a.44 shows a plain error when the retry is rejected too and stops there', async (t) => {
    const dataDir = await seededCampaign(t);
    const tooLong = { status: BAD_REQUEST, body: 'prompt is too long: 300000 tokens' };
    const { received, gm } = await providerGm(t, [tooLong]);
    const [output] = await play(dataDir, gm, [ACTION]);
    assert.equal(received.length, 2);
    assert.match(output ?? '', /too long for the AI game master/);
    assert.equal(lastNarration(dataDir), '');
  });

  it('reports the provider error for the failed turn without a placeholder and asks the provider again next turn', async (t) => {
    const dataDir = await seededCampaign(t);
    const { received, gm } = await providerGm(t, [
      { status: UNAUTHORIZED, body: KEY },
      textReply(EARLIER_NARRATION),
      textReply(NARRATION),
    ]);
    const errors: unknown[] = [];
    const lines = (async function* () {
      yield* [ACTION, SECOND_ACTION];
    })();
    const output: string[] = [];
    for await (const text of createEngineGateway(dataDir, gm).open(CAMPAIGN, 'play', lines, (error) =>
      errors.push(error),
    ))
      output.push(text);
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /HTTP 401/);
    assert.ok(!output.some((text) => text.includes(FAKE_GM_REPLY)));
    assert.ok(output.at(-1)?.includes(NARRATION));
    assert.equal(received.length, 3);
    assert.ok(![...output, ...errors.map(String)].some((text) => text.includes(KEY)));
    assert.deepEqual(
      readCampaignState(dataDir, CAMPAIGN)
        .turns.slice(-2)
        .map(({ narration }) => narration),
      [EARLIER_NARRATION, NARRATION],
    );
  });

  it('does not show the placeholder reply for a turn left unnarrated', async (t) => {
    const dataDir = await seededCampaign(t);
    const { gm } = await providerGm(t, [{ status: UNAUTHORIZED }, { status: UNAUTHORIZED }, { status: UNAUTHORIZED }]);
    const lines = (async function* () {
      yield ACTION;
    })();
    for await (const _ of createEngineGateway(dataDir, gm).open(CAMPAIGN, 'play', lines, () => {}));
    assert.equal(lastNarration(dataDir), '');
    const { gm: offline } = await providerGm(t, [{ status: UNAUTHORIZED }, { status: UNAUTHORIZED }]);
    const reopened = createEngineGateway(dataDir, offline).open(CAMPAIGN, 'play', (async function* () {})(), () => {});
    const first = (await reopened[Symbol.asyncIterator]().next()).value as string;
    assert.ok(first.includes(ACTION));
    assert.ok(!first.includes(FAKE_GM_REPLY));
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

  it('rpg-42a.130 rejects player input that uses the GM proposal prefix', async (t) => {
    const dataDir = await seededCampaign(t);
    const { session, campaignId, close } = openClientSession(dataDir, CAMPAIGN, FAKE_GAME_MASTER);
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
      input: `${GM_PROPOSAL_INPUT}claim x`,
    });
    assert.equal(submitted.ok, false);
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

  it('rpg-cm63.49 stores the spoken GM segments on the committed turn for replay', async (t) => {
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
    await narrate();
    const after = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(after.ok);
    assert.deepEqual(after.value.turns.at(-1)?.segments, [
      { text: NARRATION },
      { speakerId: 'npc-stranger', text: ACTION, delivery: { emotion: 'whisper' } },
    ]);
  });

  it('rpg-42a.36 narrates from a built packet without waiting for a stuck or failing summarizer', async (t) => {
    const dataDir = await seededCampaign(t);
    const packets: ContextPacket[] = [];
    const narrator = (packet: ContextPacket) => {
      packets.push(packet);
      return { narration: NARRATION, segments: [{ text: NARRATION }] };
    };
    let failures = 0;
    let releaseStuck = () => {};
    const summarizers: readonly Summarizer[] = [
      async () => {
        failures += 1;
        throw new Error('stale revision');
      },
      () =>
        new Promise((_, reject) => {
          releaseStuck = () => reject(new Error('released'));
        }),
    ];
    for (const summarizer of summarizers) {
      const opened = openClientSession(dataDir, CAMPAIGN, { narrator, summarizer });
      const { session, campaignId, close, narrate } = opened;
      submitActions(session, campaignId, SCENE_TURN_LIMIT);
      const stuck = setTimeout(SUMMARY_WAIT_MS, STUCK, { ref: false });
      assert.notEqual(await Promise.race([narrate().then(() => 'narrated'), stuck]), STUCK);
      if (summarizer === summarizers[1]) releaseStuck();
      await opened.settle();
      close();
    }
    assert.equal(failures, 1);
    const input = packets[0]?.sections.find(({ name }) => name === 'playerInput')?.items;
    assert.deepEqual(input, [ACTION]);
  });

  it('rpg-42a.48 counts summarizer usage in the campaign totals', async (t) => {
    const dataDir = await seededCampaign(t);
    const summaryUsage = { model: 'sonnet', inputTokens: 11, cacheReadTokens: 7, cacheWriteTokens: 5, outputTokens: 3 };
    const turnUsage = { ...summaryUsage, inputTokens: 100 };
    let calls = 0;
    let narrations = 0;
    const gm: GameMaster = {
      request: async () => {
        narrations += 1;
        return { narration: NARRATION, segments: [{ text: NARRATION }], usage: turnUsage };
      },
      summarizer: async (_level, texts, _language, _model, onUsage) => {
        calls += 1;
        onUsage?.(summaryUsage);
        return fakeSummarizer('scene', texts, undefined);
      },
    };
    const opened = openClientSession(dataDir, CAMPAIGN, gm);
    submitActions(opened.session, opened.campaignId, SCENE_TURN_LIMIT);
    await opened.narrate();
    await opened.settle();
    const snapshot = opened.session.getSnapshot({
      version: PROTOCOL_VERSION,
      campaignId: opened.campaignId,
      type: 'GetCampaignSnapshot',
    });
    opened.close();
    assert.ok(snapshot.ok);
    assert.ok(calls > 0);
    const inputTokens = narrations * turnUsage.inputTokens + calls * summaryUsage.inputTokens;
    assert.ok(narrations > 0);
    assert.equal(snapshot.value.gm?.campaign.turns, narrations);
    assert.equal(snapshot.value.gm?.campaign.inputTokens, inputTokens);
    assert.equal(snapshot.value.gm?.session.turns, narrations);
    assert.equal(snapshot.value.gm?.session.inputTokens, inputTokens);
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

  it('returns the api segments, fails once with the provider error, then answers again', async (t) => {
    const segments = [{ text: NARRATION }, { speakerId: 'npc-stranger', text: 'Sit.' }];
    const toolReply = {
      body: JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'narrate', input: { segments } }] }),
    };
    const { gm } = await providerGm(t, [toolReply, { status: UNAUTHORIZED }, toolReply]);
    const reply = await gmReplyOf(gm);
    assert.deepEqual(reply.segments, segments);
    assertJoined(reply);
    await assert.rejects(gmReplyOf(gm), ProviderError);
    assertJoined(await gmReplyOf(gm));
  });
});

const MISS_RESULT = /"event":"(attack\.miss|check\.failure)"/;
const declaredFor = (packet: ContextPacket): 'hit' | 'miss' =>
  packet.sections.some(({ name, items }) => name === 'results' && items.some((item) => MISS_RESULT.test(item)))
    ? 'miss'
    : 'hit';

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

  const outcomeFor = (packet: ContextPacket): GmProposal => ({
    kind: 'outcome',
    id: 'result',
    text: 'a mechanical result',
    declared: declaredFor(packet),
  });
  const CLAIMING = new Set([HIT, 'Sua lâmina acerta o goblin.']);

  const scriptedGm = (replies: readonly string[], packets: ContextPacket[]): GameMaster => ({
    request: async (packet) => {
      packets.push(packet);
      const narration = replies[Math.min(packets.length, replies.length) - 1] ?? '';
      return {
        narration,
        segments: [{ text: narration }],
        ...(CLAIMING.has(narration) ? { proposals: [outcomeFor(packet)] } : {}),
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
    assert.equal(lastNarration(dataDir), '');
  });

  const ATTEMPT_USAGE = { model: 'sonnet', inputTokens: 100, cacheReadTokens: 7, cacheWriteTokens: 5, outputTokens: 3 };

  const usageGm = (replies: readonly (string | Error)[]): GameMaster => {
    let calls = 0;
    return {
      request: async (packet) => {
        const reply = replies[Math.min(calls, replies.length - 1)] ?? '';
        calls += 1;
        if (reply instanceof Error) throw reply;
        return {
          narration: reply,
          segments: [{ text: reply }],
          usage: ATTEMPT_USAGE,
          ...(CLAIMING.has(reply) ? { proposals: [outcomeFor(packet)] } : {}),
        };
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
  };

  const recordedUsage = (dataDir: string) => ledgerTotals(readCampaignState(dataDir, CAMPAIGN).gmUsage);

  it('rpg-42a.49 sums the usage of every narrator attempt once', async (t) => {
    const dataDir = await d20Campaign(t);
    await play(dataDir, usageGm([HIT, CLEAN]), [LOOK]);
    const totals = recordedUsage(dataDir);
    assert.equal(totals.turns, 2);
    assert.equal(totals.inputTokens, 2 * ATTEMPT_USAGE.inputTokens);
  });

  it('rpg-42a.49 keeps the usage of an earlier attempt when the retry throws', async (t) => {
    const dataDir = await d20Campaign(t);
    const lines = (async function* () {
      yield LOOK;
    })();
    const errors: unknown[] = [];
    for await (const _ of createEngineGateway(dataDir, usageGm([HIT, new ProviderError('retry failed')])).open(
      CAMPAIGN,
      'play',
      lines,
      (error) => errors.push(error),
    ));
    assert.equal(errors.length, 1);
    const totals = recordedUsage(dataDir);
    assert.equal(totals.turns, 1);
    assert.equal(totals.inputTokens, ATTEMPT_USAGE.inputTokens);
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

  const LOCK_PICK = 'I pick the lock';
  const LOCK_FAILS = 'The pick snaps and the lock holds.';
  const LOCK_WAITS = 'The lock clicks under your pick, and the door waits.';
  const missingGm = (packets: ContextPacket[]): GameMaster => ({
    request: async (packet) => {
      packets.push(packet);
      const narration = packets.length === 1 ? LOCK_FAILS : LOCK_WAITS;
      const proposals: readonly GmProposal[] =
        packets.length === 1 ? [{ kind: 'outcome', id: 'lock', text: 'the lock holds', declared: 'miss' }] : [];
      return { narration, segments: [{ text: narration }], proposals };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  });

  it('as-written rejects a narrated failure of a risky action with no check and regenerates once', async (t) => {
    const dataDir = await d20Campaign(t);
    const packets: ContextPacket[] = [];
    await play(dataDir, missingGm(packets), [LOCK_PICK]);
    assert.equal(packets.length, 2);
    assert.ok(packetParts(packets[1] as ContextPacket).instructions.includes(RULES_RETRY_PROMPT));
    assert.equal(lastNarration(dataDir), LOCK_WAITS);
  });

  for (const strictness of ['relaxed', 'off']) {
    it(`${strictness} keeps a narrated failure of a risky action with no check`, async (t) => {
      const dataDir = await d20Campaign(t);
      createEngineGateway(dataDir).settings(CAMPAIGN, { rulesStrictness: strictness });
      const packets: ContextPacket[] = [];
      await play(dataDir, missingGm(packets), [LOCK_PICK]);
      assert.equal(packets.length, 1);
      assert.equal(lastNarration(dataDir), LOCK_FAILS);
    });
  }

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

describe('rpg-42a.62 continuity on the real GM route', () => {
  const MARA = { kind: 'entity', id: 'mara', entityKind: 'npc', name: 'Mara', visibility: 'player' } as const;
  const DEAD = { kind: 'claim', id: 'mara-dead', entityId: 'mara', claimKind: 'alive', value: 'dead' } as const;
  const SECRET = {
    kind: 'claim',
    id: 'mara-plot',
    entityId: 'mara',
    claimKind: 'secret',
    key: 'plot',
    value: 'poisoned the well',
  } as const;
  const INTRO = 'Mara lies still beside the well.';
  const WAKES = 'Mara says hello to you.';
  const QUIET = 'The yard is silent.';
  const LEAK = 'Everyone knows Mara poisoned the well.';

  type Reply = { readonly narration: string; readonly proposals?: readonly GmProposal[] };

  const gmOf = (replies: readonly Reply[], packets: ContextPacket[], continuityCheck?: GameMaster['continuityCheck']) =>
    ({
      request: async (packet: ContextPacket) => {
        packets.push(packet);
        const reply = replies[Math.min(packets.length, replies.length) - 1] ?? { narration: '' };
        return { ...reply, segments: [{ text: reply.narration }] };
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
      ...(continuityCheck === undefined ? {} : { continuityCheck }),
    }) as GameMaster;

  const withClaims = async (t: TestContext, claims: readonly GmProposal[]) => {
    const dataDir = tempDataDir(t);
    for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
    await play(dataDir, gmOf([{ narration: INTRO, proposals: [MARA, ...claims] }], []), [ACTION]);
    return dataDir;
  };

  const instructionsOf = (packet: ContextPacket | undefined) => packetParts(packet ?? { sections: [] }).instructions;

  it('commits GM claims into the ledger', async (t) => {
    const dataDir = await withClaims(t, [DEAD]);
    const claims = readCampaignState(dataDir, CAMPAIGN).events.filter(({ type }) => type === 'ClaimRecorded');
    assert.deepEqual(
      claims.map(({ payload }) => [payload.entityId, payload.kind, payload.value]),
      [['mara', 'alive', 'dead']],
    );
  });

  it('regenerates once with the conflicting fact and records the clean narration', async (t) => {
    const dataDir = await withClaims(t, [DEAD]);
    const packets: ContextPacket[] = [];
    await play(dataDir, gmOf([{ narration: WAKES }, { narration: QUIET }], packets), [SECOND_ACTION]);
    assert.equal(packets.length, 2);
    assert.ok(instructionsOf(packets[1]).includes('Mara alive: dead'));
    assert.equal(lastNarration(dataDir), QUIET);
  });

  it('sends the player the canonical fact when the contradiction survives the retry', async (t) => {
    const dataDir = await withClaims(t, [DEAD]);
    const output = await play(dataDir, gmOf([{ narration: WAKES }], []), [SECOND_ACTION]);
    assert.ok(!lastNarration(dataDir)?.includes(WAKES));
    assert.ok(!output.join('').includes(WAKES));
    assert.match(lastNarration(dataDir) ?? '', /Mara alive: dead/);
  });

  it('never lets a GM-only claim reach the player or the retry prompt', async (t) => {
    const dataDir = await withClaims(t, [SECRET]);
    const packets: ContextPacket[] = [];
    const output = await play(dataDir, gmOf([{ narration: LEAK }], packets), [SECOND_ACTION]);
    assert.ok(!output.join('').includes('poisoned'));
    assert.ok(!(lastNarration(dataDir) ?? '').includes('poisoned'));
    for (const packet of packets) assert.ok(!JSON.stringify(packet).includes('poisoned'));
  });

  it('applies conflicts found by the model check', async (t) => {
    const dataDir = await withClaims(t, [DEAD]);
    const modelFlags: GameMaster['continuityCheck'] = ({ narration }) =>
      narration === 'Mara owes you a debt.'
        ? [{ kind: 'model', entityId: null, fact: 'Mara alive: dead', excerpt: narration }]
        : [];
    const packets: ContextPacket[] = [];
    await play(dataDir, gmOf([{ narration: 'Mara owes you a debt.' }, { narration: QUIET }], packets, modelFlags), [
      ACTION,
    ]);
    assert.equal(packets.length, 2);
    assert.ok(instructionsOf(packets[1]).includes('Mara alive: dead'));
    assert.equal(lastNarration(dataDir), QUIET);
  });
});
