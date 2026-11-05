import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_STYLE_ITEM_LENGTH, MAX_STYLE_ITEMS, toStyle } from './style.ts';

const STYLE = {
  tone: ['heroic', 'wry'],
  voice: ['second person'],
  vocabulary: ['steel', 'torchlight'],
  pacing: ['short scenes'],
  sceneStructure: ['hook, obstacle, choice'],
  keepOutOfProse: ['raw DCs'],
};

test('rpg-42a.58: a style keeps its known lists as plain text', () => {
  assert.deepEqual(toStyle(STYLE), STYLE);
  assert.deepEqual(toStyle({ tone: ['grim'] }), { tone: ['grim'] });
  assert.deepEqual(toStyle({}), {});
});

test('rpg-42a.58: a style rejects unknown keys, non-lists, empty or oversized text', () => {
  assert.equal(toStyle('grim'), undefined);
  assert.equal(toStyle({ mood: ['grim'] }), undefined);
  assert.equal(toStyle({ tone: 'grim' }), undefined);
  assert.equal(toStyle({ tone: [''] }), undefined);
  assert.equal(toStyle({ tone: [3] }), undefined);
  assert.equal(toStyle({ tone: ['x'.repeat(MAX_STYLE_ITEM_LENGTH + 1)] }), undefined);
  assert.equal(toStyle({ tone: Array.from({ length: MAX_STYLE_ITEMS + 1 }, () => 'x') }), undefined);
});
