import { CampaignBoundaryError, type CampaignEvent, type CampaignId, type EventId } from '../../domain/src/campaign.ts';
import type { EntityId, Visibility } from '../../domain/src/entity.ts';
import { type Viewer, visibleTo } from './knowledge.ts';

export type SummaryId = string;

export type Summary = {
  readonly id: SummaryId;
  readonly campaignId: CampaignId;
  readonly text: string;
  readonly sourceEventIds: readonly EventId[];
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
};

export type CondensedDraft = { readonly id: SummaryId; readonly text: string };

export class UnknownEvidenceError extends Error {
  readonly summaryId: SummaryId;
  readonly eventIds: readonly EventId[];
  constructor(summaryId: SummaryId, eventIds: readonly EventId[]) {
    super(`summary ${summaryId} cites unknown events [${eventIds.join(', ')}]`);
    this.summaryId = summaryId;
    this.eventIds = eventIds;
  }
}

const GM_SCOPE = 'gm';
const WORD_SEPARATOR = /\s+/;
const NONE = 0;

const terms = (query: string): readonly string[] =>
  query
    .toLowerCase()
    .split(WORD_SEPARATOR)
    .filter((term) => term.length > NONE);

const matches = (text: string, query: readonly string[]): boolean => {
  const haystack = text.toLowerCase();
  return query.length > NONE && query.every((term) => haystack.includes(term));
};

const eventText = (event: CampaignEvent): string => `${event.type} ${JSON.stringify(event.payload)}`;

export const searchEvents = (
  events: readonly CampaignEvent[],
  query: string,
  viewer: Viewer,
): readonly CampaignEvent[] => {
  if (viewer.scope !== GM_SCOPE) return [];
  const wanted = terms(query);
  return events.filter((event) => matches(eventText(event), wanted));
};

export const searchSummaries = (summaries: readonly Summary[], query: string, viewer: Viewer): readonly Summary[] => {
  const wanted = terms(query);
  return visibleTo(summaries, viewer).filter((summary) => matches(summary.text, wanted));
};

export const summarize = (events: readonly CampaignEvent[], draft: Summary): Summary => {
  const cited = new Set(draft.sourceEventIds);
  const found = events.filter((event) => cited.has(event.id));
  const known = new Set(found.map((event) => event.id));
  const missing = [...cited].filter((id) => !known.has(id));
  if (missing.length > NONE || cited.size === NONE) throw new UnknownEvidenceError(draft.id, missing);
  const foreign = found.find((event) => event.campaignId !== draft.campaignId);
  if (foreign !== undefined) throw new CampaignBoundaryError(draft.campaignId, foreign.id);
  return Object.freeze({ ...draft, sourceEventIds: Object.freeze(found.map((event) => event.id)) });
};

export const condense = (
  events: readonly CampaignEvent[],
  draft: CondensedDraft,
  parts: readonly Summary[],
): Summary => {
  const [first] = parts;
  if (first === undefined) throw new UnknownEvidenceError(draft.id, []);
  const mixed = parts.find((part) => part.visibility !== first.visibility || part.actorId !== first.actorId);
  if (mixed !== undefined) throw new RangeError(`cannot condense ${mixed.id} across visibility scopes`);
  return summarize(events, {
    ...draft,
    campaignId: first.campaignId,
    visibility: first.visibility,
    actorId: first.actorId,
    sourceEventIds: parts.flatMap((part) => part.sourceEventIds),
  });
};
