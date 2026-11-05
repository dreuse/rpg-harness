import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { openDatabase } from './database.ts';
import { createEventStore, type DomainEvent, listScopedEvents } from './event-store.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN_A = 'campaign-a';
const CAMPAIGN_B = 'campaign-b';
const SIDE_BRANCH = 'branch-what-if';
const ACTOR_ID = 'npc-1';
const TURN_ID = 'turn-1';
const APPEND_ONLY = /event_log is append-only/;
const EMPTY_BRANCH = 0;
const FIRST: DomainEvent = {
  id: 'event-1',
  campaignId: CAMPAIGN_A,
  branchId: MAIN_BRANCH,
  turnId: TURN_ID,
  actorId: ACTOR_ID,
  revision: 1,
  causationId: null,
  type: 'DoorOpened',
  payload: { door: 'north' },
};
const SECOND: DomainEvent = { ...FIRST, id: 'event-2', causationId: FIRST.id, type: 'AlarmRaised', payload: {} };
const THIRD: DomainEvent = { ...FIRST, id: 'event-3', revision: 2, actorId: null, turnId: null, type: 'TimePassed' };
const BRANCHED: DomainEvent = { ...FIRST, id: 'event-branch', branchId: SIDE_BRANCH };
const OTHER_CAMPAIGN: DomainEvent = { ...THIRD, id: 'event-b', campaignId: CAMPAIGN_B };

const openStore = () => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  const insertCampaign = database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)');
  insertCampaign.run(CAMPAIGN_A, CAMPAIGN_A);
  insertCampaign.run(CAMPAIGN_B, CAMPAIGN_B);
  database
    .prepare('INSERT INTO entity (id, campaign_id, kind, name, visibility) VALUES (?, ?, ?, ?, ?)')
    .run(ACTOR_ID, CAMPAIGN_A, 'npc', ACTOR_ID, 'public');
  database
    .prepare('INSERT INTO character (id, campaign_id, name) VALUES (?, ?, ?)')
    .run(ACTOR_ID, CAMPAIGN_A, ACTOR_ID);
  database.prepare('INSERT INTO scene (id, campaign_id, title) VALUES (?, ?, ?)').run('scene-1', CAMPAIGN_A, 'Docks');
  database
    .prepare(
      'INSERT INTO turn (id, campaign_id, scene_id, action_id, actor_id, input, narration, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(TURN_ID, CAMPAIGN_A, 'scene-1', 'action-1', ACTOR_ID, 'open door', 'it creaks', FIRST.revision);
  return { connection, store: createEventStore(database) };
};

test('persist ordered immutable domain events with campaign, timeline, actor and logical time', () => {
  const { connection, store } = openStore();
  store.append(FIRST, EMPTY_BRANCH);
  store.append(SECOND, FIRST.revision);
  store.append(BRANCHED, EMPTY_BRANCH);
  store.append(OTHER_CAMPAIGN, EMPTY_BRANCH);
  store.append(THIRD, SECOND.revision);

  assert.deepEqual(store.list(CAMPAIGN_A, MAIN_BRANCH), [FIRST, SECOND, THIRD]);
  assert.deepEqual(store.list(CAMPAIGN_A, SIDE_BRANCH), [BRANCHED]);
  assert.deepEqual(store.list(CAMPAIGN_B, MAIN_BRANCH), [OTHER_CAMPAIGN]);
  connection.close();
});

test('historical event writes cannot be silently overwritten', () => {
  const { connection, store } = openStore();
  store.append(FIRST, EMPTY_BRANCH);
  const { database } = connection;

  assert.throws(() => store.append({ ...FIRST, type: 'Rewritten' }, FIRST.revision), APPEND_ONLY);
  assert.throws(
    () => database.prepare('UPDATE event_log SET type = ? WHERE id = ?').run('Rewritten', FIRST.id),
    APPEND_ONLY,
  );
  assert.throws(() => database.prepare('DELETE FROM event_log WHERE id = ?').run(FIRST.id), APPEND_ONLY);
  assert.throws(
    () =>
      database
        .prepare('INSERT OR REPLACE INTO event_log (id, campaign_id, payload) VALUES (?, ?, ?)')
        .run(FIRST.id, CAMPAIGN_A, '{}'),
    APPEND_ONLY,
  );
  assert.deepEqual(store.list(CAMPAIGN_A, MAIN_BRANCH), [FIRST]);
  connection.close();
});

test('P41: scoped events are read incrementally by sequence, revision, type, id and tail', () => {
  const { connection, store } = openStore();
  store.append(FIRST, EMPTY_BRANCH);
  store.append(SECOND, FIRST.revision);
  store.append(BRANCHED, EMPTY_BRANCH);
  store.append(THIRD, SECOND.revision);
  const { database } = connection;
  const idsOf = (query = {}) => listScopedEvents(database, CAMPAIGN_A, query).map(({ id }) => id);
  const everything = listScopedEvents(database, CAMPAIGN_A);
  assert.deepEqual(idsOf(), [FIRST.id, SECOND.id, THIRD.id]);
  assert.ok(everything.every(({ visibility }) => visibility === 'gm'));
  const [first, second] = everything;
  assert.deepEqual(idsOf({ afterSeq: first?.seq }), [SECOND.id, THIRD.id]);
  assert.deepEqual(idsOf({ afterSeq: second?.seq, beforeSeq: everything[2]?.seq }), []);
  assert.deepEqual(idsOf({ afterRevision: FIRST.revision }), [THIRD.id]);
  assert.deepEqual(idsOf({ type: SECOND.type }), [SECOND.id]);
  assert.deepEqual(idsOf({ ids: [THIRD.id, FIRST.id] }), [FIRST.id, THIRD.id]);
  assert.deepEqual(idsOf({ tail: 2 }), [SECOND.id, THIRD.id]);
  connection.close();
});
