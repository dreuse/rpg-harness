import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { pendingOf } from '../../memory/src/graph.ts';
import { summariesOf } from '../../memory/src/history.ts';
import { DEFAULT_CONTEXT_BUDGET } from '../../memory/src/packet.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore, createFactStore } from '../../persistence/src/entity-store.ts';
import { createEventStore, listScopedEvents } from '../../persistence/src/event-store.ts';
import {
  contextBudgetOf,
  ENTITY_INTRODUCED,
  FACT_RECORDED,
  introduceEntity,
  openPending,
  recordSummary,
  resolvePending,
  saveContextBudget,
} from './memory.ts';
import { ActionIdConflictError, InvalidActionError, type PlayerAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: MAIN_BRANCH,
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
const PIER = {
  id: 'pier',
  campaignId: CAMPAIGN.id,
  kind: 'location' as const,
  name: 'Pier',
  data: {},
  visibility: 'public' as const,
  actorId: null,
};
const WARDEN = { id: 'warden', kind: 'npc' as const, name: 'Warden', data: { mood: 'tired' } };
const PUBLIC = { visibility: 'public' as const, actorId: null };
const SECRET = { visibility: 'gm' as const, actorId: null };

const seeded = () => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  const store = createCampaignStore(database);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [MARA], scenes: [SCENE], events: [] });
  const entities = createEntityStore(database);
  entities.saveEntity(PIER);
  return { connection, store, entities, facts: createFactStore(database), events: createEventStore(database) };
};

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
  sceneId: SCENE.id,
  actorId: MARA.id,
  input: `${actionId}.`,
  intent: `The GM records ${actionId}.`,
});

const introduction = (store: CampaignStore, actionId = 'meet-warden') => ({
  ...actionFor(store, actionId),
  entity: { ...WARDEN, ...PUBLIC },
  facts: [
    { id: 'warden-debt', statement: 'The warden owes Mara a favour', layer: 'canon' as const, ...PUBLIC },
    { id: 'warden-plan', statement: 'The warden plans to flood the vault', layer: 'canon' as const, ...SECRET },
  ],
  relationships: [{ id: 'warden-at-pier', kind: 'contains', sourceId: PIER.id, targetId: WARDEN.id, data: {} }],
});

test('rpg-42a.36 a GM-introduced entity is committed as an event and projected into the graph', () => {
  const { connection, store, entities, facts } = seeded();
  const input = introduction(store);
  const committed = introduceEntity(store, entities, facts, input);
  assert.ok(committed.events.some(({ type }) => type === ENTITY_INTRODUCED));
  const recorded = committed.events.filter(({ type }) => type === FACT_RECORDED);
  assert.deepEqual(entities.getEntity(CAMPAIGN.id, WARDEN.id), { ...input.entity, campaignId: CAMPAIGN.id });
  assert.deepEqual(
    facts
      .listFacts(CAMPAIGN.id)
      .map(({ id, subjectId, sourceEventId, visibility }) => [id, subjectId, sourceEventId, visibility]),
    [
      ['warden-debt', WARDEN.id, recorded[0]?.id, 'public'],
      ['warden-plan', WARDEN.id, recorded[1]?.id, 'gm'],
    ],
  );
  const shown = new Map(
    listScopedEvents(connection.database, CAMPAIGN.id).map(({ id, visibility }) => [id, visibility]),
  );
  assert.deepEqual(
    recorded.map(({ id }) => shown.get(id)),
    ['public', 'gm'],
  );
  assert.ok(!JSON.stringify(committed.events.find(({ type }) => type === ENTITY_INTRODUCED)).includes('flood'));
  assert.deepEqual(
    entities.listRelationships(CAMPAIGN.id, WARDEN.id).map(({ id }) => id),
    ['warden-at-pier'],
  );
  assert.equal(introduceEntity(store, entities, facts, input).turn.id, committed.turn.id);
  assert.throws(
    () => introduceEntity(store, entities, facts, { ...input, entity: { ...input.entity, name: 'Other' } }),
    ActionIdConflictError,
  );
  connection.close();
});

test('rpg-42a.36 an entity introduction with a dangling relationship commits nothing', () => {
  const { connection, store, entities, facts } = seeded();
  const input = introduction(store);
  const dangling = { ...input, relationships: input.relationships.map((edge) => ({ ...edge, sourceId: 'nowhere' })) };
  assert.throws(() => introduceEntity(store, entities, facts, dangling), InvalidActionError);
  assert.equal(entities.getEntity(CAMPAIGN.id, WARDEN.id), undefined);
  assert.equal(store.load(CAMPAIGN.id)?.turns.length, 1);
  connection.close();
});

test('rpg-42a.36 an entity introduction never overwrites an existing entity, character or fact', () => {
  const { connection, store, entities, facts } = seeded();
  const gmFact = {
    id: 'warden-plan',
    campaignId: CAMPAIGN.id,
    subjectId: PIER.id,
    statement: 'Keep',
    layer: 'canon' as const,
    sourceEventId: null,
    ...SECRET,
  };
  facts.saveFact(gmFact);
  const input = introduction(store);
  const rejected = [
    { ...input, entity: { ...input.entity, id: PIER.id } },
    { ...input, entity: { ...input.entity, id: MARA.id } },
    input,
    { ...input, facts: [{ ...input.facts[0], id: 'new-fact', actorId: 'ghost' }] },
  ];
  for (const attempt of rejected)
    assert.throws(() => introduceEntity(store, entities, facts, attempt as typeof input), InvalidActionError);
  assert.deepEqual(entities.getEntity(CAMPAIGN.id, PIER.id), PIER);
  assert.deepEqual(facts.listFacts(CAMPAIGN.id), [gmFact]);
  assert.equal(store.load(CAMPAIGN.id)?.turns.length, 1);
  connection.close();
});

test('rpg-42a.36 retrying an introduction after a failed projection writes the projection', () => {
  const { connection, store, entities, facts } = seeded();
  const input = introduction(store);
  const failing = { ...entities, saveEntity: () => assert.fail('projection lost') };
  assert.throws(() => introduceEntity(store, failing, facts, input));
  assert.equal(entities.getEntity(CAMPAIGN.id, WARDEN.id), undefined);
  const changed = {
    ...input,
    facts: [
      ...input.facts.map((fact) => ({ ...fact, ...PUBLIC })),
      { id: 'warden-extra', statement: 'The warden hides a key', layer: 'canon' as const, ...PUBLIC },
    ],
  };
  assert.throws(() => introduceEntity(store, entities, facts, changed), ActionIdConflictError);
  assert.deepEqual(facts.listFacts(CAMPAIGN.id), []);
  const committed = introduceEntity(store, entities, facts, input);
  assert.deepEqual(entities.getEntity(CAMPAIGN.id, WARDEN.id), { ...input.entity, campaignId: CAMPAIGN.id });
  assert.deepEqual(
    facts.listFacts(CAMPAIGN.id).map(({ id, visibility, sourceEventId }) => [id, visibility, sourceEventId]),
    [
      ['warden-debt', 'public', committed.events.filter(({ type }) => type === FACT_RECORDED)[0]?.id],
      ['warden-plan', 'gm', committed.events.filter(({ type }) => type === FACT_RECORDED)[1]?.id],
    ],
  );
  assert.deepEqual(
    entities.listRelationships(CAMPAIGN.id, WARDEN.id).map(({ id }) => id),
    ['warden-at-pier'],
  );
  connection.close();
});

test('rpg-42a.36 pending promises open and resolve as committed events', () => {
  const { connection, store, entities, facts } = seeded();
  introduceEntity(store, entities, facts, introduction(store));
  const pending = {
    pendingId: 'promise-1',
    kind: 'promise' as const,
    text: 'The warden will open the gate at dawn',
    entityIds: [WARDEN.id],
    ...PUBLIC,
  };
  const opening = (actionId: string, changes = {}) => ({
    ...actionFor(store, actionId),
    pending: { ...pending, ...changes },
  });
  openPending(store, opening('promise'));
  const events = () => store.load(CAMPAIGN.id)?.events ?? [];
  assert.deepEqual(
    pendingOf(events()).map(({ id, text, visibility }) => [id, text, visibility]),
    [['promise-1', pending.text, 'public']],
  );
  assert.throws(() => openPending(store, opening('again')), InvalidActionError);
  assert.throws(() => openPending(store, opening('unlinked', { pendingId: 'p2', entityIds: [] })), InvalidActionError);
  assert.throws(() => openPending(store, opening('whim', { pendingId: 'p3', kind: 'whim' })), InvalidActionError);
  assert.throws(
    () => resolvePending(store, { ...actionFor(store, 'resolve-unknown'), pendingId: 'nope' }),
    InvalidActionError,
  );
  resolvePending(store, { ...actionFor(store, 'resolve'), pendingId: 'promise-1' });
  assert.deepEqual(pendingOf(events()), []);
  connection.close();
});

test('rpg-42a.36 summaries are validated against committed events and written as events', () => {
  const { connection, store, entities, facts, events } = seeded();
  const committed = introduceEntity(store, entities, facts, introduction(store));
  const summary = {
    id: 'scene-summary-1',
    campaignId: CAMPAIGN.id,
    text: 'Mara met the warden at the pier.',
    sourceEventIds: committed.events.map(({ id }) => id),
    ...PUBLIC,
  };
  const write = (actionId: string, sourceEventIds: readonly string[]) =>
    recordSummary(store, {
      campaignId: CAMPAIGN.id,
      actionId,
      expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
      level: 'scene',
      scopeId: SCENE.id,
      summary: { ...summary, sourceEventIds },
    });
  write('summary', summary.sourceEventIds);
  assert.throws(() => write('bad-summary', ['missing-event']));
  assert.deepEqual(summariesOf(events.list(CAMPAIGN.id, MAIN_BRANCH)), [
    { level: 'scene', scopeId: SCENE.id, summary },
  ]);
  connection.close();
});

test('rpg-42a.36 the context budget preset is a per-campaign setting with a default', () => {
  const { connection, store, events } = seeded();
  const list = () => events.list(CAMPAIGN.id, MAIN_BRANCH);
  assert.equal(contextBudgetOf(list()), DEFAULT_CONTEXT_BUDGET);
  const save = (preset: string) =>
    saveContextBudget(store, {
      campaignId: CAMPAIGN.id,
      actionId: `budget-${preset}`,
      expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
      preset,
    });
  save('rich');
  assert.equal(contextBudgetOf(list()), 'rich');
  assert.throws(() => save('huge'), InvalidActionError);
  assert.equal(contextBudgetOf(list()), 'rich');
  connection.close();
});

const INNKEEPER_FACT = 'Innkeeper of the Hollow Lantern';
const innkeeper = (store: CampaignStore, actionId: string, id: string, name: string) => ({
  ...actionFor(store, actionId),
  entity: { id, kind: 'npc' as const, name, data: {}, ...PUBLIC },
  facts: [{ id: `${id}-role`, statement: INNKEEPER_FACT, layer: 'canon' as const, ...PUBLIC }],
  relationships: [],
});

test('rpg-42a.79 a second npc claiming an existing role is rejected and names the existing entity', () => {
  const { connection, store, entities, facts } = seeded();
  introduceEntity(store, entities, facts, innkeeper(store, 'meet-maren', 'maren-oakhollow', 'Maren Oakhollow'));
  const duplicate = innkeeper(store, 'meet-marta', 'marta-hollis', 'Marta Hollis');
  assert.throws(
    () => introduceEntity(store, entities, facts, duplicate),
    (error: unknown) => error instanceof InvalidActionError && error.message.includes('maren-oakhollow'),
  );
  assert.equal(entities.getEntity(CAMPAIGN.id, 'marta-hollis'), undefined);
  connection.close();
});

test('an introduced npc keeps valid voice traits and drops unknown values', () => {
  const { connection, store, entities, facts } = seeded();
  const input = introduction(store);
  introduceEntity(store, entities, facts, {
    ...input,
    entity: { ...input.entity, data: { voiceTraits: { gender: 'female', age: 'ancient', manner: 'gruff', extra: 1 } } },
  });
  assert.deepEqual(entities.getEntity(CAMPAIGN.id, WARDEN.id)?.data, {
    voiceTraits: { gender: 'female', manner: 'gruff' },
  });
  connection.close();
});

test('an introduced npc with unusable voice traits stores none', () => {
  const { connection, store, entities, facts } = seeded();
  const input = introduction(store);
  introduceEntity(store, entities, facts, {
    ...input,
    entity: { ...input.entity, data: { voiceTraits: { gender: 'robot' } } },
  });
  assert.deepEqual(entities.getEntity(CAMPAIGN.id, WARDEN.id)?.data, {});
  connection.close();
});
