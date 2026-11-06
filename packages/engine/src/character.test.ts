import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaleRevisionError } from '../../domain/src/campaign.ts';
import type { CharacterProfile } from '../../domain/src/character.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { type BuildInput, buildCharacter, type CreationRules } from '../../rules/src/character-builder.ts';
import { SHEET_SCHEMA_VERSION } from '../../rules/src/sheet-schema.ts';
import { CHARACTER_CREATED, commitCharacter, editSheetField, playTurns, SHEET_FIELD_EDITED } from './character.ts';
import { GM_PROPOSAL_INPUT } from './check-offer.ts';
import { createEngine } from './engine.ts';
import { commit, commitSystem, InvalidActionError, openScene } from './turn.ts';

const IN_MEMORY = ':memory:';
const ACTION_ID = 'create-ash';
const rules: CreationRules = {
  schema: {
    schemaVersion: SHEET_SCHEMA_VERSION,
    rulepack: { id: 'any-pack', edition: '2', revision: 'r1', sourceRefs: [] },
    fields: [{ id: 'grit', widget: 'number', custom: false, visibility: 'public' }],
  },
  constraints: [{ field: 'grit', min: 1, max: 5, onViolation: 'report' }],
  startingEquipment: ['rope'],
  overridableFields: [],
};
const build: BuildInput = {
  rules,
  backstory: 'A drifter.',
  proposal: { name: 'Ash', values: { grit: 3 }, equipment: ['rope'] },
};

const withCampaign = (run: (context: ReturnType<typeof setup>) => void) => {
  const connection = openDatabase(IN_MEMORY);
  try {
    run(setup(connection.database));
  } finally {
    connection.close();
  }
};

const setup = (database: ReturnType<typeof openDatabase>['database']) => {
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  const { id: campaignId } = engine.createCampaign('Ember');
  const { turn } = openScene(store, { campaignId, actorName: 'Ash', sceneTitle: 'Gate', narration: 'Fog.' });
  const state = engine.getState(campaignId);
  const action = {
    campaignId,
    actionId: ACTION_ID,
    expectedRevision: state.revision,
    sceneId: turn.sceneId,
    actorId: turn.actorId,
    input: 'Create character.',
    intent: 'create character',
  };
  return { store, engine, campaignId, action };
};

test('the engine commits a character it rebuilds from the creation rules', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    const committed = commitCharacter(store, { ...action, build });
    const state = engine.getState(campaignId);
    assert.equal(state.revision, action.expectedRevision + 1);
    const event = state.events.find(({ type }) => type === CHARACTER_CREATED);
    assert.equal(event?.payload.actorId, action.actorId);
    assert.deepEqual(event?.payload.profile, {
      identity: { name: 'Ash' },
      motivations: [],
      background: 'A drifter.',
      traits: [{ id: 'grit', value: 3 }],
      conditions: [],
      rulepack: { id: 'any-pack', edition: '2', revision: 'r1' },
    });
    assert.deepEqual(event?.payload.equipment, ['rope']);
    assert.deepEqual(commitCharacter(store, { ...action, build }), committed);
    assert.equal(engine.getState(campaignId).revision, state.revision);
  }));

test('the created character renames the campaign actor to its identity name', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    const renamed = { ...build, proposal: { ...build.proposal, name: 'Wren' } };
    commitCharacter(store, { ...action, build: renamed });
    assert.deepEqual(
      engine.getState(campaignId).characters.map(({ id, name }) => ({ id, name })),
      [{ id: action.actorId, name: 'Wren' }],
    );
  }));

test('the engine refuses a forged, invalid or incomplete character and writes nothing', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    const forged: BuildInput[] = [
      { ...build, proposal: { ...build.proposal, values: { grit: 99 } } },
      { ...build, overrides: { grit: 99 } },
      { ...build, proposal: { ...build.proposal, equipment: ['relic blade'] } },
      { ...build, proposal: { ...build.proposal, values: {} } },
    ];
    for (const input of forged)
      assert.throws(() => commitCharacter(store, { ...action, build: input }), InvalidActionError);
    assert.equal(engine.getState(campaignId).revision, action.expectedRevision);
  }));

const guardedFields = [
  ...rules.schema.fields,
  { id: 'doom', widget: 'number' as const, custom: false, visibility: 'gm' as const },
  { id: 'secret', widget: 'number' as const, custom: false, visibility: 'hidden' as const },
];
const guarded: BuildInput = {
  ...build,
  rules: { ...rules, schema: { ...rules.schema, fields: guardedFields } },
  proposal: { ...build.proposal, values: { grit: 3, doom: 1, secret: 2 } },
};

test('the committed profile keeps gm and hidden traits with their visibility', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    commitCharacter(store, { ...action, build: guarded });
    const event = engine.getState(campaignId).events.find(({ type }) => type === CHARACTER_CREATED);
    assert.ok(event);
    assert.deepEqual((event.payload.profile as CharacterProfile).traits, [
      { id: 'grit', value: 3 },
      { id: 'doom', value: 1 },
      { id: 'secret', value: 2 },
    ]);
    assert.deepEqual(event.payload.traitVisibility, { grit: 'public', doom: 'gm', secret: 'hidden' });
  }));

test('a retried creation replays an event committed with owner-visible traits only', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    const built = buildCharacter(guarded);
    assert.equal(built.status, 'created');
    const { profile } = built.character;
    const stripped = { ...profile, traits: profile.traits.filter(({ id }) => id === 'grit') };
    const legacy = { actorId: action.actorId, ...built.character, profile: stripped };
    const committed = commit(store, action, [[CHARACTER_CREATED, legacy]], []);
    assert.deepEqual(commitCharacter(store, { ...action, build: guarded }), committed);
    assert.equal(engine.getState(campaignId).revision, action.expectedRevision + 1);
  }));

test('the engine commits a sheet field edit once and rejects stale or non-primitive values', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    commitCharacter(store, { ...action, build });
    const { revision } = engine.getState(campaignId);
    const edit = { campaignId, actionId: 'edit-grit', expectedRevision: revision, actorId: action.actorId };
    const committed = editSheetField(store, { ...edit, fieldId: 'grit', value: 4 });
    const state = engine.getState(campaignId);
    assert.equal(state.revision, revision + 1);
    assert.deepEqual(state.events.at(-1)?.type, SHEET_FIELD_EDITED);
    assert.deepEqual(state.events.at(-1)?.payload, { actorId: action.actorId, fieldId: 'grit', value: 4 });
    assert.deepEqual(editSheetField(store, { ...edit, fieldId: 'grit', value: 4 }).turn, committed.turn);
    assert.equal(engine.getState(campaignId).revision, revision + 1);
    assert.throws(
      () => editSheetField(store, { ...edit, actionId: 'edit-2', fieldId: 'grit', value: 5 }),
      StaleRevisionError,
    );
    const fresh = { ...edit, actionId: 'edit-3', expectedRevision: revision + 1, fieldId: 'grit' };
    assert.throws(() => editSheetField(store, { ...fresh, value: { hp: 999 } }), InvalidActionError);
    assert.throws(() => editSheetField(store, { ...fresh, actorId: 'stranger', value: 1 }), InvalidActionError);
    assert.equal(engine.getState(campaignId).revision, revision + 1);
    const cellar = { id: 'cellar', campaignId, title: 'Cellar' };
    store.commitTurn({
      expectedRevision: revision + 1,
      turn: { ...committed.turn, id: 'descend', sceneId: cellar.id, actionId: 'descend', input: 'Down.' },
      characters: [],
      scenes: [cellar],
      events: [],
    });
    assert.equal(engine.getState(campaignId).currentScene?.id, cellar.id);
    assert.deepEqual(editSheetField(store, { ...edit, fieldId: 'grit', value: 4 }).turn, committed.turn);
  }));

test('rpg-42a.23: character creation and sheet edits are not play turns', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    commitCharacter(store, { ...action, build });
    const { revision } = engine.getState(campaignId);
    editSheetField(store, { ...action, actionId: 'edit-grit', expectedRevision: revision, fieldId: 'grit', value: 4 });
    const state = engine.getState(campaignId);
    assert.equal(state.turns.length, 3);
    assert.deepEqual(
      playTurns(state).map(({ actionId }) => actionId),
      [state.turns[0]?.actionId],
    );
  }));

test('rpg-cm63.20: a system commit of any new event type is hidden by turn kind', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    commitSystem(store, action, [['BrandNewSystemEvent', {}]]);
    const state = engine.getState(campaignId);
    assert.equal(state.turns.at(-1)?.kind, 'system');
    assert.equal(playTurns(state).length, 1);
  }));

test('rpg-42a.130: a committed GM proposal is not a play turn', () =>
  withCampaign(({ store, engine, campaignId, action }) => {
    commit(store, { ...action, input: `${GM_PROPOSAL_INPUT}claim aldric-jurou-devolver-chave` }, [
      ['BrandNewPlayerEvent', {}],
    ]);
    const state = engine.getState(campaignId);
    assert.equal(state.turns.length, 2);
    assert.equal(playTurns(state).length, 1);
  }));

test('rpg-42a.130: a player cannot submit input that uses the GM proposal prefix', () =>
  withCampaign(({ engine, action }) => {
    assert.throws(() => engine.submitAction({ ...action, input: `${GM_PROPOSAL_INPUT}claim x` }), InvalidActionError);
  }));
