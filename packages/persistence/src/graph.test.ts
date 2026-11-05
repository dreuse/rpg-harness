import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignEntity } from '../../domain/src/entity.ts';
import { openDatabase } from './database.ts';
import { createEntityStore } from './entity-store.ts';
import { touchesOf, walkGraph } from './graph.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = 'campaign-a';
const OTHER = 'campaign-b';
const CONTAINS = 'contains';
const MAX_HOPS = 2;
const INSERT_CAMPAIGN = 'INSERT INTO campaign (id, name) VALUES (?, ?)';
const INSERT_EVENT =
  "INSERT INTO event_log (id, campaign_id, branch_id, type, payload, visibility) VALUES (?, ?, 'main', ?, ?, ?)";

const entity = (id: string, campaignId = CAMPAIGN): CampaignEntity => ({
  id,
  campaignId,
  kind: 'npc',
  name: id,
  data: {},
  visibility: 'public',
  actorId: null,
});

const IDS = ['world', 'region', 'city', 'room', 'cellar', 'mira', 'bram', 'smith', 'far', 'spy', 'hidden-friend'];

const seeded = () => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  database.prepare(INSERT_CAMPAIGN).run(CAMPAIGN, CAMPAIGN);
  database.prepare(INSERT_CAMPAIGN).run(OTHER, OTHER);
  const store = createEntityStore(database);
  for (const id of IDS) store.saveEntity(entity(id));
  store.saveEntity(entity('outsider', OTHER));
  const link = (id: string, kind: string, sourceId: string, targetId: string) =>
    store.saveRelationship({ id, campaignId: CAMPAIGN, kind, sourceId, targetId, data: {} });
  link('c1', CONTAINS, 'world', 'region');
  link('c2', CONTAINS, 'region', 'city');
  link('c3', CONTAINS, 'city', 'room');
  link('c4', CONTAINS, 'room', 'cellar');
  link('c5', CONTAINS, 'room', 'mira');
  link('r1', 'friend', 'mira', 'bram');
  link('r2', 'apprentice', 'bram', 'smith');
  link('r3', 'cousin', 'smith', 'far');
  link('r4', 'handler', 'spy', 'mira');
  link('r5', 'friend', 'spy', 'hidden-friend');
  return connection;
};

const VISIBLE = IDS.filter((id) => id !== 'spy');

test('rpg-42a.36 a bounded recursive walk over visible nodes, containment parents and one level of children', () => {
  const connection = seeded();
  const nodes = walkGraph(connection.database, {
    campaignId: CAMPAIGN,
    startIds: ['room', 'mira'],
    visibleIds: [...VISIBLE, 'promise-1'],
    links: [['promise-1', 'mira']],
    maxHops: MAX_HOPS,
  });
  const byRole = (role: string) =>
    nodes.filter((node) => node.role === role).map(({ id, hops }) => [id, hops] as const);
  assert.deepEqual(byRole('link'), [
    ['mira', 0],
    ['room', 0],
    ['bram', 1],
    ['promise-1', 1],
    ['smith', 2],
  ]);
  assert.deepEqual(byRole('parent'), [
    ['city', 1],
    ['room', 1],
    ['region', 2],
    ['world', 3],
  ]);
  assert.deepEqual(byRole('child'), [
    ['cellar', 1],
    ['mira', 1],
  ]);
  assert.ok(!nodes.some(({ id }) => ['spy', 'hidden-friend', 'far', 'outsider'].includes(id)));
  connection.close();
});

test('rpg-42a.36 committed events link to the entities they touched, with their visibility', () => {
  const connection = seeded();
  const insert = connection.database.prepare(INSERT_EVENT);
  insert.run('e1', CAMPAIGN, 'NpcMet', JSON.stringify({ npcId: 'mira', with: ['bram'] }), 'player');
  insert.run('e2', CAMPAIGN, 'Plot', JSON.stringify({ deep: { target: 'spy' }, note: 'mira' }), 'gm');
  insert.run('e3', OTHER, 'NpcMet', JSON.stringify({ npcId: 'outsider' }), 'player');
  const touches = touchesOf(connection.database, CAMPAIGN).map(({ entityId, eventId, visibility }) => [
    entityId,
    eventId,
    visibility,
  ]);
  assert.deepEqual(touches, [
    ['bram', 'e1', 'player'],
    ['mira', 'e1', 'player'],
    ['mira', 'e2', 'gm'],
    ['spy', 'e2', 'gm'],
  ]);
  connection.close();
});
