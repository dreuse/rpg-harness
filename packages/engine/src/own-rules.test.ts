import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULES_DOCUMENT_ADDED } from '../../domain/src/campaign.ts';
import {
  isRulesDocument,
  MAX_CONDENSED_SECTIONS,
  MAX_RULES_DOCUMENT_CHARS,
  rulesDocumentsOf,
  settingDocumentsOf,
  usesOwnRules,
} from './own-rules.ts';

const DOCUMENT = { name: 'house.md', format: 'markdown', sourceHash: 'a'.repeat(64), text: 'Rules text.' };

test('rpg-42a.73 a rules document may omit its style', () => {
  assert.equal(isRulesDocument(DOCUMENT), true);
});

test('rpg-42a.73 a rules document accepts a valid style and rejects an invalid one', () => {
  assert.equal(isRulesDocument({ ...DOCUMENT, style: { tone: ['wry'] } }), true);
  assert.equal(isRulesDocument({ ...DOCUMENT, style: { tone: 'wry' } }), false);
  assert.equal(isRulesDocument({ ...DOCUMENT, style: { colour: ['red'] } }), false);
});

const CONDENSED = { summary: 'Sum', sections: [{ title: 'Intro', text: 'Body' }] };

test('rpg-42a.139 a rules document carries an optional persisted condensed ruleset', () => {
  assert.equal(isRulesDocument({ ...DOCUMENT, condensed: CONDENSED }), true);
});

test('rpg-42a.139 a setting document is not a rules document', () => {
  const setting = { ...DOCUMENT, kind: 'setting' };
  const events = [{ type: RULES_DOCUMENT_ADDED, payload: { document: setting } }];
  assert.equal(isRulesDocument(setting), true);
  assert.equal(isRulesDocument({ ...DOCUMENT, kind: 'lore' }), false);
  assert.equal(usesOwnRules(events), false);
  assert.equal(rulesDocumentsOf(events).length, 0);
  assert.equal(settingDocumentsOf(events).length, 1);
});

test('rpg-42a.139 an oversized or invalid condensed is dropped without invalidating the document', () => {
  const bulky = { summary: '', sections: [{ title: 't', text: 'x'.repeat(MAX_RULES_DOCUMENT_CHARS * 2) }] };
  const many = {
    summary: '',
    sections: Array.from({ length: MAX_CONDENSED_SECTIONS + 1 }, () => ({ title: 't', text: 'x' })),
  };
  for (const condensed of [bulky, many, { summary: 1, sections: [] }]) {
    const document = { ...DOCUMENT, condensed };
    const events = [{ type: RULES_DOCUMENT_ADDED, payload: { document } }];
    assert.equal(isRulesDocument(document), true);
    assert.equal(rulesDocumentsOf(events)[0]?.condensed, undefined);
  }
  const kept = [{ type: RULES_DOCUMENT_ADDED, payload: { document: { ...DOCUMENT, condensed: CONDENSED } } }];
  assert.deepEqual(rulesDocumentsOf(kept)[0]?.condensed, CONDENSED);
});
