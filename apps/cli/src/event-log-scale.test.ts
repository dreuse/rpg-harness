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
const RETAINED_TYPE = 'EncounterActionResolved';
const LARGE_EVENTS = 100_000;
const SMALL_EVENTS = 1_000;
const MEASURED_ACTIONS = 30;
const OPEN_LIMIT_MS = 1_000;
const COLD_REPLAY_LIMIT_MS = 5_000;
const ACTION_LIMIT_MS = 100;
const GROWTH_FACTOR = 3;
const NOISE_FLOOR_MS = 5;
const MIDDLE = 2;

const INSERT_TURN =
  'INSERT INTO turn (id, campaign_id, scene_id, action_id, actor_id, input, narration, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const INSERT_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, revision, action_id, turn_id, causation_id, type, payload, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

const seedLog = (database: DatabaseSync, events: number, retainedEvery: number) => {
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
    const types = turns % retainedEvery === 0 ? [...HIGH_VOLUME_TYPES, RETAINED_TYPE] : HIGH_VOLUME_TYPES;
    for (const [index, type] of types.entries()) {
      addEvent.run(
        `${turnId}-${index}`,
        CAMPAIGN_ID,
        MAIN_BRANCH,
        turns,
        `seed-${turns}`,
        turnId,
        null,
        type,
        '{}',
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

const seeded = (dir: string, name: string, events: number, retainedEvery = SPARSE_RETENTION) => {
  const path = join(dir, name);
  const connection = openDatabase(path);
  seedLog(connection.database, events, retainedEvery);
  connection.close();
  return path;
};

test('rpg-42a.41: a 100k-event campaign with retained events opens fast and acts fast', () =>
  inTempDir((dir) => {
    const large = seeded(dir, 'dense.sqlite', LARGE_EVENTS, EVERY_TURN);

    const cold = timed(() => openSession(large));
    assert.ok(cold.ms < COLD_REPLAY_LIMIT_MS, `cold replay took ${cold.ms}ms`);
    assert.ok(actionCycle(cold.result, 0) < OPEN_LIMIT_MS);
    cold.result.connection.close();

    const warm = timed(() => openSession(large));
    const state = warm.result.engine.getState(CAMPAIGN_ID);
    assert.ok(warm.ms < OPEN_LIMIT_MS, `open took ${warm.ms}ms`);
    assert.ok(warm.ms < cold.ms);
    assert.ok(state.turns.length <= RECENT_TURN_WINDOW);
    const submitted = state.events.filter(({ type }) => type === PLAYER_ACTION_SUBMITTED);
    assert.ok(submitted.length <= RECENT_TURN_WINDOW);
    assert.ok(state.events.some(({ type }) => type === RETAINED_TYPE));
    const total = warm.result.connection.database.prepare('SELECT COUNT(*) AS total FROM event_log').get()?.total;
    assert.ok(Number(total) > LARGE_EVENTS);
    warm.result.connection.close();

    const largeMs = perActionMs(large);
    assert.ok(largeMs < ACTION_LIMIT_MS, `action took ${largeMs}ms`);
  }));

test('rpg-42a.41: per-action time does not grow with the size of the log', () =>
  inTempDir((dir) => {
    const smallMs = perActionMs(seeded(dir, 'small.sqlite', SMALL_EVENTS));
    const largeMs = perActionMs(seeded(dir, 'large.sqlite', LARGE_EVENTS));
    assert.ok(largeMs < ACTION_LIMIT_MS, `action took ${largeMs}ms`);
    assert.ok(largeMs <= Math.max(smallMs * GROWTH_FACTOR, NOISE_FLOOR_MS), `${smallMs}ms grew to ${largeMs}ms`);
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
