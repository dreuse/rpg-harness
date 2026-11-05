import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES_STRICTNESS, RULES_STRICTNESSES, rulesStrictnessOf } from './rules-usage.ts';

test('rpg-42a.58: strictness defaults to as-written only when the campaign has a RulePack', () => {
  assert.deepEqual(RULES_STRICTNESSES, ['as-written', 'relaxed', 'off']);
  assert.equal(DEFAULT_RULES_STRICTNESS, 'as-written');
  assert.equal(rulesStrictnessOf(undefined, true), 'as-written');
  assert.equal(rulesStrictnessOf(undefined, false), 'off');
});

test('rpg-42a.58: a chosen strictness wins over the default, with or without a RulePack', () => {
  assert.equal(rulesStrictnessOf('relaxed', true), 'relaxed');
  assert.equal(rulesStrictnessOf('off', true), 'off');
  assert.equal(rulesStrictnessOf('as-written', false), 'as-written');
});
