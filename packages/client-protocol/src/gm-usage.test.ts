import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_GM_USAGE_TOTALS } from '../../domain/src/gm.ts';
import { budgetWarning, CONTEXT_HINT, gmSettingsLines, gmUsageLines, modelHintOf, tokensOf } from './gm-usage.ts';

const SESSION = {
  turns: 2,
  inputTokens: 1000,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
  outputTokens: 200,
  costUsd: 0.0123,
  pricedTurns: 2,
};

test('rpg-42a.37: each model gets a short cost hint, api ids by family', () => {
  assert.equal(modelHintOf(undefined), 'default');
  assert.equal(modelHintOf('default'), 'default');
  assert.equal(modelHintOf('haiku'), 'cheap');
  assert.equal(modelHintOf('claude-haiku-5-5'), 'cheap');
  assert.equal(modelHintOf('sonnet'), 'balanced');
  assert.equal(modelHintOf('opus'), 'rich');
  assert.equal(modelHintOf('fable'), 'rich');
  assert.equal(modelHintOf('my-model'), 'custom');
});

test('rpg-42a.37: usage reads in plain words and the soft budget only warns', () => {
  const gm = { settings: { model: 'haiku', sessionBudgetTokens: 1500 }, session: SESSION, campaign: SESSION };
  assert.equal(tokensOf(SESSION), 1700);
  const lines = gmUsageLines(gm);
  assert.match(lines.join('\n'), /GM model: haiku \(cheaper and faster\)/);
  assert.match(lines.join('\n'), /This session: 2 GM turns, 1700 tokens .*\$0\.0123/);
  assert.match(budgetWarning(gm) ?? '', /more than the 1500 token budget/);
  assert.equal(budgetWarning({ ...gm, settings: { sessionBudgetTokens: 5000 } }), undefined);
  assert.equal(budgetWarning(undefined), undefined);
  const unpriced = gmUsageLines({
    settings: {},
    session: EMPTY_GM_USAGE_TOTALS,
    campaign: { ...SESSION, pricedTurns: 0 },
  });
  assert.match(unpriced.join('\n'), /cost not reported/);
});

test('rpg-42a.44: the memory hint shows only when facts are dropped often', () => {
  const gm = { settings: {}, session: SESSION, campaign: SESSION };
  assert.equal(gmUsageLines(gm).includes(CONTEXT_HINT), false);
  assert.equal(gmUsageLines({ ...gm, contextTight: false }).includes(CONTEXT_HINT), false);
  assert.equal(gmUsageLines({ ...gm, contextTight: true }).includes(CONTEXT_HINT), true);
  assert.match(CONTEXT_HINT, /consider the rich memory setting/i);
});

test('rpg-42a.58: a chosen rules strictness shows in the settings and usage lines, an unset one does not', () => {
  const gm = { settings: { rulesStrictness: 'relaxed' as const }, session: SESSION, campaign: SESSION };
  assert.match(gmUsageLines(gm).join('\n'), /Rules strictness: relaxed/);
  assert.match(gmSettingsLines(gm.settings).join('\n'), /Rules strictness: relaxed/);
  assert.doesNotMatch(gmUsageLines({ ...gm, settings: {} }).join('\n'), /Rules strictness/);
});
