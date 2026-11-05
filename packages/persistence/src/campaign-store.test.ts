import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { test } from 'node:test';
import {
  type Campaign,
  CampaignBoundaryError,
  type CampaignChange,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  MAIN_BRANCH,
  StaleRevisionError,
  type TurnCommit,
} from '../../domain/src/campaign.ts';
import { EMPTY_GM_USAGE_LEDGER } from '../../domain/src/gm.ts';
import { createCampaignStore } from './campaign-store.ts';
import { MIGRATIONS, openDatabase } from './database.ts';
import { createEventStore } from './event-store.ts';

const IN_MEMORY = ':memory:';
const TEMP_PREFIX = 'rpg-campaign-store-';
const DATABASE_FILE = 'campaign.sqlite';
const INITIAL_REVISION = 0;
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CHARACTER = { id: 'character-1', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const TURN = {
  id: 'turn-1',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'action-1',
  actorId: CHARACTER.id,
  input: 'I look for the ferryman.',
  narration: 'A lantern sways at the end of the pier.',
};
const ACTION_EVENT = {
  id: 'event-1',
  campaignId: CAMPAIGN.id,
  turnId: TURN.id,
  causationId: null,
  type: 'PlayerActionSubmitted',
  payload: { input: TURN.input },
};
const NARRATION_EVENT = {
  id: 'event-2',
  campaignId: CAMPAIGN.id,
  turnId: TURN.id,
  causationId: ACTION_EVENT.id,
  type: 'TurnNarrated',
  payload: { narration: TURN.narration },
};
const COMMIT: TurnCommit = {
  expectedRevision: INITIAL_REVISION,
  turn: TURN,
  characters: [CHARACTER],
  scenes: [SCENE],
  events: [ACTION_EVENT, NARRATION_EVENT],
};
const EXPECTED_STATE: CampaignState = {
  campaign: CAMPAIGN,
  revision: INITIAL_REVISION + 1,
  characters: [CHARACTER],
  currentScene: SCENE,
  turns: [TURN],
  events: [ACTION_EVENT, NARRATION_EVENT],
  changes: [{ type: 'CampaignCreated', payload: { name: CAMPAIGN.name } }],
  gmUsage: EMPTY_GM_USAGE_LEDGER,
};

const OTHER_CAMPAIGN = { id: 'campaign-2', name: 'Salt Roads' };
const MISSING_ID = 'missing';
const COMMITTED_TURN = { turn: TURN, events: [ACTION_EVENT, NARRATION_EVENT] };
const REWARD_EVENT = {
  ...NARRATION_EVENT,
  id: 'event-reward',
  type: 'RewardGranted',
  payload: { item: 'lantern', quantity: 1 },
};
const DUPLICATE_EVENT = /event_log is append-only/;
const READ_ONLY = /readonly database/;

const emptyState = (campaign: Campaign): CampaignState => ({
  campaign,
  revision: INITIAL_REVISION,
  characters: [],
  currentScene: undefined,
  turns: [],
  events: [],
  changes: [{ type: 'CampaignCreated', payload: { name: campaign.name } }],
  gmUsage: EMPTY_GM_USAGE_LEDGER,
});

const change = (campaign: Campaign, id: string, type: string): CampaignChange => ({
  id,
  campaignId: campaign.id,
  branchId: MAIN_BRANCH,
  actionId: `action-${id}`,
  type,
  payload: { name: campaign.name },
});

const createdEvent = (campaign: Campaign) => change(campaign, `created-${campaign.id}`, 'CampaignCreated');

const create = (store: CampaignStore, campaign: Campaign) => store.createCampaign(campaign, createdEvent(campaign));

const SELECT_CAMPAIGN_EVENTS =
  'SELECT id, campaign_id, branch_id, revision, action_id, turn_id, type, payload FROM event_log WHERE turn_id IS NULL ORDER BY seq';

const campaignEvents = (connection: ReturnType<typeof openDatabase>) =>
  connection.database
    .prepare(SELECT_CAMPAIGN_EVENTS)
    .all()
    .map((row) => ({ ...row, payload: JSON.parse(String(row.payload)) }));

const eventRow = (event: CampaignChange, revision: number) => ({
  id: event.id,
  campaign_id: event.campaignId,
  branch_id: event.branchId,
  revision,
  action_id: event.actionId,
  turn_id: null,
  type: event.type,
  payload: event.payload,
});

const openStore = (path: string) => {
  const connection = openDatabase(path);
  return { connection, store: createCampaignStore(connection.database) };
};

test('store and retrieve a campaign, character, current scene and single turn', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  assert.deepEqual(store.load(CAMPAIGN.id), emptyState(CAMPAIGN));
  store.commitTurn(COMMIT);
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  assert.equal(store.load(MISSING_ID), undefined);
  connection.close();
});

test('a turn stores the visibility the engine assigns per event and gm for the rest', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  assert.deepEqual(store.commitTurn({ ...COMMIT, visibility: { [ACTION_EVENT.id]: 'player' } }), {
    turn: TURN,
    events: COMMIT.events,
  });
  const rows = connection.database
    .prepare('SELECT id, visibility FROM event_log WHERE turn_id = ? ORDER BY seq')
    .all(TURN.id);
  assert.deepEqual(
    rows.map(({ id, visibility }) => [id, visibility]),
    [
      [ACTION_EVENT.id, 'player'],
      [NARRATION_EVENT.id, 'gm'],
    ],
  );
  connection.close();
});

test('a turn refuses actor-scoped visibility because a turn event has no owner scope', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  const scoped = { [ACTION_EVENT.id]: 'actor-scoped' } as unknown as NonNullable<TurnCommit['visibility']>;
  assert.throws(() => store.commitTurn({ ...COMMIT, visibility: scoped }), RangeError);
  assert.equal(store.load(CAMPAIGN.id)?.revision, INITIAL_REVISION);
  connection.close();
});

test('stale revision or failed turn writes nothing', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn(COMMIT);
  const second = { ...COMMIT, turn: { ...TURN, id: 'turn-2', actionId: 'action-2' }, events: [] };
  assert.throws(() => store.commitTurn(second), StaleRevisionError);
  const lateFailure: TurnCommit = {
    expectedRevision: INITIAL_REVISION + 1,
    turn: { ...TURN, id: 'turn-2', actionId: 'action-2', sceneId: 'scene-2', actorId: 'character-2' },
    characters: [{ ...CHARACTER, id: 'character-2', name: 'Oren' }],
    scenes: [{ ...SCENE, id: 'scene-2', title: 'The Ferry' }],
    events: [
      { ...ACTION_EVENT, id: 'event-3', turnId: 'turn-2' },
      { ...NARRATION_EVENT, id: 'event-3', turnId: 'turn-2', causationId: 'event-3' },
    ],
  };
  assert.throws(() => store.commitTurn(lateFailure), DUPLICATE_EVENT);
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  assert.throws(
    () => store.commitTurn({ ...COMMIT, turn: { ...TURN, campaignId: MISSING_ID } }),
    CampaignNotFoundError,
  );
  connection.close();
});

test('validate preconditions and commit effects/events with revision checks and idempotency keys', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  assert.deepEqual(store.commitTurn(COMMIT), COMMITTED_TURN);
  const retry: TurnCommit = {
    ...COMMIT,
    turn: { ...TURN, id: 'turn-2' },
    events: [{ ...ACTION_EVENT, id: 'event-3', turnId: 'turn-2' }],
  };
  assert.deepEqual(store.commitTurn(retry), COMMITTED_TURN);
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  const stale = { ...retry, turn: { ...retry.turn, actionId: 'action-2' } };
  assert.throws(() => store.commitTurn(stale), StaleRevisionError);
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  connection.close();
});

test('concurrent turns or retry after timeout do not duplicate inventory or rewards', async () => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(dir, DATABASE_FILE);
    const first = openStore(path);
    create(first.store, CAMPAIGN);
    const second = openStore(path);
    const rewarded: TurnCommit = { ...COMMIT, events: [ACTION_EVENT, REWARD_EVENT] };
    const rival: TurnCommit = {
      ...rewarded,
      turn: { ...TURN, id: 'turn-2', actionId: 'action-2' },
      events: [{ ...REWARD_EVENT, id: 'event-rival', turnId: 'turn-2' }],
    };
    first.store.commitTurn(rewarded);
    assert.throws(() => second.store.commitTurn(rival), StaleRevisionError);
    assert.deepEqual(second.store.commitTurn(rewarded), { turn: TURN, events: rewarded.events });
    assert.deepEqual(first.store.load(CAMPAIGN.id), { ...EXPECTED_STATE, events: rewarded.events });
    first.connection.close();
    second.connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a turn for one campaign cannot write or reference another campaign', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn(COMMIT);
  create(store, OTHER_CAMPAIGN);
  const ownCharacter = { id: 'character-2', campaignId: OTHER_CAMPAIGN.id, name: 'Oren' };
  const ownScene = { id: 'scene-2', campaignId: OTHER_CAMPAIGN.id, title: 'The Ferry' };
  const ownTurn = {
    ...TURN,
    id: 'turn-2',
    campaignId: OTHER_CAMPAIGN.id,
    sceneId: ownScene.id,
    actorId: ownCharacter.id,
  };
  const ownEvent = { ...ACTION_EVENT, id: 'event-3', campaignId: OTHER_CAMPAIGN.id, turnId: ownTurn.id };
  const valid: TurnCommit = {
    expectedRevision: INITIAL_REVISION,
    turn: ownTurn,
    characters: [ownCharacter],
    scenes: [ownScene],
    events: [ownEvent],
  };
  const attempts: TurnCommit[] = [
    { ...valid, characters: [ownCharacter, { ...CHARACTER, campaignId: OTHER_CAMPAIGN.id, name: 'Impostor' }] },
    { ...valid, characters: [ownCharacter, { ...CHARACTER, name: 'Impostor' }] },
    { ...valid, scenes: [ownScene, { ...SCENE, campaignId: OTHER_CAMPAIGN.id, title: 'Stolen' }] },
    { ...valid, scenes: [ownScene, { ...SCENE, title: 'Stolen' }] },
    { ...valid, turn: { ...ownTurn, sceneId: SCENE.id } },
    { ...valid, turn: { ...ownTurn, actorId: CHARACTER.id } },
    { ...valid, events: [{ ...ownEvent, campaignId: CAMPAIGN.id }] },
    { ...valid, events: [{ ...ownEvent, turnId: TURN.id }] },
    { ...valid, events: [{ ...ownEvent, causationId: ACTION_EVENT.id }] },
  ];
  for (const attempt of attempts) {
    assert.throws(() => store.commitTurn(attempt), CampaignBoundaryError);
    assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
    assert.deepEqual(store.load(OTHER_CAMPAIGN.id), emptyState(OTHER_CAMPAIGN));
  }
  store.commitTurn(valid);
  assert.equal(store.load(OTHER_CAMPAIGN.id)?.revision, INITIAL_REVISION + 1);
  connection.close();
});

test('opening the same campaign after process restart yields identical identifiers and state', async () => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(dir, DATABASE_FILE);
    const first = openStore(path);
    create(first.store, CAMPAIGN);
    first.store.commitTurn(COMMIT);
    const before = first.store.load(CAMPAIGN.id);
    first.connection.close();

    const reopened = openStore(path);
    const after = reopened.store.load(CAMPAIGN.id);
    reopened.connection.close();
    assert.deepEqual(after, before);
    assert.deepEqual(after, EXPECTED_STATE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('create and rename record a main-branch event with revision and action id in the same transaction', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  const renamed = { ...CAMPAIGN, name: 'Harbor Lights Renamed' };
  const renamedEvent = change(renamed, 'renamed-1', 'CampaignRenamed');
  store.renameCampaign({ expectedRevision: INITIAL_REVISION, campaign: renamed, event: renamedEvent });
  assert.deepEqual(store.load(CAMPAIGN.id), {
    ...emptyState(renamed),
    revision: INITIAL_REVISION + 1,
    changes: [...emptyState(CAMPAIGN).changes, { type: 'CampaignRenamed', payload: { name: renamed.name } }],
  });
  assert.deepEqual(campaignEvents(connection), [
    eventRow(createdEvent(CAMPAIGN), INITIAL_REVISION),
    eventRow(renamedEvent, INITIAL_REVISION + 1),
  ]);
  connection.close();
});

test('rejected campaign writes leave campaigns and events unchanged', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  create(store, OTHER_CAMPAIGN);
  const before = campaignEvents(connection);
  const renamed = { ...CAMPAIGN, name: 'Stolen' };
  const event = change(renamed, 'renamed-1', 'CampaignRenamed');
  const rename = { expectedRevision: INITIAL_REVISION, campaign: renamed, event };
  const missing = { id: MISSING_ID, name: 'Nowhere' };
  const attempts: [() => void, new (...args: never[]) => Error][] = [
    [() => store.renameCampaign({ ...rename, expectedRevision: INITIAL_REVISION + 1 }), StaleRevisionError],
    [
      () => store.renameCampaign({ ...rename, campaign: missing, event: change(missing, 'm', 'CampaignRenamed') }),
      CampaignNotFoundError,
    ],
    [
      () => store.renameCampaign({ ...rename, event: { ...event, campaignId: OTHER_CAMPAIGN.id } }),
      CampaignBoundaryError,
    ],
    [() => store.renameCampaign({ ...rename, event: { ...event, branchId: 'side' } }), CampaignBoundaryError],
    [() => store.createCampaign(missing, { ...event, campaignId: CAMPAIGN.id }), CampaignBoundaryError],
    [
      () => store.createCampaign(missing, { ...change(missing, 'm', 'CampaignCreated'), branchId: 'side' }),
      CampaignBoundaryError,
    ],
  ];
  for (const [attempt, error] of attempts) {
    assert.throws(attempt, error);
    assert.deepEqual(store.load(CAMPAIGN.id), emptyState(CAMPAIGN));
    assert.equal(store.load(MISSING_ID), undefined);
    assert.deepEqual(campaignEvents(connection), before);
  }
  connection.close();
});

const withTempPath = async (run: (path: string) => void | Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    await run(join(dir, DATABASE_FILE));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const KILL_SIGNAL = 'SIGKILL';
const SECOND_TURN = { ...TURN, id: 'turn-2', actionId: 'action-2', input: 'I follow the lantern.' };
const SECOND_EVENT = { ...ACTION_EVENT, id: 'event-3', turnId: SECOND_TURN.id, payload: { input: SECOND_TURN.input } };
const SECOND_COMMIT: TurnCommit = {
  expectedRevision: INITIAL_REVISION + 1,
  turn: SECOND_TURN,
  characters: [],
  scenes: [],
  events: [SECOND_EVENT, { ...NARRATION_EVENT, id: 'event-4', turnId: SECOND_TURN.id, causationId: SECOND_EVENT.id }],
};
const CRASH_DURING_COMMIT = `
import { createCampaignStore } from ${JSON.stringify(import.meta.resolve('./campaign-store.ts'))};
import { openDatabase } from ${JSON.stringify(import.meta.resolve('./database.ts'))};
const [path, json] = process.argv.slice(1);
const commit = JSON.parse(json);
const killed = { toJSON: () => process.kill(process.pid, ${JSON.stringify(KILL_SIGNAL)}) };
const events = [...commit.events.slice(0, -1), { ...commit.events.at(-1), payload: killed }];
createCampaignStore(openDatabase(path).database).commitTurn({ ...commit, events });
`;

const crashDuringCommit = (path: string, commit: TurnCommit) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', CRASH_DURING_COMMIT, '--', path, JSON.stringify(commit)]);

test('D08: interrupted writes remain atomic and a resume returns the last committed turn', async () => {
  await withTempPath((path) => {
    const writer = openStore(path);
    create(writer.store, CAMPAIGN);
    writer.store.commitTurn(COMMIT);
    writer.connection.close();

    assert.equal(crashDuringCommit(path, SECOND_COMMIT).signal, KILL_SIGNAL);

    const resumed = openStore(path);
    const state = resumed.store.load(CAMPAIGN.id);
    assert.deepEqual(state, EXPECTED_STATE);
    assert.deepEqual(state?.turns.at(-1), TURN);
    assert.deepEqual(resumed.store.commitTurn(SECOND_COMMIT), { turn: SECOND_TURN, events: SECOND_COMMIT.events });
    assert.equal(resumed.store.load(CAMPAIGN.id)?.revision, SECOND_COMMIT.expectedRevision + 1);
    resumed.connection.close();
  });
});

test('D08: replaying the same action after a restart does not double-commit', async () => {
  await withTempPath((path) => {
    const writer = openStore(path);
    create(writer.store, CAMPAIGN);
    writer.store.commitTurn(COMMIT);
    writer.connection.close();

    const restarted = openStore(path);
    const replay: TurnCommit = { ...COMMIT, turn: { ...TURN, id: 'turn-replay' }, events: [] };
    assert.deepEqual(restarted.store.commitTurn(COMMIT), COMMITTED_TURN);
    assert.deepEqual(restarted.store.commitTurn(replay), COMMITTED_TURN);
    assert.deepEqual(restarted.store.load(CAMPAIGN.id), EXPECTED_STATE);
    restarted.connection.close();
  });
});

test('D08: a backup copy opens read-only with the last committed state', async () => {
  await withTempPath(async (path) => {
    const writer = openStore(path);
    create(writer.store, CAMPAIGN);
    writer.store.commitTurn(COMMIT);
    const copy = `${path}.backup`;
    await backup(writer.connection.database, copy);
    writer.connection.close();

    const reader = openDatabase(copy, { readOnly: true });
    const store = createCampaignStore(reader.database);
    assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
    assert.throws(() => store.commitTurn(SECOND_COMMIT), READ_ONLY);
    assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
    reader.close();
  });
});

const SIDE_BRANCH = 'branch-what-if';
const LEGACY_TURN_EVENT = { ...NARRATION_EVENT, id: 'event-legacy', type: 'LegacyNote', payload: { note: 'v3' } };
const INSERT_UNBRANCHED_EVENT =
  'INSERT INTO event_log (id, campaign_id, turn_id, causation_id, type, payload) VALUES (?, ?, ?, ?, ?, ?)';

test('D08: campaign reads and action replays only see main-branch events', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn(COMMIT);
  createEventStore(connection.database).append(
    {
      ...REWARD_EVENT,
      id: 'event-side',
      branchId: SIDE_BRANCH,
      actorId: null,
      revision: INITIAL_REVISION + 1,
    },
    INITIAL_REVISION,
  );
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  assert.deepEqual(store.commitTurn(COMMIT), COMMITTED_TURN);

  const { id, campaignId, turnId, causationId, type, payload } = LEGACY_TURN_EVENT;
  connection.database
    .prepare(INSERT_UNBRANCHED_EVENT)
    .run(id, campaignId, turnId, causationId, type, JSON.stringify(payload));
  assert.deepEqual(store.load(CAMPAIGN.id)?.events, [...EXPECTED_STATE.events, LEGACY_TURN_EVENT]);
  connection.close();
});

test('record narration on a committed turn without changing revision or events', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn(COMMIT);
  const narration = 'The ferryman nods.';
  store.recordNarration(CAMPAIGN.id, TURN.id, narration);
  assert.deepEqual(store.load(CAMPAIGN.id), {
    ...EXPECTED_STATE,
    turns: [{ ...TURN, narration }],
  });
  assert.throws(() => store.recordNarration(MISSING_ID, TURN.id, narration), CampaignBoundaryError);
  assert.throws(() => store.recordNarration(CAMPAIGN.id, MISSING_ID, narration), CampaignBoundaryError);
  connection.close();
});

const GM_SEGMENTS = [
  { text: 'The ferryman nods.' },
  { speakerId: 'npc-ferryman', text: 'Aye.', delivery: { emotion: 'calm', intensity: 0.5, pace: 0.9 } },
];

test('rpg-cm63.49 record narration stores the GM segments on the turn and old turns have none', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn(COMMIT);
  assert.equal(store.load(CAMPAIGN.id)?.turns[0]?.segments, undefined);
  store.recordNarration(CAMPAIGN.id, TURN.id, 'The ferryman nods. Aye.', GM_SEGMENTS);
  assert.deepEqual(store.load(CAMPAIGN.id)?.turns[0]?.segments, GM_SEGMENTS);
  assert.deepEqual(store.findTurn(CAMPAIGN.id, TURN.actionId)?.turn.segments, GM_SEGMENTS);
  connection.close();
});

const CORRUPT_SEGMENTS = [
  'not json',
  '{"text":"x"}',
  '[{"speakerId":"a"}]',
  '[{"text":7}]',
  '[null]',
  '[{"text":"x","speakerId":3}]',
];

test('rpg-cm63.49 a corrupt or wrong-shape stored segments value reads as no segments', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn(COMMIT);
  for (const stored of CORRUPT_SEGMENTS) {
    connection.database.prepare('UPDATE turn SET segments = ? WHERE id = ?').run(stored, TURN.id);
    const turn = store.load(CAMPAIGN.id)?.turns[0];
    assert.equal(turn?.segments, undefined, stored);
    assert.equal(turn?.narration, TURN.narration);
  }
  connection.close();
});

const TAGGED_SCENE = { ...SCENE, locationKind: 'tavern', moodTags: ['tense', 'rain'] };
const LEGACY_SCENE_VERSION = 9;

test('rpg-cm63.41 a scene stores and returns its location kind and mood tags', () => {
  const { connection, store } = openStore(IN_MEMORY);
  create(store, CAMPAIGN);
  store.commitTurn({ ...COMMIT, scenes: [TAGGED_SCENE] });
  assert.deepEqual(store.load(CAMPAIGN.id)?.currentScene, TAGGED_SCENE);
  connection.close();
});

test('rpg-cm63.41 a scene stored before the tags existed loads without them', async () => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(dir, DATABASE_FILE);
    const legacy = openDatabase(path, { migrations: MIGRATIONS.slice(0, LEGACY_SCENE_VERSION) });
    const { database } = legacy;
    database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN.id, CAMPAIGN.name);
    database
      .prepare('INSERT INTO scene (id, campaign_id, title) VALUES (?, ?, ?)')
      .run(SCENE.id, CAMPAIGN.id, SCENE.title);
    database.prepare('UPDATE campaign SET current_scene_id = ? WHERE id = ?').run(SCENE.id, CAMPAIGN.id);
    legacy.close();
    const { connection, store } = openStore(path);
    assert.deepEqual(store.load(CAMPAIGN.id)?.currentScene, SCENE);
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
