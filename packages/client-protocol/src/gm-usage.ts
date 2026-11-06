import { type GmSettings, type GmUsageTotals, ROUTE_DEFAULT_MODEL } from '../../domain/src/gm.ts';
import { type Catalog, createTranslator, DEFAULT_LOCALE } from './locale.ts';
import type { GmSnapshot } from './protocol.ts';

export const DEFAULT_MODEL_CHOICE = ROUTE_DEFAULT_MODEL;
export const GM_MODEL_CHOICES = [DEFAULT_MODEL_CHOICE, 'haiku', 'sonnet', 'opus', 'fable'] as const;
export const GM_MODEL_HINTS = ['default', 'cheap', 'balanced', 'rich', 'custom'] as const;
export type GmModelHint = (typeof GM_MODEL_HINTS)[number];

const HINT_PATTERNS: readonly (readonly [RegExp, GmModelHint])[] = [
  [/haiku/i, 'cheap'],
  [/sonnet/i, 'balanced'],
  [/opus|fable/i, 'rich'],
];
const COST_DIGITS = 4;
const CURRENCY = 'USD';

export const GM_USAGE_CATALOG: Catalog = {
  en: {
    'hint.default': 'balanced (recommended): quality, creativity and speed',
    'hint.cheap': 'cheaper and faster',
    'hint.balanced': 'balanced cost and detail',
    'hint.rich': 'richer narration, costs more',
    'hint.custom': 'a model id sent as is',
    'model.line': 'GM model: {model} ({hint}). Summary model: {summary}.',
    'model.summaryDefault': 'a cheap default',
    'rules.line': 'Rules strictness: {value}.',
    'budget.line': 'Session budget: {tokens} tokens, a warning only.',
    'budget.warning': 'This session used more than the {tokens} token budget. Play goes on.',
    'context.hint': 'Story facts were often left out of the GM context. Consider the rich memory setting.',
    'cost.unreported': 'cost not reported',
    'cost.partial.other': '{cost} for {priced} priced turns',
    'usage.session': 'This session',
    'usage.campaign': 'This campaign',
    'usage.line':
      '{label}: {turns} GM turns, {total} tokens ({input} in, {read} cache read, {write} cache write, {output} out), {cost}.',
  },
  'pt-BR': {
    'hint.default': 'equilibrado (recomendado): qualidade, criatividade e velocidade',
    'hint.cheap': 'mais barato e rápido',
    'hint.balanced': 'custo e detalhe equilibrados',
    'hint.rich': 'narração mais rica, custa mais',
    'hint.custom': 'um id de modelo enviado como está',
    'model.line': 'Modelo do mestre: {model} ({hint}). Modelo de resumo: {summary}.',
    'model.summaryDefault': 'um padrão barato',
    'rules.line': 'Rigor das regras: {value}.',
    'budget.line': 'Limite da sessão: {tokens} tokens, só um aviso.',
    'budget.warning': 'Esta sessão usou mais do que o limite de {tokens} tokens. O jogo continua.',
    'context.hint': 'Fatos da história ficaram de fora do contexto do mestre várias vezes. Considere a memória rica.',
    'cost.unreported': 'custo não informado',
    'cost.partial.one': '{cost} em {priced} turno com preço',
    'cost.partial.other': '{cost} em {priced} turnos com preço',
    'usage.session': 'Esta sessão',
    'usage.campaign': 'Esta campanha',
    'usage.line':
      '{label}: {turns} turnos do mestre, {total} tokens ({input} de entrada, {read} de leitura de cache, {write} de escrita de cache, {output} de saída), {cost}.',
  },
};

const text = createTranslator(GM_USAGE_CATALOG);
const translated = (locale: string) => locale !== DEFAULT_LOCALE && Object.hasOwn(GM_USAGE_CATALOG, locale);
const count = (locale: string, value: number) =>
  translated(locale) ? new Intl.NumberFormat(locale).format(value) : String(value);
const money = (locale: string, value: number) =>
  translated(locale)
    ? new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: CURRENCY,
        minimumFractionDigits: COST_DIGITS,
        maximumFractionDigits: COST_DIGITS,
      }).format(value)
    : `$${value.toFixed(COST_DIGITS)}`;

export const CONTEXT_HINT = text(DEFAULT_LOCALE, 'context.hint');
type GmUsageView = Pick<GmSnapshot, 'settings' | 'session' | 'campaign' | 'contextTight'>;

export const modelHintOf = (model: string | undefined): GmModelHint =>
  model === undefined || model === DEFAULT_MODEL_CHOICE
    ? 'default'
    : (HINT_PATTERNS.find(([pattern]) => pattern.test(model))?.[1] ?? 'custom');

export const tokensOf = ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }: GmUsageTotals) =>
  inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;

export const costText = ({ turns, pricedTurns, costUsd }: GmUsageTotals, locale = DEFAULT_LOCALE) => {
  if (pricedTurns === 0) return text(locale, 'cost.unreported');
  const cost = money(locale, costUsd);
  return pricedTurns < turns ? text(locale, 'cost.partial', { cost, priced: pricedTurns, count: pricedTurns }) : cost;
};

const usageText = (labelKey: string, totals: GmUsageTotals, locale: string) =>
  text(locale, 'usage.line', {
    label: text(locale, labelKey),
    turns: count(locale, totals.turns),
    total: count(locale, tokensOf(totals)),
    input: count(locale, totals.inputTokens),
    read: count(locale, totals.cacheReadTokens),
    write: count(locale, totals.cacheWriteTokens),
    output: count(locale, totals.outputTokens),
    cost: costText(totals, locale),
  });

export const overBudget = ({ settings, session }: GmUsageView) =>
  settings.sessionBudgetTokens !== undefined && tokensOf(session) > settings.sessionBudgetTokens;

export const budgetWarning = (gm: GmUsageView | undefined, locale = DEFAULT_LOCALE) =>
  gm !== undefined && overBudget(gm)
    ? text(locale, 'budget.warning', { tokens: count(locale, gm.settings.sessionBudgetTokens ?? 0) })
    : undefined;

export const gmModelLine = ({ model = DEFAULT_MODEL_CHOICE, summaryModel }: GmSettings, locale = DEFAULT_LOCALE) =>
  text(locale, 'model.line', {
    model,
    hint: text(locale, `hint.${modelHintOf(model)}`),
    summary: summaryModel ?? text(locale, 'model.summaryDefault'),
  });

const budgetLine = (budget: number, locale: string) => text(locale, 'budget.line', { tokens: count(locale, budget) });

const rulesLines = ({ rulesStrictness }: GmSettings, locale: string) =>
  rulesStrictness === undefined ? [] : [text(locale, 'rules.line', { value: rulesStrictness })];

export const gmSettingsLines = (settings: GmSettings, locale = DEFAULT_LOCALE): string[] => [
  gmModelLine(settings, locale),
  ...rulesLines(settings, locale),
  ...(settings.sessionBudgetTokens === undefined ? [] : [budgetLine(settings.sessionBudgetTokens, locale)]),
];

export const gmUsageLines = (gm: GmUsageView, locale = DEFAULT_LOCALE, withSession = true): string[] => {
  const budget = gm.settings.sessionBudgetTokens;
  return [
    gmModelLine(gm.settings, locale),
    ...rulesLines(gm.settings, locale),
    ...(withSession ? [usageText('usage.session', gm.session, locale)] : []),
    usageText('usage.campaign', gm.campaign, locale),
    ...(budget === undefined ? [] : [budgetWarning(gm, locale) ?? budgetLine(budget, locale)]),
    ...(gm.contextTight ? [text(locale, 'context.hint')] : []),
  ];
};
