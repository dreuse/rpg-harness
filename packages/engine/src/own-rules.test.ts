import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRulesDocument } from './own-rules.ts';

const DOCUMENT = { name: 'house.md', format: 'markdown', sourceHash: 'a'.repeat(64), text: 'Rules text.' };

test('rpg-42a.73 a rules document may omit its style', () => {
  assert.equal(isRulesDocument(DOCUMENT), true);
});

test('rpg-42a.73 a rules document accepts a valid style and rejects an invalid one', () => {
  assert.equal(isRulesDocument({ ...DOCUMENT, style: { tone: ['wry'] } }), true);
  assert.equal(isRulesDocument({ ...DOCUMENT, style: { tone: 'wry' } }), false);
  assert.equal(isRulesDocument({ ...DOCUMENT, style: { colour: ['red'] } }), false);
});
