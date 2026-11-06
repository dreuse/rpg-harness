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
  type TurnVisibility,
} from '../../domain/src/campaign.ts';
import { GM_USAGE_RECORDED } from '../../domain/src/gm.ts';
import { LIVE_PROJECTION_VERSION, RECENT_TURN_WINDOW } from '../../timelines/src/live.ts';
import { audienceOf, visibleFoldsOf, worldOf } from '../../timelines/src/live-folds.ts';
import { createCampaignStore } from './campaign-store.ts';
import { openDatabase } from './database.ts';
import { listScopedEvents } from './event-store.ts';

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

test('P57: a snapshot with malformed folds is skipped and the open replays the log', () => {
  const { database, store } = setup();
  for (let index = 1; index <= SNAPSHOT_EVERY; index++) play(store, index);
  const expected = store.load(CAMPAIGN.id);
  const stored = JSON.parse(String(database.prepare('SELECT state FROM campaign_snapshot LIMIT 1').get()?.state));
  const malformed = [null, {}, { ...stored.folds, world: {} }, { ...stored.folds, gm: {} }];
  for (const folds of malformed) {
    database.prepare('UPDATE campaign_snapshot SET state = ?').run(JSON.stringify({ ...stored, folds }));
    assert.deepEqual(createCampaignStore(database).load(CAMPAIGN.id), expected);
  }
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

const RIVAL = 'rival';
const OBJECTIVES = [{ id: 'first', summary: 'Begin' }];
const FOLD_STEPS: readonly (readonly [string, Record<string, unknown>, TurnVisibility])[] = [
  ['QuestDefined', { questId: 'ferry', title: 'Ferry', objectives: OBJECTIVES, prerequisites: [] }, 'player'],
  ['QuestDefined', { questId: 'plot', title: 'Plot', objectives: OBJECTIVES, prerequisites: [] }, 'gm'],
  ['QuestActivated', { questId: 'ferry' }, 'public'],
  ['EncounterStarted', { encounterId: 'duel', participants: [CHARACTER.id], sheets: [] }, 'public'],
  ['EncounterResolved', { encounterId: 'duel', outcome: 'won' }, 'gm'],
  ['ClockDefined', { clockId: 'alarm', label: 'Alarm', segments: 3 }, 'gm'],
  ['ClockTicked', { clockId: 'alarm', current: 1 }, 'gm'],
];
const SCOPES = [{ scope: 'gm' }, { scope: 'player' }, { scope: 'actor', actorId: RIVAL }] as const;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('P57: projected folds equal a full fold over the stored events, also after a snapshot resume', () => {
  const { database, store } = setup(EVENTS_PER_TURN);
  FOLD_STEPS.forEach(([type, payload, visibility], offset) => {
    const index = offset + FIRST_TURN;
    const turnId = `fold-turn-${index}`;
    const id = `fold-${index}`;
    store.commitTurn({
      expectedRevision: offset,
      turn: {
        id: turnId,
        campaignId: CAMPAIGN.id,
        sceneId: SCENE.id,
        actionId: id,
        actorId: CHARACTER.id,
        input: id,
        narration: '',
      },
      characters: index === FIRST_TURN ? [CHARACTER] : [],
      scenes: index === FIRST_TURN ? [SCENE] : [],
      events: [{ id, campaignId: CAMPAIGN.id, turnId, causationId: null, type, payload }],
      visibility: { [id]: visibility },
    });
  });
  assert.ok(snapshots(database).length >= 1);
  const stored = listScopedEvents(database, CAMPAIGN.id).filter(({ turnId }) => turnId !== null);
  const readable = (scope: (typeof SCOPES)[number], visibility: string) =>
    scope.scope === 'gm' || visibility === 'public' || (scope.scope === 'player' && visibility === 'player');
  const resumed = createCampaignStore(database).load(CAMPAIGN.id);
  for (const state of [store.load(CAMPAIGN.id), resumed]) {
    for (const scope of SCOPES) {
      const visible = stored.filter(({ visibility }) => readable(scope, visibility));
      const events = visible.map(({ id, campaignId, turnId, causationId, type, payload }) => ({
        id,
        campaignId,
        turnId: String(turnId),
        causationId,
        type,
        payload,
      }));
      assert.deepEqual(plain(audienceOf(state?.folds as never, scope)), plain(visibleFoldsOf(events)));
    }
    const all = stored.map(({ id, campaignId, turnId, causationId, type, payload }) => ({
      id,
      campaignId,
      turnId: String(turnId),
      causationId,
      type,
      payload,
    }));
    assert.deepEqual(plain(state?.folds.world), plain(worldOf(all)));
  }
  assert.equal(resumed?.folds.world.clocks[0]?.current, 1);
});
