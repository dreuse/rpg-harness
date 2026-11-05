import { type GmSettings, type GmUsageTotals, ROUTE_DEFAULT_MODEL } from '../../domain/src/gm.ts';
import type { GmSnapshot } from './protocol.ts';

export const DEFAULT_MODEL_CHOICE = ROUTE_DEFAULT_MODEL;
export const GM_MODEL_CHOICES = [DEFAULT_MODEL_CHOICE, 'haiku', 'sonnet', 'opus', 'fable'] as const;
export const GM_MODEL_HINTS = ['default', 'cheap', 'balanced', 'rich', 'custom'] as const;
export type GmModelHint = (typeof GM_MODEL_HINTS)[number];

export const MODEL_HINT_TEXT: Readonly<Record<GmModelHint, string>> = {
  default: 'the route picks its usual model',
  cheap: 'cheaper and faster',
  balanced: 'balanced cost and detail',
  rich: 'richer narration, costs more',
  custom: 'a model id sent as is',
};

const HINT_PATTERNS: readonly (readonly [RegExp, GmModelHint])[] = [
  [/haiku/i, 'cheap'],
  [/sonnet/i, 'balanced'],
  [/opus|fable/i, 'rich'],
];
const COST_DIGITS = 4;
type GmUsageView = Pick<GmSnapshot, 'settings' | 'session' | 'campaign'>;

export const modelHintOf = (model: string | undefined): GmModelHint =>
  model === undefined || model === DEFAULT_MODEL_CHOICE
    ? 'default'
    : (HINT_PATTERNS.find(([pattern]) => pattern.test(model))?.[1] ?? 'custom');

export const tokensOf = ({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }: GmUsageTotals) =>
  inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;

export const costText = ({ turns, pricedTurns, costUsd }: GmUsageTotals) =>
  pricedTurns === 0
    ? 'cost not reported'
    : `$${costUsd.toFixed(COST_DIGITS)}${pricedTurns < turns ? ` for ${pricedTurns} priced turns` : ''}`;

const usageText = (label: string, totals: GmUsageTotals) =>
  `${label}: ${totals.turns} GM turns, ${tokensOf(totals)} tokens (${totals.inputTokens} in, ${totals.cacheReadTokens} cache read, ${totals.cacheWriteTokens} cache write, ${totals.outputTokens} out), ${costText(totals)}.`;

export const overBudget = ({ settings, session }: GmUsageView) =>
  settings.sessionBudgetTokens !== undefined && tokensOf(session) > settings.sessionBudgetTokens;

export const budgetWarning = (gm: GmUsageView | undefined) =>
  gm !== undefined && overBudget(gm)
    ? `This session used more than the ${gm.settings.sessionBudgetTokens} token budget. Play goes on.`
    : undefined;

export const gmModelLine = ({ model = DEFAULT_MODEL_CHOICE, summaryModel }: GmSettings) =>
  `GM model: ${model} (${MODEL_HINT_TEXT[modelHintOf(model)]}). Summary model: ${summaryModel ?? 'a cheap default'}.`;

const budgetLine = (budget: number) => `Session budget: ${budget} tokens, a warning only.`;

export const gmSettingsLines = (settings: GmSettings): string[] => [
  gmModelLine(settings),
  ...(settings.sessionBudgetTokens === undefined ? [] : [budgetLine(settings.sessionBudgetTokens)]),
];

export const gmUsageLines = (gm: GmUsageView): string[] => {
  const budget = gm.settings.sessionBudgetTokens;
  return [
    gmModelLine(gm.settings),
    usageText('This session', gm.session),
    usageText('This campaign', gm.campaign),
    ...(budget === undefined ? [] : [budgetWarning(gm) ?? budgetLine(budget)]),
  ];
};
