import { randomUUID } from 'node:crypto';
import { type CampaignEvent, type CampaignStore, MAIN_BRANCH } from '../../domain/src/campaign.ts';

export const OPENING_SPOKEN = 'OpeningSpoken';

export type OpeningSpokenMark = {
  readonly campaignId: string;
  readonly actionId: string;
  readonly expectedRevision: number;
};

export const markOpeningSpoken = (
  store: CampaignStore,
  { campaignId, actionId, expectedRevision }: OpeningSpokenMark,
) =>
  store.recordChange({
    expectedRevision,
    event: { id: randomUUID(), campaignId, branchId: MAIN_BRANCH, actionId, type: OPENING_SPOKEN, payload: {} },
  });

export const openingSpokenOf = (events: readonly Pick<CampaignEvent, 'type' | 'payload'>[]): boolean =>
  events.some(({ type }) => type === OPENING_SPOKEN);
