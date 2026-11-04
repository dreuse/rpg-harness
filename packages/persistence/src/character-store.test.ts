import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHARACTER_KIND, type CharacterProfile, InvalidCharacterProfileError } from '../../domain/src/character.ts';
import { createCharacterStore } from './character-store.ts';
import { openDatabase } from './database.ts';
import { createEntityStore } from './entity-store.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = 'campaign-a';
const CHARACTER_ID = 'character-1';
const PUBLIC = 'public';
const PROFILE: CharacterProfile = {
  identity: { name: 'Mara Quill', pronouns: 'she/her', concept: 'disgraced cartographer' },
  motivations: ['map the drowned coast', 'clear her name'],
  background: 'Expelled from the Guild for a forged chart she did not draw.',
  traits: [
    { id: 'stubborn', value: true },
    { id: 'insight', value: 3 },
    { id: 'accent', value: 'harbour' },
  ],
  conditions: [{ id: 'exhausted' }],
  rulepack: { id: 'narrative-lite', edition: 'core', revision: '2' },
};

const openStores = () => {
  const { database } = openDatabase(IN_MEMORY);
  database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN, CAMPAIGN);
  const entities = createEntityStore(database);
  return { entities, characters: createCharacterStore(entities) };
};

test('persist identity, motivations, background, traits, conditions and rulepack link', () => {
  const { entities, characters } = openStores();
  characters.saveProfile(CAMPAIGN, CHARACTER_ID, PROFILE, PUBLIC);

  assert.deepEqual(characters.getProfile(CAMPAIGN, CHARACTER_ID), PROFILE);
  const entity = entities.getEntity(CAMPAIGN, CHARACTER_ID);
  assert.equal(entity?.kind, CHARACTER_KIND);
  assert.equal(entity?.name, PROFILE.identity.name);
});

test('no second mutable copy of character truth is created by a ui renderer', () => {
  const { characters } = openStores();
  characters.saveProfile(CAMPAIGN, CHARACTER_ID, PROFILE, PUBLIC);
  const view = characters.getProfile(CAMPAIGN, CHARACTER_ID) as CharacterProfile;

  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.identity));
  assert.ok(Object.isFrozen(view.traits[0]));
  assert.throws(() => {
    (view.motivations as string[]).push('betray the crew');
  }, TypeError);
  assert.throws(() => {
    (view.identity as Record<string, string>).name = 'Impostor';
  }, TypeError);
  assert.notEqual(characters.getProfile(CAMPAIGN, CHARACTER_ID), view);
  assert.deepEqual(characters.getProfile(CAMPAIGN, CHARACTER_ID), PROFILE);
});

test('a narrative-only profile with no traits or conditions is valid', () => {
  const { characters } = openStores();
  const sparse = { ...PROFILE, traits: [], conditions: [] };
  characters.saveProfile(CAMPAIGN, CHARACTER_ID, sparse, PUBLIC);
  assert.deepEqual(characters.getProfile(CAMPAIGN, CHARACTER_ID), sparse);
});

test('rejects an invalid profile with structured issues and stores nothing', () => {
  const { characters } = openStores();
  const invalid = {
    identity: { name: '' },
    motivations: 'revenge',
    background: 7,
    traits: [{ id: 'x', value: { nested: true } }],
    conditions: [{}],
    rulepack: { id: 'narrative-lite' },
  };
  assert.throws(
    () => characters.saveProfile(CAMPAIGN, CHARACTER_ID, invalid, PUBLIC),
    (error: unknown) =>
      error instanceof InvalidCharacterProfileError &&
      JSON.stringify(error.issues.map(({ path }) => path)) ===
        JSON.stringify([
          'identity.name',
          'motivations',
          'background',
          'traits[0].value',
          'conditions[0].id',
          'rulepack.edition',
          'rulepack.revision',
        ]),
  );
  assert.equal(characters.getProfile(CAMPAIGN, CHARACTER_ID), undefined);
});

test('rejects actor-scoped visibility with a structured issue', () => {
  const { characters } = openStores();
  assert.throws(
    () => characters.saveProfile(CAMPAIGN, CHARACTER_ID, PROFILE, 'actor-scoped' as never),
    (error: unknown) => error instanceof InvalidCharacterProfileError && error.issues[0]?.path === 'visibility',
  );
});

test('returns undefined for a non-character entity with the same id', () => {
  const { entities, characters } = openStores();
  entities.saveEntity({
    id: CHARACTER_ID,
    campaignId: CAMPAIGN,
    kind: 'npc',
    name: 'Not a character',
    data: {},
    visibility: PUBLIC,
    actorId: null,
  });
  assert.equal(characters.getProfile(CAMPAIGN, CHARACTER_ID), undefined);
});
