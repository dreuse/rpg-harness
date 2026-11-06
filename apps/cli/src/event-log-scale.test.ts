import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import {
  ACTION_VALIDATED,
  CAMPAIGN_CREATED,
  CHECK_RESOLVED,
  MAIN_BRANCH,
  PLAYER_ACTION_SUBMITTED,
} from '../../../packages/domain/src/campaign.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { RECENT_TURN_WINDOW } from '../../../packages/timelines/src/live.ts';
import { exportArchive, restoreArchive } from './campaign-archive.ts';
import { createClientSessions, scopedEventsOf, worldOf } from './client-session.ts';

const TEMP_PREFIX = 'rpg-event-log-scale-';
const CAMPAIGN_ID = 'scale-campaign';
const SCENE_ID = 'scale-scene';
const HERO_ID = 'scale-hero';
const HIGH_VOLUME_TYPES = [PLAYER_ACTION_SUBMITTED, ACTION_VALIDATED, CHECK_RESOLVED];
const EVERY_TURN = 1;
const SPARSE_RETENTION = 20;
const RETAINED_TYPE = 'OpaqueRetained';
const QUEST_ID = 'scale-quest';
const CLOCK_ID = 'scale-clock';
const CLOCK_SEGMENTS = 1_000_000;
const FOLD_EVENTS = [
  ['QuestActivated', { questId: QUEST_ID }],
  ['ClockTicked', { clockId: CLOCK_ID, current: 1 }],
] as const;
const FOLD_SETUP = [
  ['QuestDefined', { questId: QUEST_ID, title: 'Scale', objectives: [], prerequisites: [] }],
  ['ClockDefined', { clockId: CLOCK_ID, label: 'Scale', segments: CLOCK_SEGMENTS }],
] as const;
const LARGE_EVENTS = 100_000;
const SMALL_EVENTS = 1_000;
const MEASURED_ACTIONS = 30;
const GROWTH_FACTOR = 10;
const NOISE_FLOOR_MS = 100;
const MIDDLE = 2;

const INSERT_TURN =
  'INSERT INTO turn (id, campaign_id, scene_id, action_id, actor_id, input, narration, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, revision, action_id, turn_id, causation_id, type, payload, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

type Retained = readonly (readonly [string, Record<string, unknown>])[];

const OPAQUE_RETAINED: Retained = [[RETAINED_TYPE, {}]];

const seedLog = (
  database: DatabaseSync,
  events: number,
  retainedEvery: number,
  retained: (turn: number) => Retained = () => OPAQUE_RETAINED,
) => {
  database.exec('BEGIN');
  database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, 'Scale');
  database.prepare('INSERT INTO character (id, campaign_id, name) VALUES (?, ?, ?)').run(HERO_ID, CAMPAIGN_ID, 'Hero');
  database.prepare('INSERT INTO scene (id, campaign_id, title) VALUES (?, ?, ?)').run(SCENE_ID, CAMPAIGN_ID, 'Road');
  const addEvent = database.prepare(INSERT_EVENT);
  const addTurn = database.prepare(INSERT_TURN);
  addEvent.run(
    'created',
    CAMPAIGN_ID,
    MAIN_BRANCH,
    0,
    'create',
    null,
    null,
    CAMPAIGN_CREATED,
    '{"name":"Scale"}',
    'gm',
  );
  let turns = 0;
  for (let written = 1; written < events; ) {
    turns += 1;
    const turnId = `turn-${turns}`;
    addTurn.run(turnId, CAMPAIGN_ID, SCENE_ID, `seed-${turns}`, HERO_ID, `step ${turns}`, 'ok', turns);
    const kept = turns % retainedEvery === 0 ? retained(turns) : [];
    const rows: Retained = [...HIGH_VOLUME_TYPES.map((type) => [type, {}] as const), ...kept];
    for (const [index, [type, payload]] of rows.entries()) {
      addEvent.run(
        `${turnId}-${index}`,
        CAMPAIGN_ID,
        MAIN_BRANCH,
        turns,
        `seed-${turns}`,
        turnId,
        null,
        type,
        JSON.stringify(payload),
        'gm',
      );
      written += 1;
    }
  }
  database
    .prepare('UPDATE campaign SET revision = ?, current_scene_id = ? WHERE id = ?')
    .run(turns, SCENE_ID, CAMPAIGN_ID);
  database.exec('COMMIT');
};

const timed = <T>(run: () => T) => {
  const started = performance.now();
  const result = run();
  return { result, ms: performance.now() - started };
};

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / MIDDLE)] ?? 0;

const openSession = (path: string) => {
  const connection = openDatabase(path);
  const { database } = connection;
  const engine = createEngine(createCampaignStore(database));
  const sessionFor = createClientSessions(engine, CAMPAIGN_ID, scopedEventsOf(database), worldOf(database));
  return { connection, engine, session: sessionFor(PLAYER_VIEWER) };
};

const envelope = { version: PROTOCOL_VERSION, campaignId: CAMPAIGN_ID } as const;

const actionCycle = ({ engine, session }: ReturnType<typeof openSession>, index: number) =>
  timed(() => {
    const { revision } = engine.getState(CAMPAIGN_ID);
    const accepted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: `live-${index}`,
      expectedRevision: revision,
      sceneId: SCENE_ID,
      actorId: HERO_ID,
      input: `live step ${index}`,
    });
    assert.ok(accepted.ok);
    assert.ok(session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' }).ok);
    assert.ok(session.getPanels({ ...envelope, type: 'GetCampaignPanels' }).ok);
  }).ms;

const perActionMs = (path: string) => {
  const opened = openSession(path);
  try {
    return median(Array.from({ length: MEASURED_ACTIONS }, (_, index) => actionCycle(opened, index)));
  } finally {
    opened.connection.close();
  }
};

const inTempDir = async (run: (dir: string) => Promise<void> | void) => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const seeded = (
  dir: string,
  name: string,
  events: number,
  retainedEvery = SPARSE_RETENTION,
  retained?: (turn: number) => Retained,
) => {
  const path = join(dir, name);
  const connection = openDatabase(path);
  seedLog(connection.database, events, retainedEvery, retained);
  connection.close();
  return path;
};

test('rpg-42a.41: a 100k-event campaign with retained events opens fast and acts fast', () =>
  inTempDir((dir) => {
    const large = seeded(dir, 'dense.sqlite', LARGE_EVENTS, EVERY_TURN);

    openSession(large).connection.close();

    const warm = openSession(large);
    const state = warm.engine.getState(CAMPAIGN_ID);
    assert.ok(state.turns.length <= RECENT_TURN_WINDOW);
    const submitted = state.events.filter(({ type }) => type === PLAYER_ACTION_SUBMITTED);
    assert.ok(submitted.length <= RECENT_TURN_WINDOW);
    assert.ok(state.events.some(({ type }) => type === RETAINED_TYPE));
    const total = warm.connection.database.prepare('SELECT COUNT(*) AS total FROM event_log').get()?.total;
    assert.ok(Number(total) > LARGE_EVENTS);
    warm.connection.close();
  }));

test('rpg-42a.41: per-action time stays within a bounded factor as the log grows', () =>
  inTempDir((dir) => {
    const smallMs = perActionMs(seeded(dir, 'small.sqlite', SMALL_EVENTS));
    const largeMs = perActionMs(seeded(dir, 'large.sqlite', LARGE_EVENTS));
    assert.ok(largeMs <= Math.max(smallMs * GROWTH_FACTOR, NOISE_FLOOR_MS), `${smallMs}ms grew to ${largeMs}ms`);
  }));

const foldRetained = (turn: number): Retained => (turn === EVERY_TURN ? [...FOLD_SETUP, ...FOLD_EVENTS] : FOLD_EVENTS);

test('rpg-42a.57: smoke test, a 100k-event log with quest and clock events projects the quest and clock values', () =>
  inTempDir((dir) => {
    const smallMs = perActionMs(seeded(dir, 'folds-small.sqlite', SMALL_EVENTS, EVERY_TURN, foldRetained));
    const largePath = seeded(dir, 'folds-large.sqlite', LARGE_EVENTS, EVERY_TURN, foldRetained);
    const largeMs = perActionMs(largePath);
    assert.ok(largeMs <= Math.max(smallMs * GROWTH_FACTOR, NOISE_FLOOR_MS), `${smallMs}ms grew to ${largeMs}ms`);
    const opened = openSession(largePath);
    const { folds, events } = opened.engine.getState(CAMPAIGN_ID);
    const pruned = new Set<string>([...FOLD_SETUP, ...FOLD_EVENTS].map(([type]) => type));
    assert.equal(
      events.some(({ type }) => pruned.has(type)),
      false,
    );
    assert.equal(folds.gm.quests[0]?.status, 'active');
    assert.equal(folds.world.clocks[0]?.current, 1);
    opened.connection.close();
  }));

const COUNT_EVENTS = 'SELECT COUNT(*) AS total FROM event_log';
const COUNT_SNAPSHOTS = 'SELECT COUNT(*) AS total FROM campaign_snapshot';
const ARCHIVE_FILE = 'archive.json';
const RESTORED_DIR = 'restored';
const RESTORED_FILE = 'restored.sqlite';

const countOf = (path: string, sql: string) => {
  const connection = openDatabase(path);
  try {
    return Number(connection.database.prepare(sql).get()?.total);
  } finally {
    connection.close();
  }
};

test('rpg-42a.41: snapshots never replace history, so export and restore keep the full log', () =>
  inTempDir(async (dir) => {
    const path = seeded(dir, 'campaign.sqlite', SMALL_EVENTS);
    perActionMs(path);
    assert.ok(countOf(path, COUNT_SNAPSHOTS) > 0);
    const events = countOf(path, COUNT_EVENTS);
    assert.ok(events > SMALL_EVENTS);

    const archiveFile = join(dir, ARCHIVE_FILE);
    exportArchive(path, archiveFile);
    const restoredDir = join(dir, RESTORED_DIR);
    await mkdir(restoredDir);
    restoreArchive(archiveFile, restoredDir, () => join(restoredDir, RESTORED_FILE));
    const restored = join(restoredDir, RESTORED_FILE);
    assert.equal(countOf(restored, COUNT_EVENTS), events);

    const original = openSession(path);
    const copy = openSession(restored);
    assert.deepEqual(copy.engine.getState(CAMPAIGN_ID), original.engine.getState(CAMPAIGN_ID));
    original.connection.close();
    copy.connection.close();
  }));
