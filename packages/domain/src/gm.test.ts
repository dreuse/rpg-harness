import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addGmUsage, EMPTY_GM_USAGE_TOTALS, toGmSettings, toGmUsage } from './gm.ts';

const USAGE = {
  model: 'sonnet',
  inputTokens: 1200,
  cacheReadTokens: 800,
  cacheWriteTokens: 300,
  outputTokens: 150,
  costUsd: 0.012,
};

test('GM settings keep valid model names and a positive budget only', () => {
  assert.deepEqual(toGmSettings({ model: 'haiku', summaryModel: 'claude-haiku-5-5', sessionBudgetTokens: 50_000 }), {
    model: 'haiku',
    summaryModel: 'claude-haiku-5-5',
    sessionBudgetTokens: 50_000,
  });
  assert.deepEqual(toGmSettings({}), {});
  for (const model of ['claude-sonnet-4@20250514', 'anthropic/claude-x', 'us.anthropic.claude:1'])
    assert.deepEqual(toGmSettings({ model }), { model });
  assert.equal(toGmSettings({ model: '/claude' }), undefined);
  assert.deepEqual(toGmSettings({ model: 'opus', apiKey: 'secret' }), { model: 'opus' });
  assert.equal(toGmSettings({ model: '--dangerously-skip-permissions' }), undefined);
  assert.equal(toGmSettings({ model: 'sonnet; rm -rf /' }), undefined);
  assert.equal(toGmSettings({ sessionBudgetTokens: 0 }), undefined);
  assert.equal(toGmSettings({ sessionBudgetTokens: 1.5 }), undefined);
  assert.equal(toGmSettings('opus'), undefined);
});

test('GM usage needs whole non-negative token counts and an optional cost', () => {
  assert.deepEqual(toGmUsage(USAGE), USAGE);
  const { costUsd: _, ...unpriced } = USAGE;
  assert.deepEqual(toGmUsage(unpriced), unpriced);
  assert.equal(toGmUsage({ ...USAGE, outputTokens: -1 }), undefined);
  assert.equal(toGmUsage({ ...USAGE, inputTokens: '12' }), undefined);
  assert.equal(toGmUsage({ ...USAGE, costUsd: Number.NaN }), undefined);
});

test('GM usage totals add tokens and only the costs that were reported', () => {
  const { costUsd: _, ...unpriced } = USAGE;
  const totals = addGmUsage(addGmUsage(EMPTY_GM_USAGE_TOTALS, USAGE), unpriced);
  assert.deepEqual(totals, {
    turns: 2,
    inputTokens: 2400,
    cacheReadTokens: 1600,
    cacheWriteTokens: 600,
    outputTokens: 300,
    costUsd: 0.012,
    pricedTurns: 1,
  });
});
