import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGenrePack } from './genrepack.ts';
import { BLANK_WORLD_PACK, MODERN_ADVENTURE_PACK } from './packs.ts';

const FORCED_TERMS = /class|combat|supernatural|magic/i;

const loadPack = (input: unknown) => {
  const result = loadGenrePack(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('pack failed to load');
  return result.pack;
};

test('support grounded modern stories and entirely user-defined settings', () => {
  const modern = loadPack(MODERN_ADVENTURE_PACK.genre);
  assert.equal(modern.id, 'modern-adventure');
  assert.ok(modern.archetypes.length > 0);
  assert.ok(modern.narrativeConstraints.some((constraint) => /grounded/i.test(constraint)));
  assert.equal(FORCED_TERMS.test(JSON.stringify(modern.suggestedCapabilities)), false);

  const userWorld = loadPack({
    ...BLANK_WORLD_PACK.genre,
    id: 'user-floating-isles',
    name: 'Floating isles',
    archetypes: [{ id: 'sky-courier', name: 'Sky courier', summary: 'Carries letters between drifting islands' }],
    narrativeConstraints: ['Islands never collide'],
    suggestedCapabilities: ['travel'],
  });
  assert.equal(userWorld.name, 'Floating isles');
  assert.deepEqual(userWorld.suggestedCapabilities, ['travel']);
});

test('blank world does not force classes, combat or supernatural elements', () => {
  const blank = loadPack(BLANK_WORLD_PACK.genre);
  assert.equal(blank.id, 'blank-world');
  assert.deepEqual(blank.archetypes, []);
  assert.deepEqual(blank.narrativeConstraints, []);
  assert.deepEqual(blank.examples, []);
  assert.deepEqual(blank.visualConventions, []);
  assert.deepEqual(blank.suggestedCapabilities, []);
  assert.equal(FORCED_TERMS.test(JSON.stringify(blank)), false);
  assert.deepEqual(Object.keys(BLANK_WORLD_PACK), ['genre']);
});
