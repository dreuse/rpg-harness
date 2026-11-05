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
import { InvalidActionError } from './turn.ts';

export const GM_SETTINGS_SAVED = 'GmSettingsSaved';
export const GM_USAGE_RECORDED = 'GmUsageRecorded';
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
    event: changeOf(campaignId, actionId, GM_SETTINGS_SAVED, { settings: saved }),
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
  store.recordUsage(changeOf(campaignId, actionId, GM_USAGE_RECORDED, { turnId, sessionId, usage: recorded }));
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
