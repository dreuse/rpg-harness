export const MODEL_NAME = /^[A-Za-z0-9][\w.:@/[\]-]{0,127}$/;
export const ROUTE_DEFAULT_MODEL = 'default';

export interface GmSettings {
  readonly model?: string;
  readonly summaryModel?: string;
  readonly sessionBudgetTokens?: number;
}

export interface GmUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export interface GmUsageTotals {
  readonly turns: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly pricedTurns: number;
}

export const EMPTY_GM_USAGE_TOTALS: GmUsageTotals = {
  turns: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  pricedTurns: 0,
};

const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;
const ONE_TURN = 1;
const NO_TURN = 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isModel = (value: unknown): value is string => typeof value === 'string' && MODEL_NAME.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const optional = <T>(value: unknown, valid: (value: unknown) => value is T): { ok: boolean; value?: T } =>
  value === undefined ? { ok: true } : valid(value) ? { ok: true, value } : { ok: false };

export const toGmSettings = (value: unknown): GmSettings | undefined => {
  if (!isRecord(value)) return undefined;
  const model = optional(value.model, isModel);
  const summaryModel = optional(value.summaryModel, isModel);
  const budget = optional(value.sessionBudgetTokens, isCount);
  if (!model.ok || !summaryModel.ok || !budget.ok || budget.value === 0) return undefined;
  return {
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(summaryModel.value === undefined ? {} : { summaryModel: summaryModel.value }),
    ...(budget.value === undefined ? {} : { sessionBudgetTokens: budget.value }),
  };
};

export const toGmUsage = (value: unknown): GmUsage | undefined => {
  if (!isRecord(value) || !isModel(value.model) || !TOKEN_FIELDS.every((field) => isCount(value[field])))
    return undefined;
  const cost = optional(value.costUsd, isCost);
  if (!cost.ok) return undefined;
  return {
    model: value.model,
    ...(Object.fromEntries(TOKEN_FIELDS.map((field) => [field, value[field]])) as Record<
      (typeof TOKEN_FIELDS)[number],
      number
    >),
    ...(cost.value === undefined ? {} : { costUsd: cost.value }),
  };
};

export const addGmUsage = (totals: GmUsageTotals, usage: GmUsage): GmUsageTotals => ({
  turns: totals.turns + ONE_TURN,
  inputTokens: totals.inputTokens + usage.inputTokens,
  cacheReadTokens: totals.cacheReadTokens + usage.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens + usage.cacheWriteTokens,
  outputTokens: totals.outputTokens + usage.outputTokens,
  costUsd: totals.costUsd + (usage.costUsd ?? 0),
  pricedTurns: totals.pricedTurns + (usage.costUsd === undefined ? NO_TURN : ONE_TURN),
});
