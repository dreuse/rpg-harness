import { isRulesStrictness, type RulesStrictness } from './rules-usage.ts';

export const MODEL_NAME = /^[A-Za-z0-9][\w.:@/[\]-]{0,127}$/;
export const ROUTE_DEFAULT_MODEL = 'default';
export const WHO_ROLLS = ['app', 'me', 'ask'] as const;
export type WhoRolls = (typeof WHO_ROLLS)[number];
export const DEFAULT_WHO_ROLLS: WhoRolls = 'app';

export interface GmSettings {
  readonly model?: string;
  readonly summaryModel?: string;
  readonly sessionBudgetTokens?: number;
  readonly rulesStrictness?: RulesStrictness;
  readonly whoRolls?: WhoRolls;
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

const isWhoRolls = (value: unknown): value is WhoRolls => WHO_ROLLS.includes(value as WhoRolls);

const optional = <T>(value: unknown, valid: (value: unknown) => value is T): { ok: boolean; value?: T } =>
  value === undefined ? { ok: true } : valid(value) ? { ok: true, value } : { ok: false };

export const toGmSettings = (value: unknown): GmSettings | undefined => {
  if (!isRecord(value)) return undefined;
  const model = optional(value.model, isModel);
  const summaryModel = optional(value.summaryModel, isModel);
  const budget = optional(value.sessionBudgetTokens, isCount);
  const strictness = optional(value.rulesStrictness, isRulesStrictness);
  const whoRolls = optional(value.whoRolls, isWhoRolls);
  if (!model.ok || !summaryModel.ok || !budget.ok || !strictness.ok || !whoRolls.ok || budget.value === 0)
    return undefined;
  return {
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(summaryModel.value === undefined ? {} : { summaryModel: summaryModel.value }),
    ...(budget.value === undefined ? {} : { sessionBudgetTokens: budget.value }),
    ...(strictness.value === undefined ? {} : { rulesStrictness: strictness.value }),
    ...(whoRolls.value === undefined ? {} : { whoRolls: whoRolls.value }),
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

export const GM_USAGE_RECORDED = 'GmUsageRecorded';

export interface GmUsageLedger {
  readonly campaign: GmUsageTotals;
  readonly sessions: Readonly<Record<string, GmUsageTotals>>;
}

export const EMPTY_GM_USAGE_LEDGER: GmUsageLedger = { campaign: EMPTY_GM_USAGE_TOTALS, sessions: {} };

export const recordInLedger = (ledger: GmUsageLedger, payload: Readonly<Record<string, unknown>>): GmUsageLedger => {
  const usage = toGmUsage(payload.usage);
  if (usage === undefined) return ledger;
  const sessionId = String(payload.sessionId);
  return {
    campaign: addGmUsage(ledger.campaign, usage),
    sessions: {
      ...ledger.sessions,
      [sessionId]: addGmUsage(ledger.sessions[sessionId] ?? EMPTY_GM_USAGE_TOTALS, usage),
    },
  };
};

export const ledgerTotals = (ledger: GmUsageLedger, sessionId?: string): GmUsageTotals =>
  sessionId === undefined ? ledger.campaign : (ledger.sessions[sessionId] ?? EMPTY_GM_USAGE_TOTALS);
