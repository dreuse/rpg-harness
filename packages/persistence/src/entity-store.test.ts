import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampaignBoundaryError } from '../../domain/src/campaign.ts';
import { type CampaignEntity, DanglingReferenceError, type Relationship } from '../../domain/src/entity.ts';
import { openDatabase } from './database.ts';
import { createEntityStore } from './entity-store.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN_A = 'campaign-a';
const CAMPAIGN_B = 'campaign-b';
const NPC: CampaignEntity = {
  id: 'npc-1',
  campaignId: CAMPAIGN_A,
  kind: 'npc',
  name: 'Old Tomas',
  data: { mood: 'wary' },
  visibility: 'public',
  actorId: null,
};
const LOCATION: CampaignEntity = { ...NPC, id: 'location-1', kind: 'location', name: 'Lighthouse', data: {} };
const FACTION: CampaignEntity = { ...NPC, id: 'faction-1', kind: 'faction', name: 'Dock Guild', data: {} };
const ITEM: CampaignEntity = {
  ...NPC,
  id: 'item-1',
  kind: 'item',
  name: 'Brass Key',
  data: {},
  visibility: 'actor-scoped',
  actorId: NPC.id,
};
const ENTITIES = [NPC, LOCATION, FACTION, ITEM];
const MEMBERSHIP: Relationship = {
  id: 'relationship-1',
  campaignId: CAMPAIGN_A,
  kind: 'member-of',
  sourceId: NPC.id,
  targetId: FACTION.id,
  data: { since: 'spring' },
};
const POSSESSION: Relationship = { ...MEMBERSHIP, id: 'relationship-2', kind: 'holds', targetId: ITEM.id, data: {} };
const RENAMED_NPC = { ...NPC, name: 'Tomas the Elder' };
const MISSING_ID = 'npc-missing';

const openStore = () => {
  const connection = openDatabase(IN_MEMORY);
  const insertCampaign = connection.database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)');
  insertCampaign.run(CAMPAIGN_A, CAMPAIGN_A);
  insertCampaign.run(CAMPAIGN_B, CAMPAIGN_B);
  return { connection, store: createEntityStore(connection.database) };
};

test('persist stable-id npcs, locations, factions, items and relationships', () => {
  const { connection, store } = openStore();
  for (const entity of ENTITIES) store.saveEntity(entity);
  store.saveRelationship(MEMBERSHIP);
  store.saveRelationship(POSSESSION);
  store.saveEntity(RENAMED_NPC);

  assert.deepEqual(store.getEntity(CAMPAIGN_A, NPC.id), RENAMED_NPC);
  assert.deepEqual(store.listEntities(CAMPAIGN_A), [RENAMED_NPC, LOCATION, FACTION, ITEM]);
  assert.deepEqual(store.listEntities(CAMPAIGN_A, 'item'), [ITEM]);
  assert.deepEqual(store.listRelationships(CAMPAIGN_A), [MEMBERSHIP, POSSESSION]);
  assert.deepEqual(store.listRelationships(CAMPAIGN_A, ITEM.id), [POSSESSION]);
  connection.close();
});

test('dangling references and cross-campaign entity access are rejected', () => {
  const { connection, store } = openStore();
  for (const entity of ENTITIES) store.saveEntity(entity);
  store.saveRelationship(MEMBERSHIP);

  assert.throws(() => store.saveRelationship({ ...POSSESSION, targetId: MISSING_ID }), DanglingReferenceError);
  assert.throws(() => store.saveEntity({ ...ITEM, actorId: MISSING_ID }), DanglingReferenceError);
  assert.throws(() => store.saveEntity({ ...NPC, campaignId: CAMPAIGN_B }), CampaignBoundaryError);
  assert.throws(() => store.saveRelationship({ ...MEMBERSHIP, campaignId: CAMPAIGN_B }), CampaignBoundaryError);

  const outsider = { ...LOCATION, id: 'location-b', campaignId: CAMPAIGN_B };
  store.saveEntity(outsider);
  assert.throws(
    () =>
      store.saveRelationship({ ...POSSESSION, id: 'relationship-b', campaignId: CAMPAIGN_B, sourceId: outsider.id }),
    CampaignBoundaryError,
  );
  assert.throws(
    () => store.saveEntity({ ...outsider, visibility: 'actor-scoped', actorId: NPC.id }),
    CampaignBoundaryError,
  );

  assert.equal(store.getEntity(CAMPAIGN_B, NPC.id), undefined);
  assert.deepEqual(store.listEntities(CAMPAIGN_B), [outsider]);
  assert.deepEqual(store.listRelationships(CAMPAIGN_B), []);
  assert.deepEqual(store.getEntity(CAMPAIGN_A, NPC.id), NPC);
  assert.deepEqual(store.listRelationships(CAMPAIGN_A), [MEMBERSHIP]);
  connection.close();
});
