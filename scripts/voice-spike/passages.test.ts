import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANGUAGES, PASSAGE_KINDS, PASSAGES } from './passages.ts';

test('every language has narration, NPC and emotional passages', () => {
  for (const language of LANGUAGES) {
    const kinds = new Set(PASSAGES.filter((p) => p.language === language).map((p) => p.kind));
    assert.deepEqual([...kinds].sort(), [...PASSAGE_KINDS].sort(), language);
  }
});

test('passage ids are unique and texts are not blank', () => {
  assert.equal(new Set(PASSAGES.map((p) => p.id)).size, PASSAGES.length);
  for (const passage of PASSAGES) assert.ok(passage.text.trim().length > 0, passage.id);
});

test('there is more than one short NPC line per language', () => {
  for (const language of LANGUAGES) {
    assert.ok(PASSAGES.filter((p) => p.language === language && p.kind === 'npc').length > 1, language);
  }
});
