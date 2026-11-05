import { randomUUID } from 'node:crypto';
import { type CampaignEvent, type CampaignStore, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import {
  addGmUsage,
  EMPTY_GM_USAGE_TOTALS,
  type GmSettings,
  type GmUsage,
  type GmUsageTotals,
  ROUTE_DEFAULT_MODEL,
  toGmSettings,
  toGmUsage,
} from '../../domain/src/gm.ts';
import type { ContextPacket } from '../../memory/src/packet.ts';
import { InvalidActionError } from './turn.ts';

export const GM_SETTINGS_SAVED = 'GmSettingsSaved';
export const GM_USAGE_RECORDED = 'GmUsageRecorded';
export const GM_CONTEXT_RECORDED = 'GmContextRecorded';
export const NON_ENGLISH_RATIO = 1.5;
export const MIN_RATIO = 1;
export const MAX_RATIO = 4;
export const REQUEST_OVERHEAD_TOKENS = 6000;
const SMOOTHING_WEIGHT = 2;
export const DROP_WINDOW_TURNS = 10;
export const DROPPED_OFTEN_TURNS = 3;
const ENGLISH_PREFIX = 'en';
const NONE = 0;
const INVALID_SETTINGS = 'GM settings name an invalid model or budget';

type Events = readonly Pick<CampaignEvent, 'type' | 'payload'>[];

export type GmSettingsSave = {
  readonly campaignId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly settings: unknown;
};

export type GmUsageRecord = {
  readonly campaignId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly usage: unknown;
};

const changeOf = (campaignId: string, actionId: string, type: string, payload: Record<string, unknown>) => ({
  id: randomUUID(),
  campaignId,
  branchId: MAIN_BRANCH,
  actionId,
  type,
  payload,
});

export const saveGmSettings = (
  store: CampaignStore,
  { campaignId, actionId, expectedRevision, settings }: GmSettingsSave,
): GmSettings => {
  const saved = toGmSettings(settings);
  if (saved === undefined) throw new InvalidActionError(actionId, INVALID_SETTINGS);
  store.recordChange({
    expectedRevision,
    event: changeOf(campaignId, actionId, GM_SETTINGS_SAVED, {
      settings: saved,
    }),
  });
  return saved;
};

export const gmSettingsOf = (events: Events): GmSettings =>
  toGmSettings(events.findLast(({ type }) => type === GM_SETTINGS_SAVED)?.payload.settings) ?? {};

export const recordGmUsage = (
  store: CampaignStore,
  { campaignId, turnId, sessionId, usage }: GmUsageRecord,
): GmUsage | undefined => {
  const actionId = randomUUID();
  const recorded = toGmUsage(usage) ?? toGmUsage({ ...(usage as object), model: ROUTE_DEFAULT_MODEL });
  if (recorded === undefined) return undefined;
  store.recordUsage(
    changeOf(campaignId, actionId, GM_USAGE_RECORDED, {
      turnId,
      sessionId,
      usage: recorded,
    }),
  );
  return recorded;
};

export const gmUsageOf = (events: Events, sessionId?: string): GmUsageTotals =>
  events
    .filter(
      ({ type, payload }) => type === GM_USAGE_RECORDED && (sessionId === undefined || payload.sessionId === sessionId),
    )
    .flatMap(({ payload }) => {
      const usage = toGmUsage(payload.usage);
      return usage === undefined ? [] : [usage];
    })
    .reduce(addGmUsage, EMPTY_GM_USAGE_TOTALS);

export type ContextRecord = {
  readonly campaignId: string;
  readonly turnId: string;
  readonly events: Events;
  readonly language: string | undefined;
  readonly packet: Pick<ContextPacket, 'usedTokens' | 'budget' | 'truncated' | 'requiredExceedsBudget'>;
  readonly reportedTokens: number;
};

const lastContextOf = (events: Events) => events.findLast(({ type }) => type === GM_CONTEXT_RECORDED)?.payload;

const isRatio = (value: unknown): value is number => typeof value === 'number' && value >= MIN_RATIO;

const recentOf = (payload: Record<string, unknown> | undefined): boolean[] =>
  Array.isArray(payload?.recent) ? payload.recent.filter((flag) => typeof flag === 'boolean') : [];

export const contextRatioOf = (events: Events, language: string | undefined): number => {
  const stored = lastContextOf(events)?.ratio;
  if (isRatio(stored)) return Math.min(stored, MAX_RATIO);
  return language === undefined || language.toLowerCase().startsWith(ENGLISH_PREFIX) ? MIN_RATIO : NON_ENGLISH_RATIO;
};

export const contextDroppedOften = (events: Events): boolean =>
  recentOf(lastContextOf(events)).filter(Boolean).length >= DROPPED_OFTEN_TURNS;

export const recordContextDiagnostics = (
  store: CampaignStore,
  { campaignId, turnId, events, language, packet, reportedTokens }: ContextRecord,
): void => {
  const previous = lastContextOf(events);
  const current = contextRatioOf(events, language);
  const promptTokens = reportedTokens - REQUEST_OVERHEAD_TOKENS;
  const measured = Math.min(Math.max(promptTokens / packet.usedTokens, MIN_RATIO), MAX_RATIO);
  const ratio =
    reportedTokens <= NONE || promptTokens <= NONE || packet.usedTokens <= NONE
      ? current
      : isRatio(previous?.ratio)
        ? (current + measured) / SMOOTHING_WEIGHT
        : measured;
  const recent = [...recentOf(previous), packet.truncated > NONE].slice(-DROP_WINDOW_TURNS);
  store.recordUsage(
    changeOf(campaignId, randomUUID(), GM_CONTEXT_RECORDED, {
      turnId,
      tokensUsed: packet.usedTokens,
      budget: packet.budget,
      dropped: packet.truncated,
      requiredExceedsBudget: packet.requiredExceedsBudget,
      ratio,
      recent,
    }),
  );
};
