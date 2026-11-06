import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, MAIN_BRANCH, SYSTEM_TURN } from '../../domain/src/campaign.ts';
import { CLAIM_CORRECTED, CLAIM_RECORDED, currentEntries } from '../../memory/src/ledger.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore } from '../../persistence/src/entity-store.ts';
import { listScopedEvents } from '../../persistence/src/event-store.ts';
import { playTurns } from './character.ts';
import {
  CONTINUITY_CONFLICT_LOGGED,
  correctStoryFact,
  ledgerOf,
  proposeClaims,
  readStoryMemory,
  recordContinuityConflict,
} from './story-memory.ts';
import { ActionIdConflictError, InvalidActionError, type PlayerAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const WARDEN = {
  id: 'warden',
  campaignId: CAMPAIGN.id,
  kind: 'npc' as const,
  name: 'Warden',
  data: {},
  visibility: 'public' as const,
  actorId: null,
};
const PIER = { ...WARDEN, id: 'pier', kind: 'location' as const, name: 'Pier' };
const PUBLIC = { visibility: 'public' as const };

const seeded = () => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  const store = createCampaignStore(database);
  store.createCampaign(CAMPAIGN, {
    id: 'created-1',
    campaignId: CAMPAIGN.id,
    branchId: MAIN_BRANCH,
    actionId: 'create',
    type: 'CampaignCreated',
    payload: { name: CAMPAIGN.name },
  });
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'turn-0',
      campaignId: CAMPAIGN.id,
      sceneId: SCENE.id,
      actionId: 'setup',
      actorId: MARA.id,
      input: 'Begin.',
      narration: 'A lantern sways.',
    },
    characters: [MARA],
    scenes: [SCENE],
    events: [],
  });
  const entities = createEntityStore(database);
  entities.saveEntity(WARDEN);
  entities.saveEntity(PIER);
  return { connection, database, store, entities };
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

const proposal = (store: CampaignStore, actionId: string, claims: Parameters<typeof proposeClaims>[2]['claims']) => ({
  ...actionFor(store, actionId),
  claims,
});

test('rpg-42a.42 a GM claim is validated, committed as an event and folded into the ledger', () => {
  const { connection, store, entities } = seeded();
  const input = proposal(store, 'warden-dies', [{ entityId: WARDEN.id, kind: 'alive', value: 'dead', ...PUBLIC }]);
  const committed = proposeClaims(store, entities, input);
  assert.equal(committed.turn.kind, SYSTEM_TURN);
  assert.ok(committed.events.some(({ type }) => type === CLAIM_RECORDED));
  const ledger = ledgerOf(store.load(CAMPAIGN.id)?.events ?? []);
  assert.deepEqual(
    ledger.map(({ entityId, kind, value }) => [entityId, kind, value]),
    [[WARDEN.id, 'alive', 'dead']],
  );
  assert.equal(proposeClaims(store, entities, input).turn.id, committed.turn.id);
  assert.throws(
    () => proposeClaims(store, entities, { ...input, claims: [{ ...input.claims[0], value: 'alive' }] as never }),
    ActionIdConflictError,
  );
  connection.close();
});

test('rpg-42a.42 the engine rejects claims about unknown entities, bad values and public secrets', () => {
  const { connection, store, entities } = seeded();
  const bad: [string, Parameters<typeof proposeClaims>[2]['claims']][] = [
    ['ghost', [{ entityId: 'nobody', kind: 'alive', value: 'dead', ...PUBLIC }]],
    ['kind', [{ entityId: WARDEN.id, kind: 'teleports' as never, value: 'x', ...PUBLIC }]],
    ['value', [{ entityId: WARDEN.id, kind: 'alive', value: 'undead', ...PUBLIC }]],
    ['blank', [{ entityId: WARDEN.id, kind: 'description', value: '  ', ...PUBLIC }]],
    ['key', [{ entityId: WARDEN.id, kind: 'item', value: 'held', ...PUBLIC }]],
    ['secret', [{ entityId: WARDEN.id, kind: 'secret', key: 'loyalty', value: 'cult', ...PUBLIC }]],
    ['link', [{ entityId: WARDEN.id, kind: 'relationship', key: 'nobody', value: 'ally', ...PUBLIC }]],
    ['none', []],
  ];
  for (const [id, claims] of bad) {
    assert.throws(() => proposeClaims(store, entities, proposal(store, id, claims)), InvalidActionError, id);
  }
  assert.equal(store.load(CAMPAIGN.id)?.turns.length, 1);
  connection.close();
});

test('rpg-42a.42 story memory lists what the player may see and hides GM secrets', () => {
  const { connection, store, entities } = seeded();
  proposeClaims(
    store,
    entities,
    proposal(store, 'facts', [
      { entityId: WARDEN.id, kind: 'alive', value: 'alive', ...PUBLIC },
      { entityId: PIER.id, kind: 'description', value: 'rotting planks', ...PUBLIC },
      { entityId: WARDEN.id, kind: 'promise', key: 'open the vault', value: 'open', ...PUBLIC },
      { entityId: WARDEN.id, kind: 'secret', key: 'loyalty', value: 'serves the cult', visibility: 'gm' },
    ]),
  );
  const memory = readStoryMemory(store, entities, CAMPAIGN.id);
  assert.deepEqual(
    memory.person.map(({ entityName, kind, value }) => [entityName, kind, value]),
    [['Warden', 'alive', 'alive']],
  );
  assert.deepEqual(
    memory.place.map(({ entityName, value }) => [entityName, value]),
    [['Pier', 'rotting planks']],
  );
  assert.deepEqual(
    memory.thread.map(({ key }) => key),
    ['open the vault'],
  );
  assert.equal(JSON.stringify(memory).includes('cult'), false);
  connection.close();
});

test('rpg-42a.42 a player correction is an event that supersedes the fact and keeps history', () => {
  const { connection, database, store, entities } = seeded();
  proposeClaims(
    store,
    entities,
    proposal(store, 'warden-dies', [{ entityId: WARDEN.id, kind: 'alive', value: 'dead', ...PUBLIC }]),
  );
  const base = {
    campaignId: CAMPAIGN.id,
    actorId: MARA.id,
    entityId: WARDEN.id,
    kind: 'alive' as const,
    value: 'alive',
  };
  const input = { ...base, actionId: 'fix-1', expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0 };
  const committed = correctStoryFact(store, entities, input);
  assert.ok(committed.events.some(({ type }) => type === CLAIM_CORRECTED));
  const state = store.load(CAMPAIGN.id);
  const ledger = ledgerOf(state?.events ?? []);
  assert.deepEqual(
    ledger.map(({ value, corrected, supersededBy }) => [value, corrected, supersededBy === null]),
    [
      ['dead', false, false],
      ['alive', true, true],
    ],
  );
  assert.equal(readStoryMemory(store, entities, CAMPAIGN.id).person[0]?.value, 'alive');
  assert.equal(readStoryMemory(store, entities, CAMPAIGN.id).person[0]?.corrected, true);
  assert.equal(correctStoryFact(store, entities, input).turn.id, committed.turn.id);
  assert.equal(
    playTurns(state ?? ({ turns: [], events: [] } as never)).some(({ id }) => id === committed.turn.id),
    false,
  );
  const scoped = listScopedEvents(database, CAMPAIGN.id).find(({ type }) => type === CLAIM_CORRECTED);
  assert.equal(scoped?.visibility, 'player');
  connection.close();
});

test('rpg-42a.42 a player cannot correct a hidden fact or one that does not exist', () => {
  const { connection, store, entities } = seeded();
  proposeClaims(
    store,
    entities,
    proposal(store, 'plant', [
      { entityId: WARDEN.id, kind: 'secret', key: 'loyalty', value: 'cult', visibility: 'gm' },
    ]),
  );
  const revision = () => store.load(CAMPAIGN.id)?.revision ?? 0;
  const attempt = (actionId: string, extra: object) => () =>
    correctStoryFact(store, entities, {
      campaignId: CAMPAIGN.id,
      actionId,
      expectedRevision: revision(),
      actorId: MARA.id,
      entityId: WARDEN.id,
      kind: 'secret',
      key: 'loyalty',
      value: 'loyal',
      ...extra,
    });
  assert.throws(attempt('hidden', {}), InvalidActionError);
  assert.throws(attempt('missing', { kind: 'alive' }), InvalidActionError);
  assert.throws(attempt('blank', { kind: 'alive', value: '' }), InvalidActionError);
  connection.close();
});

test('rpg-42a.42 a continuity conflict is logged as a campaign change without secret text', () => {
  const { connection, store } = seeded();
  recordContinuityConflict(store, {
    campaignId: CAMPAIGN.id,
    actionId: 'log-1',
    expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
    record: {
      regenerations: 1,
      resolved: false,
      conflicts: [
        { kind: 'dead-acts', entityId: WARDEN.id, fact: 'Warden alive: dead', excerpt: 'Warden smiles.' },
        { kind: 'secret-leak', entityId: WARDEN.id, fact: 'Warden secret loyalty: cult', excerpt: 'It is the cult.' },
      ],
    },
  });
  const logged = store.load(CAMPAIGN.id)?.changes.find(({ type }) => type === CONTINUITY_CONFLICT_LOGGED);
  assert.ok(logged);
  assert.equal(JSON.stringify(logged).includes('cult'), false);
  assert.equal(logged.payload.resolved, false);
  connection.close();
});

test('rpg-42a.42 a public claim about a GM-only entity is rejected, so its name never reaches the player', () => {
  const { connection, store, entities } = seeded();
  entities.saveEntity({ ...WARDEN, id: 'lich', name: 'Malgrith', visibility: 'gm' });
  assert.throws(
    () =>
      proposeClaims(
        store,
        entities,
        proposal(store, 'lich-public', [{ entityId: 'lich', kind: 'alive', value: 'dead', ...PUBLIC }]),
      ),
    InvalidActionError,
  );
  proposeClaims(
    store,
    entities,
    proposal(store, 'lich-hidden', [{ entityId: 'lich', kind: 'alive', value: 'dead', visibility: 'gm' }]),
  );
  assert.equal(JSON.stringify(readStoryMemory(store, entities, CAMPAIGN.id)).includes('Malgrith'), false);
  connection.close();
});

test('rpg-42a.42 the conflict log blanks every excerpt that shares a leaked secret sentence', () => {
  const { connection, store } = seeded();
  const shared = 'Maren smiles and the cult rises.';
  recordContinuityConflict(store, {
    campaignId: CAMPAIGN.id,
    actionId: 'log-shared',
    expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
    record: {
      regenerations: 1,
      resolved: false,
      conflicts: [
        { kind: 'dead-acts', entityId: WARDEN.id, fact: 'Warden alive: dead', excerpt: shared },
        { kind: 'secret-leak', entityId: WARDEN.id, fact: 'x', excerpt: shared },
      ],
    },
  });
  const logged = store.load(CAMPAIGN.id)?.changes.find(({ type }) => type === CONTINUITY_CONFLICT_LOGGED);
  assert.equal(JSON.stringify(logged).includes('cult'), false);
  connection.close();
});

test('rpg-42a.42 a player correction cannot erase a newer GM-only claim in the same slot', () => {
  const { connection, store, entities } = seeded();
  proposeClaims(
    store,
    entities,
    proposal(store, 'public-alive', [{ entityId: WARDEN.id, kind: 'alive', value: 'alive', ...PUBLIC }]),
  );
  proposeClaims(
    store,
    entities,
    proposal(store, 'secret-death', [{ entityId: WARDEN.id, kind: 'alive', value: 'dead', visibility: 'gm' }]),
  );
  assert.equal(readStoryMemory(store, entities, CAMPAIGN.id).person[0]?.value, 'alive');
  const revision = store.load(CAMPAIGN.id)?.revision ?? 0;
  assert.throws(
    () =>
      correctStoryFact(store, entities, {
        campaignId: CAMPAIGN.id,
        actionId: 'fix-visible',
        expectedRevision: revision,
        actorId: MARA.id,
        entityId: WARDEN.id,
        kind: 'alive',
        value: 'alive',
      }),
    (error) => error instanceof InvalidActionError && !/hidden|secret|gm/i.test(error.message),
  );
  const current = currentEntries(ledgerOf(store.load(CAMPAIGN.id)?.events ?? []));
  assert.deepEqual(
    current.map(({ value, visibility }) => [value, visibility]),
    [['dead', 'gm']],
  );
  assert.equal(store.load(CAMPAIGN.id)?.revision, revision);
  connection.close();
});

test('rpg-42a.42 a public relationship that points at a GM-only entity is rejected', () => {
  const { connection, store, entities } = seeded();
  entities.saveEntity({ ...WARDEN, id: 'lich', name: 'Malgrith', visibility: 'gm' });
  assert.throws(
    () =>
      proposeClaims(
        store,
        entities,
        proposal(store, 'bad-link', [
          { entityId: WARDEN.id, kind: 'relationship', key: 'lich', value: 'ally', ...PUBLIC },
        ]),
      ),
    InvalidActionError,
  );
  proposeClaims(
    store,
    entities,
    proposal(store, 'gm-link', [
      { entityId: WARDEN.id, kind: 'relationship', key: 'lich', value: 'ally', visibility: 'gm' },
    ]),
  );
  proposeClaims(
    store,
    entities,
    proposal(store, 'ok-link', [
      { entityId: WARDEN.id, kind: 'relationship', key: PIER.id, value: 'guards', ...PUBLIC },
    ]),
  );
  connection.close();
});
