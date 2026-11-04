import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import type { BuildInput, CreationRules } from '../../rules/src/character-builder.ts';
import { SHEET_SCHEMA_VERSION } from '../../rules/src/sheet-schema.ts';
import { CHARACTER_CREATED, commitCharacter } from './character.ts';
import { createEngine } from './engine.ts';
import { InvalidActionError, openScene } from './turn.ts';

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
