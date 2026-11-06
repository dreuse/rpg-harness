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

test('rpg-42a.53: usage, settings and budget lines read in Brazilian Portuguese', () => {
  const gm = {
    settings: { model: 'haiku', sessionBudgetTokens: 1500, rulesStrictness: 'relaxed' as const },
    session: SESSION,
    campaign: SESSION,
  };
  const text = gmUsageLines(gm, 'pt-BR').join('\n');
  assert.match(text, /Modelo do mestre: haiku \(mais barato e rápido\)\. Modelo de resumo: um padrão barato\./);
  assert.match(text, /Rigor das regras: relaxed\./);
  assert.match(
    text,
    /Esta sessão: 2 turnos do mestre, 1\.700 tokens \(1\.000 de entrada, 400 de leitura de cache, 100 de escrita de cache, 200 de saída\), US\$\s0,0123\./,
  );
  assert.match(
    budgetWarning(gm, 'pt-BR') ?? '',
    /Esta sessão usou mais do que o limite de 1\.500 tokens\. O jogo continua\./,
  );
  assert.match(gmSettingsLines(gm.settings, 'pt-BR').join('\n'), /Limite da sessão: 1\.500 tokens, só um aviso\./);
  assert.match(
    gmUsageLines(
      { settings: {}, session: EMPTY_GM_USAGE_TOTALS, campaign: { ...SESSION, pricedTurns: 1 } },
      'pt-BR',
    ).join('\n'),
    /em 1 turno com preço/,
  );
  assert.match(gmUsageLines({ ...gm, contextTight: true }, 'pt-BR').join('\n'), /memória rica/);
  assert.equal(
    gmUsageLines(gm, 'pt-BR', false).some((line) => line.startsWith('Esta sessão:')),
    false,
  );
});

test('rpg-42a.51: usage, settings and budget lines read in Spanish', () => {
  const gm = {
    settings: { model: 'haiku', sessionBudgetTokens: 1500 },
    session: SESSION,
    campaign: { ...SESSION, pricedTurns: 1 },
  };
  const text = gmUsageLines({ ...gm, contextTight: true }, 'es').join('\n');
  assert.match(text, /Modelo del GM: haiku \(más barato y rápido\)\. Modelo de resumen: uno barato por defecto\./);
  assert.match(text, /Esta sesión: 2 turnos del GM, 1700 tokens/);
  assert.match(text, /Esta campaña: .*en 1 turno con precio/);
  assert.match(text, /Esta sesión usó más del presupuesto de 1500 tokens\. El juego continúa\./);
  assert.match(text, /memoria rica/);
  assert.match(text, /0,0123\sUS\$/);
  assert.match(
    gmUsageLines({ settings: {}, session: { ...SESSION, inputTokens: 12345 }, campaign: SESSION }, 'es').join('\n'),
    /13\.045 tokens \(12\.345 de entrada/,
  );
  assert.match(gmSettingsLines(gm.settings, 'es').join('\n'), /Presupuesto de la sesión: 1500 tokens, solo un aviso\./);
});

test('rpg-42a.51: unknown locales keep the English usage lines', () => {
  const gm = { settings: { model: 'haiku' }, session: SESSION, campaign: SESSION };
  assert.deepEqual(gmUsageLines(gm, 'fr'), gmUsageLines(gm));
});
