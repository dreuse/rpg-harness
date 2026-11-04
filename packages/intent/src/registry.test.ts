import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchGenre, matchRuleset, type Registry } from './registry.ts';

const RULESET_ID = 'fantasy-core';
const INSTALLED_EDITION = '2e';
const OTHER_EDITION = '3e';
const ABSENT_EDITION = '1.9';
const GENRE_ID = 'noir';

const REGISTRY: Registry = {
  rulepacks: [
    {
      id: RULESET_ID,
      edition: INSTALLED_EDITION,
      revision: '1.2.0',
      capabilities: { dice: true, combat: 'adjudicated', magic: false },
      sourceRefs: ['srd:core'],
    },
    { id: RULESET_ID, edition: OTHER_EDITION, revision: '0.1.0', capabilities: {}, sourceRefs: [] },
  ],
  genres: [
    { id: GENRE_ID, version: '1.0.0' },
    { id: GENRE_ID, version: '2.0.0' },
  ],
};

test('N03 match installed rulepack/genre versions and advertised optional capabilities', () => {
  const ruleset = matchRuleset(REGISTRY, { id: RULESET_ID, edition: INSTALLED_EDITION }, ['dice', 'combat', 'magic']);
  assert.ok(ruleset.ok);
  assert.equal(ruleset.rulepack.revision, '1.2.0');
  assert.deepEqual(ruleset.rulepack.sourceRefs, ['srd:core']);
  assert.deepEqual(ruleset.capabilities, {
    advertised: ['dice', 'combat'],
    supported: ['dice', 'combat'],
    unsupported: ['magic'],
  });
  const genre = matchGenre(REGISTRY, { id: GENRE_ID, version: '2.0.0' });
  assert.deepEqual(genre, { ok: true, genre: { id: GENRE_ID, version: '2.0.0' } });
});

test('N03 absent commercial editions are not claimed installed or accurately enforced', () => {
  const requested = { id: RULESET_ID, edition: ABSENT_EDITION };
  assert.deepEqual(matchRuleset(REGISTRY, requested, ['dice']), {
    ok: false,
    code: 'not_installed',
    requested,
    available: [INSTALLED_EDITION, OTHER_EDITION],
  });
  const unknown = { id: 'D&D', edition: '5e' };
  assert.deepEqual(matchRuleset(REGISTRY, unknown, []), {
    ok: false,
    code: 'not_installed',
    requested: unknown,
    available: [],
  });
  assert.deepEqual(matchGenre(REGISTRY, { id: GENRE_ID, version: '3.0.0' }), {
    ok: false,
    code: 'not_installed',
    requested: { id: GENRE_ID, version: '3.0.0' },
    available: ['1.0.0', '2.0.0'],
  });
});

test('N03 unspecified version matches only a sole installed version', () => {
  const ambiguous = { id: RULESET_ID, edition: null };
  assert.deepEqual(matchRuleset(REGISTRY, ambiguous, []), {
    ok: false,
    code: 'ambiguous',
    requested: ambiguous,
    available: [INSTALLED_EDITION, OTHER_EDITION],
  });
  const sole: Registry = { ...REGISTRY, rulepacks: REGISTRY.rulepacks.slice(0, 1) };
  const ruleset = matchRuleset(sole, ambiguous, []);
  assert.ok(ruleset.ok);
  assert.equal(ruleset.rulepack.edition, INSTALLED_EDITION);
});

test('rpg-ljs3 genre names match ids, names and aliases case-insensitively across separators', () => {
  const registry: Registry = {
    rulepacks: [],
    genres: [{ id: 'science-fiction', version: '1.0.0', name: 'Hard Sci-Fi', aliases: ['space_opera'] }],
  };
  for (const id of ['science fiction', 'Science_Fiction', 'SCIENCE-FICTION', 'hard sci fi', 'Space Opera']) {
    const match = matchGenre(registry, { id, version: null });
    assert.equal(match.ok, true, id);
  }
  assert.equal(matchGenre(registry, { id: 'fantasy', version: null }).ok, false);
});
