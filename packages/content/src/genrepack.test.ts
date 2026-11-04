import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GENREPACK_CONTRACT_VERSION, loadGenrePack } from './genrepack.ts';

const validPack = () => ({
  contractVersion: GENREPACK_CONTRACT_VERSION,
  id: 'noir',
  version: '1.0.0',
  name: 'Rain-soaked noir',
  archetypes: [{ id: 'detective', name: 'Detective', summary: 'Burned-out investigator' }],
  narrativeConstraints: ['No supernatural events'],
  examples: ['The rain had not stopped for three days.'],
  visualConventions: ['High-contrast monochrome'],
  suggestedCapabilities: ['investigation', 'social'],
});

const issuePaths = (input: unknown) => {
  const result = loadGenrePack(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

test('load versioned thematic templates independently of the rulepack mechanics', () => {
  const result = loadGenrePack(validPack());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pack.id, 'noir');
    assert.deepEqual(result.pack.suggestedCapabilities, ['investigation', 'social']);
  }
});

test('returns a frozen deep copy of the input', () => {
  const input = validPack();
  const result = loadGenrePack(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.pack.archetypes, input.archetypes);
  assert.equal(Object.isFrozen(result.pack), true);
  assert.equal(Object.isFrozen(result.pack.archetypes[0]), true);
  assert.equal(Object.isFrozen(result.pack.suggestedCapabilities), true);
  input.narrativeConstraints.push('late edit');
  assert.deepEqual(result.pack.narrativeConstraints, ['No supernatural events']);
});

test('reads optional required rule capabilities and rejects non-string entries', () => {
  const loaded = loadGenrePack({ ...validPack(), requiredRuleCapabilities: ['checks'] });
  assert.equal(loaded.ok && loaded.pack.requiredRuleCapabilities?.[0], 'checks');
  assert.equal(loaded.ok && Object.isFrozen(loaded.pack.requiredRuleCapabilities), true);
  const plain = loadGenrePack(validPack());
  assert.equal(plain.ok && Object.hasOwn(plain.pack, 'requiredRuleCapabilities'), false);
  assert.deepEqual(issuePaths({ ...validPack(), requiredRuleCapabilities: ['checks', 1] }), [
    'requiredRuleCapabilities.1',
  ]);
});

test('rejects non-objects and non-plain objects', () => {
  assert.deepEqual(issuePaths(null), ['']);
  assert.deepEqual(issuePaths([]), ['']);
  assert.deepEqual(issuePaths(new Map()), ['']);
});

test('rejects a wrong contract version', () => {
  assert.deepEqual(issuePaths({ ...validPack(), contractVersion: 99 }), ['contractVersion']);
});

test('rejects missing and empty strings', () => {
  const { id: _id, ...withoutId } = validPack();
  assert.deepEqual(issuePaths(withoutId), ['id']);
  assert.deepEqual(issuePaths({ ...validPack(), name: '' }), ['name']);
  assert.deepEqual(issuePaths({ ...validPack(), version: '' }), ['version']);
});

test('genre packs cannot execute arbitrary code or mutate engine schemas', () => {
  for (const key of ['eval', 'script', 'code', 'schema', 'characterSheetSchemaId', 'capabilities']) {
    assert.deepEqual(issuePaths({ ...validPack(), [key]: 'x' }), [key]);
  }
});

test('rejects __proto__ keys parsed from JSON', () => {
  const polluted = JSON.parse(`{"__proto__": {"polluted": true}, "id": "x"}`);
  assert.ok(issuePaths(polluted).includes('__proto__'));
  assert.equal(loadGenrePack(polluted).ok, false);
  assert.equal('polluted' in ({} as Record<string, unknown>), false);
});

test('reads each top-level string field once', () => {
  for (const field of ['id', 'version', 'name']) {
    const input = validPack();
    let reads = 0;
    Object.defineProperty(input, field, { enumerable: true, get: () => (reads++ === 0 ? 'ok' : { evil: true }) });
    const result = loadGenrePack(input);
    if (result.ok) assert.equal(typeof result.pack[field as 'id' | 'version' | 'name'], 'string');
    assert.equal(reads, 1);
  }
});

test('rejects functions and nested unknown fields', () => {
  assert.deepEqual(issuePaths({ ...validPack(), examples: [() => 'x'] }), ['examples.0']);
  assert.deepEqual(issuePaths({ ...validPack(), archetypes: [{ id: 'a', name: 'A', summary: 's', run: 'x' }] }), [
    'archetypes.0.run',
  ]);
  assert.deepEqual(issuePaths({ ...validPack(), archetypes: [{ id: 'a', name: '', summary: 's' }] }), [
    'archetypes.0.name',
  ]);
});

test('rejects non-string suggested capabilities', () => {
  assert.deepEqual(issuePaths({ ...validPack(), suggestedCapabilities: [{ combat: true }] }), [
    'suggestedCapabilities.0',
  ]);
  assert.deepEqual(issuePaths({ ...validPack(), suggestedCapabilities: 'combat' }), ['suggestedCapabilities']);
});
