import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, SYSTEM_TURN } from '../../domain/src/campaign.ts';
import type { CampaignEntity, EntityStore } from '../../domain/src/entity.ts';
import { type Fact, PLAYER_VIEWER } from '../../memory/src/knowledge.ts';
import { retrieveContext } from '../../memory/src/retrieval.ts';
import type { NpcState } from '../../narrative/src/npc.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore } from '../../persistence/src/entity-store.ts';
import {
  loadNpc,
  NPC_LEARNED_FACT,
  NPC_STATE_RELATIONSHIP,
  recordNpcLearning,
  STANCE_RELATIONSHIP,
  saveNpc,
} from './npc.ts';
import { InvalidActionError, type PlayerAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const SETUP_TURN = {
  id: 'turn-0',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'setup',
  actorId: MARA.id,
  input: 'Begin.',
  narration: 'A lantern sways at the end of the pier.',
};
const entity = (id: string, overrides: Partial<CampaignEntity> = {}): CampaignEntity => ({
  id,
  campaignId: CAMPAIGN.id,
  kind: 'npc',
  name: id,
  data: {},
  visibility: 'public',
  actorId: null,
  ...overrides,
});
const WARDEN_ENTITY = entity('npc-warden', { data: { sheet: { grit: 2 } } });
const SMUGGLER_ENTITY = entity('npc-smuggler');
const HERO_ENTITY = entity(MARA.id, { kind: 'character' });
const LOCATION_ENTITY = entity('location-pier', { kind: 'location' });
const fact = (id: string, overrides: Partial<Fact> = {}): Fact => ({
  id,
  campaignId: CAMPAIGN.id,
  subjectId: null,
  statement: `statement ${id}`,
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
  ...overrides,
});
const GATE = fact('fact-gate');
const SECRET = fact('fact-secret', { visibility: 'gm' });
const FOREIGN = fact('fact-foreign', { campaignId: 'campaign-2' });
const WARDEN: NpcState = {
  id: WARDEN_ENTITY.id,
  goals: ['protect the vault'],
  disposition: 'calm',
  relationships: { [MARA.id]: 'friendly', [SMUGGLER_ENTITY.id]: 'hostile' },
  learned: [{ factId: 'fact-old', channel: 'told', sourceId: SMUGGLER_ENTITY.id, eventId: 'event-old' }],
};
const OVERHEARD = { channel: 'witnessed', sourceId: null, eventId: 'event-overheard' } as const;
const UNLIMITED_BUDGET = Number.MAX_SAFE_INTEGER;

const open = () => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  const entities = createEntityStore(connection.database);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [MARA], scenes: [SCENE], events: [] });
  for (const saved of [WARDEN_ENTITY, SMUGGLER_ENTITY, HERO_ENTITY, LOCATION_ENTITY]) entities.saveEntity(saved);
  return { store, entities, close: () => connection.close() };
};

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
  sceneId: SCENE.id,
  actorId: MARA.id,
  input: `${actionId}.`,
  intent: `Mara does ${actionId}.`,
});

const withNpc = (run: (store: CampaignStore, entities: EntityStore) => void) => {
  const { store, entities, close } = open();
  try {
    saveNpc(entities, CAMPAIGN.id, WARDEN);
    run(store, entities);
  } finally {
    close();
  }
};

const stancesOf = (entities: EntityStore, id: string) =>
  entities.listRelationships(CAMPAIGN.id, id).filter(({ kind }) => kind === STANCE_RELATIONSHIP);

test('npc state round-trips through a state record and stance relationships', () =>
  withNpc((_, entities) => {
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, WARDEN.id), WARDEN);
    const saved = entities.getEntity(CAMPAIGN.id, WARDEN.id);
    assert.deepEqual(saved, WARDEN_ENTITY);
    assert.deepEqual(
      stancesOf(entities, WARDEN.id).map(({ kind, targetId, data }) => [kind, targetId, data]),
      [
        ['stance', MARA.id, { stance: 'friendly' }],
        ['stance', SMUGGLER_ENTITY.id, { stance: 'hostile' }],
      ],
    );
  }));

test('a stance change updates the existing relationship instead of adding one', () =>
  withNpc((_, entities) => {
    saveNpc(entities, CAMPAIGN.id, { ...WARDEN, relationships: { ...WARDEN.relationships, [MARA.id]: 'wary' } });
    assert.equal(stancesOf(entities, WARDEN.id).length, 2);
    assert.equal(loadNpc(entities, CAMPAIGN.id, WARDEN.id)?.relationships[MARA.id], 'wary');
  }));

test('an npc entity without narrative state loads as an empty npc', () =>
  withNpc((_, entities) => {
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, SMUGGLER_ENTITY.id), {
      id: SMUGGLER_ENTITY.id,
      goals: [],
      disposition: '',
      relationships: {},
      learned: [],
    });
  }));

test('missing, non-npc or malformed entities do not load as npcs', () =>
  withNpc((_, entities) => {
    entities.saveEntity(entity('npc-broken'));
    entities.saveRelationship({
      id: 'npc-broken/state',
      campaignId: CAMPAIGN.id,
      kind: NPC_STATE_RELATIONSHIP,
      sourceId: 'npc-broken',
      targetId: 'npc-broken',
      data: { goals: 'all', disposition: 1, learned: [] },
    });
    assert.equal(loadNpc(entities, CAMPAIGN.id, 'npc-missing'), undefined);
    assert.equal(loadNpc(entities, CAMPAIGN.id, LOCATION_ENTITY.id), undefined);
    assert.equal(loadNpc(entities, CAMPAIGN.id, 'npc-broken'), undefined);
  }));

test('saving state for an npc that is not an entity is rejected', () =>
  withNpc((_, entities) => {
    assert.throws(() => saveNpc(entities, CAMPAIGN.id, { ...WARDEN, id: 'npc-missing' }), /npc-missing/);
  }));

test('learning a fact commits an event and persists the learned fact', () =>
  withNpc((store, entities) => {
    const learning = { ...actionFor(store, 'overhear'), npcId: WARDEN.id, fact: GATE, learning: OVERHEARD };
    const committed = recordNpcLearning(store, entities, learning);
    assert.equal(committed.turn.kind, SYSTEM_TURN);
    assert.deepEqual(
      committed.events.map(({ type }) => type),
      ['PlayerActionSubmitted', 'ActionValidated', NPC_LEARNED_FACT],
    );
    assert.deepEqual(committed.events.at(-1)?.payload, { npcId: WARDEN.id, factId: GATE.id, ...OVERHEARD });
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, WARDEN.id)?.learned, [
      ...WARDEN.learned,
      { factId: GATE.id, ...OVERHEARD },
    ]);
    assert.deepEqual(recordNpcLearning(store, entities, learning), committed);
    assert.equal(store.load(CAMPAIGN.id)?.events.filter(({ type }) => type === NPC_LEARNED_FACT).length, 1);
  }));

test('hidden, repeated, foreign or unknown-npc learning is rejected without writing', () =>
  withNpc((store, entities) => {
    const learn = (actionId: string, npcId: string, learned: Fact) =>
      recordNpcLearning(store, entities, { ...actionFor(store, actionId), npcId, fact: learned, learning: OVERHEARD });
    const before = store.load(CAMPAIGN.id);
    assert.throws(() => learn('secret', WARDEN.id, SECRET), InvalidActionError);
    assert.throws(() => learn('foreign', WARDEN.id, FOREIGN), InvalidActionError);
    assert.throws(() => learn('stranger', 'npc-missing', GATE), InvalidActionError);
    assert.throws(() => learn('place', LOCATION_ENTITY.id, GATE), InvalidActionError);
    assert.throws(() => learn('again', WARDEN.id, { ...GATE, id: 'fact-old' }), InvalidActionError);
    assert.deepEqual(store.load(CAMPAIGN.id), before);
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, WARDEN.id), WARDEN);
  }));

test('players retrieving context for a public npc see none of its private state', () =>
  withNpc((store, entities) => {
    const retrieved = retrieveContext(
      {
        scene: SCENE,
        sceneEntityIds: [WARDEN.id],
        pinnedFactIds: [],
        entities: entities.listEntities(CAMPAIGN.id),
        relationships: entities.listRelationships(CAMPAIGN.id),
        threads: [],
        facts: [],
        events: store.load(CAMPAIGN.id)?.events ?? [],
      },
      PLAYER_VIEWER,
      UNLIMITED_BUDGET,
    );
    const rendered = JSON.stringify(retrieved);
    assert.ok(retrieved.entities.some(({ id }) => id === WARDEN.id));
    for (const secret of [...WARDEN.goals, WARDEN.disposition, ...WARDEN.learned.map(({ factId }) => factId)])
      assert.ok(!rendered.includes(secret), secret);
  }));

test('learning without an event id records the committed learning event', () =>
  withNpc((store, entities) => {
    const learning = { ...OVERHEARD, eventId: null };
    const committed = recordNpcLearning(store, entities, {
      ...actionFor(store, 'notice'),
      npcId: WARDEN.id,
      fact: GATE,
      learning,
    });
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, WARDEN.id)?.learned.at(-1), {
      factId: GATE.id,
      ...learning,
      eventId: committed.events.at(-1)?.id,
    });
  }));

test('retrying a committed learning repairs npc state that failed to save', () =>
  withNpc((store, entities) => {
    let failNextSave = true;
    const flaky: EntityStore = {
      ...entities,
      saveRelationship: (relationship) => {
        if (failNextSave) {
          failNextSave = false;
          throw new Error('disk full');
        }
        entities.saveRelationship(relationship);
      },
    };
    const learning = { ...actionFor(store, 'overhear'), npcId: WARDEN.id, fact: GATE, learning: OVERHEARD };
    assert.throws(() => recordNpcLearning(store, flaky, learning), /disk full/);
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, WARDEN.id), WARDEN);
    recordNpcLearning(store, flaky, learning);
    assert.deepEqual(loadNpc(entities, CAMPAIGN.id, WARDEN.id)?.learned, [
      ...WARDEN.learned,
      { factId: GATE.id, ...OVERHEARD },
    ]);
    assert.equal(store.load(CAMPAIGN.id)?.events.filter(({ type }) => type === NPC_LEARNED_FACT).length, 1);
  }));
