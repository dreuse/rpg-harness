import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTION_VALIDATED,
  type CampaignChange,
  type CampaignStore,
  MAIN_BRANCH,
  PLAYER_ACTION_SUBMITTED,
  SCENE_OPENED,
  type Turn,
} from '../../domain/src/campaign.ts';
import { GM_USAGE_RECORDED } from '../../domain/src/gm.ts';
import { LIVE_PROJECTION_VERSION, RECENT_TURN_WINDOW } from '../../timelines/src/live.ts';
import { createCampaignStore } from './campaign-store.ts';
import { openDatabase } from './database.ts';

const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CHARACTER = { id: 'character-1', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const SNAPSHOT_EVERY = 6;
const EVENTS_PER_TURN = 2;
const FIRST_TURN = 1;
const MARKER = 'from-the-snapshot';
const SESSION = 'session-1';
const USAGE = { model: 'haiku', inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 };
const SELECT_SNAPSHOTS = 'SELECT event_count, last_event_id, version FROM campaign_snapshot ORDER BY event_count';
const COUNT_EVENTS = 'SELECT COUNT(*) AS total FROM event_log';

const create = (store: CampaignStore) =>
  store.createCampaign(CAMPAIGN, {
    id: 'created',
    campaignId: CAMPAIGN.id,
    branchId: MAIN_BRANCH,
    actionId: 'create',
    type: 'CampaignCreated',
    payload: { name: CAMPAIGN.name },
  });

const play = (store: CampaignStore, index: number) => {
  const turn: Turn = {
    id: `turn-${index}`,
    campaignId: CAMPAIGN.id,
    sceneId: SCENE.id,
    actionId: `action-${index}`,
    actorId: CHARACTER.id,
    input: `step ${index}`,
    narration: '',
  };
  const submitted = {
    id: `submitted-${index}`,
    campaignId: CAMPAIGN.id,
    turnId: turn.id,
    causationId: null,
    type: PLAYER_ACTION_SUBMITTED,
    payload: { input: turn.input },
  };
  const validated = { ...submitted, id: `validated-${index}`, causationId: submitted.id, type: ACTION_VALIDATED };
  store.commitTurn({
    expectedRevision: index - FIRST_TURN,
    turn,
    characters: index === FIRST_TURN ? [CHARACTER] : [],
    scenes: index === FIRST_TURN ? [SCENE] : [],
    events: [submitted, validated],
  });
};

const setup = (snapshotEvery = SNAPSHOT_EVERY) => {
  const { database } = openDatabase(':memory:');
  const store = createCampaignStore(database, { snapshotEvery });
  create(store);
  return { database, store };
};

const snapshots = (database: ReturnType<typeof setup>['database']) => database.prepare(SELECT_SNAPSHOTS).all();

test('P41: a snapshot is written every N events and a fresh store resumes from it', () => {
  const { database, store } = setup();
  for (let index = 1; index <= SNAPSHOT_EVERY; index++) play(store, index);
  const written = snapshots(database);
  assert.ok(written.length >= 1);
  assert.ok(Number(written[0]?.event_count) >= SNAPSHOT_EVERY);
  assert.equal(Number(written.at(-1)?.version), LIVE_PROJECTION_VERSION);
  const expected = store.load(CAMPAIGN.id);
  assert.deepEqual(createCampaignStore(database, { snapshotEvery: SNAPSHOT_EVERY }).load(CAMPAIGN.id), expected);
});

test('P41: opening uses the newest valid snapshot and replays only newer events', () => {
  const { database, store } = setup();
  for (let index = 1; index <= SNAPSHOT_EVERY; index++) play(store, index);
  const stored = database.prepare('SELECT state FROM campaign_snapshot ORDER BY event_count DESC').get();
  const state = JSON.parse(String(stored?.state));
  const marked = { ...state, changes: { ...state.changes, Marker: { type: 'Marker', payload: { MARKER } } } };
  database.prepare('UPDATE campaign_snapshot SET state = ?').run(JSON.stringify(marked));
  play(store, SNAPSHOT_EVERY + 1);
  const reopened = createCampaignStore(database).load(CAMPAIGN.id);
  assert.ok(reopened?.changes.some(({ type }) => type === 'Marker'));
  assert.equal(reopened?.events.at(-1)?.id, `validated-${SNAPSHOT_EVERY + 1}`);
});

test('P41: stale or mismatched snapshots fall back to a full replay', () => {
  const { database, store } = setup();
  for (let index = 1; index <= SNAPSHOT_EVERY; index++) play(store, index);
  const expected = store.load(CAMPAIGN.id);
  const poisoned = JSON.stringify({ count: 1, events: [], changes: { Marker: { type: 'Marker', payload: {} } } });
  database.prepare('UPDATE campaign_snapshot SET state = ?').run(poisoned);
  database.prepare('UPDATE campaign_snapshot SET version = version + 1').run();
  assert.deepEqual(createCampaignStore(database).load(CAMPAIGN.id), expected);
  database.prepare('UPDATE campaign_snapshot SET version = ?').run(LIVE_PROJECTION_VERSION);
  database.prepare('UPDATE campaign_snapshot SET last_event_id = ?').run('forged');
  assert.deepEqual(createCampaignStore(database).load(CAMPAIGN.id), expected);
  database.prepare('UPDATE campaign_snapshot SET last_event_id = (SELECT id FROM event_log WHERE seq = 2)').run();
  assert.deepEqual(createCampaignStore(database).load(CAMPAIGN.id), expected);
});

test('P41: an unreadable snapshot state falls back to a full replay', () => {
  const { database, store } = setup();
  for (let index = 1; index <= SNAPSHOT_EVERY; index++) play(store, index);
  const expected = store.load(CAMPAIGN.id);
  for (const state of ['not json', '{}']) {
    database.prepare('UPDATE campaign_snapshot SET state = ?').run(state);
    assert.deepEqual(createCampaignStore(database).load(CAMPAIGN.id), expected);
  }
});

test('P41: opening a scene writes a snapshot even before the next N events', () => {
  const { database, store } = setup(SNAPSHOT_EVERY * SNAPSHOT_EVERY);
  assert.equal(snapshots(database).length, 0);
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'opening',
      campaignId: CAMPAIGN.id,
      sceneId: SCENE.id,
      actionId: 'opening',
      actorId: CHARACTER.id,
      input: 'Begin.',
      narration: 'Hi',
    },
    characters: [CHARACTER],
    scenes: [SCENE],
    events: [
      {
        id: 'scene-opened',
        campaignId: CAMPAIGN.id,
        turnId: 'opening',
        causationId: null,
        type: SCENE_OPENED,
        payload: {},
      },
    ],
  });
  assert.equal(snapshots(database).length, 1);
});

test('P41: loaded state keeps a bounded window while the log keeps every event', () => {
  const { database, store } = setup(RECENT_TURN_WINDOW);
  const turns = RECENT_TURN_WINDOW * EVENTS_PER_TURN;
  for (let index = 1; index <= turns; index++) play(store, index);
  const state = store.load(CAMPAIGN.id);
  assert.equal(state?.events.length, RECENT_TURN_WINDOW * EVENTS_PER_TURN);
  assert.equal(state?.turns.length, RECENT_TURN_WINDOW);
  assert.equal(state?.turns.at(-1)?.id, `turn-${turns}`);
  assert.equal(state?.revision, turns);
  assert.equal(Number(database.prepare(COUNT_EVENTS).get()?.total), turns * EVENTS_PER_TURN + 1);
});

test('P41: GM usage and settings come from projections, not from retained events', () => {
  const { store } = setup();
  const change = (id: string, type: string, payload: CampaignChange['payload']): CampaignChange => ({
    id,
    campaignId: CAMPAIGN.id,
    branchId: MAIN_BRANCH,
    actionId: id,
    type,
    payload,
  });
  store.recordUsage(change('usage-1', GM_USAGE_RECORDED, { sessionId: SESSION, usage: USAGE }));
  store.recordUsage(change('usage-2', GM_USAGE_RECORDED, { sessionId: SESSION, usage: USAGE }));
  const state = store.load(CAMPAIGN.id);
  assert.equal(state?.gmUsage.campaign.turns, EVENTS_PER_TURN);
  assert.equal(state?.gmUsage.sessions[SESSION]?.outputTokens, USAGE.outputTokens * EVENTS_PER_TURN);
  assert.ok(state?.changes.some(({ type }) => type === 'CampaignCreated'));
});

test('P41: a second connection sees new events through the incremental read', () => {
  const { database, store } = setup();
  const reader = createCampaignStore(database);
  assert.equal(reader.load(CAMPAIGN.id)?.events.length, 0);
  play(store, FIRST_TURN);
  assert.equal(reader.load(CAMPAIGN.id)?.events.length, EVENTS_PER_TURN);
});

test('P41: a failed snapshot write never fails the commit that triggered it', () => {
  const { database, store } = setup();
  play(store, FIRST_TURN);
  database.exec('DROP TABLE campaign_snapshot');
  for (let index = FIRST_TURN + 1; index <= SNAPSHOT_EVERY; index++) play(store, index);
  assert.equal(store.load(CAMPAIGN.id)?.revision, SNAPSHOT_EVERY);
});
