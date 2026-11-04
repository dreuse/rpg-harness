import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CharacterProfile, parseCharacterProfile } from './character.ts';

const PROFILE: CharacterProfile = {
  identity: { name: 'Mara Quill' },
  motivations: ['map the coast'],
  background: 'Cartographer.',
  traits: [{ id: 'insight', value: 3 }],
  conditions: [{ id: 'exhausted' }],
  rulepack: { id: 'narrative-lite', edition: 'core', revision: '2' },
};

const issuePaths = (input: unknown) => {
  const result = parseCharacterProfile(input);
  return result.ok ? [] : result.issues.map(({ path }) => path);
};

class Identity {
  name = 'Mara';
}

test('rejects motivations with holes', () => {
  const motivations = ['a', 'b'];
  delete motivations[0];
  assert.deepEqual(issuePaths({ ...PROFILE, motivations }), ['motivations']);
});

test('rejects an inherited identity name', () => {
  assert.deepEqual(issuePaths({ ...PROFILE, identity: Object.create({ name: 'Mara' }) }), ['identity']);
});

test('rejects class instances and dates as records', () => {
  assert.deepEqual(issuePaths({ ...PROFILE, identity: new Identity() }), ['identity']);
  assert.deepEqual(issuePaths({ ...PROFILE, rulepack: new Date() }), ['rulepack']);
  assert.deepEqual(issuePaths({ ...PROFILE, traits: [new Date()] }), ['traits[0]']);
  assert.deepEqual(issuePaths({ ...PROFILE, conditions: [new Identity()] }), ['conditions[0]']);
});

test('rejects inherited trait and rulepack fields', () => {
  const trait = Object.assign(Object.create(null), { id: 'x' });
  Object.setPrototypeOf(trait, { value: 1 });
  assert.deepEqual(issuePaths({ ...PROFILE, traits: [trait] }), ['traits[0]']);
  const rulepack = Object.assign(Object.create(null), { id: 'p', edition: 'e', revision: '1' });
  assert.deepEqual(issuePaths({ ...PROFILE, rulepack }), []);
});

test('reads each identity field once', () => {
  let reads = 0;
  const identity = {
    get name() {
      reads += 1;
      return reads === 1 ? 'Mara' : '';
    },
  };
  const result = parseCharacterProfile({ ...PROFILE, identity });
  assert.ok(result.ok);
  assert.equal(result.profile.identity.name, 'Mara');
  assert.equal(reads, 1);
});

test('rejects duplicate trait and condition ids', () => {
  const traits = [...PROFILE.traits, { id: 'insight', value: 4 }];
  const conditions = [...PROFILE.conditions, { id: 'exhausted' }];
  assert.deepEqual(issuePaths({ ...PROFILE, traits, conditions }), ['traits[1].id', 'conditions[1].id']);
});
