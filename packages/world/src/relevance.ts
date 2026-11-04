import { EVENT_BUCKETS, type EventBucket, type EventId } from '../../domain/src/campaign.ts';
import type { EntityId } from '../../domain/src/entity.ts';
import {
  DEFAULT_PACING,
  type PacingParams,
  type PacingState,
  type Selection,
  selectSurfaced,
} from '../../domain/src/pacing.ts';

export type PlayerContext = {
  readonly playerId: EntityId;
  readonly locationId: EntityId | null;
  readonly knownEntityIds: readonly EntityId[];
  readonly storylineIds: readonly string[];
};

export type EventRelevance = {
  readonly eventId: EventId;
  readonly involvedEntityIds: readonly EntityId[];
  readonly locationId: EntityId | null;
  readonly storylineId: string | null;
  readonly directEffect: boolean;
};

const CRITICAL: EventBucket = 'critical';
const MAJOR: EventBucket = 'major';
const EMERGING: EventBucket = 'emerging';
const BACKGROUND: EventBucket = 'background';
const MISSING_EVENT_ID: EventId = '';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isIdList = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every(isId);
const isOptionalId = (v: unknown): boolean => v === null || isId(v);

const isPlayerContext = (v: unknown): v is PlayerContext =>
  isRecord(v) &&
  isId(v.playerId) &&
  isOptionalId(v.locationId) &&
  isIdList(v.knownEntityIds) &&
  isIdList(v.storylineIds);

const isEventRelevance = (v: unknown): v is EventRelevance =>
  isRecord(v) &&
  isId(v.eventId) &&
  isIdList(v.involvedEntityIds) &&
  isOptionalId(v.locationId) &&
  isOptionalId(v.storylineId) &&
  typeof v.directEffect === 'boolean';

const relevance = (event: EventRelevance, player: PlayerContext): EventBucket => {
  if (event.directEffect) return CRITICAL;
  if (
    event.involvedEntityIds.includes(player.playerId) ||
    (event.storylineId !== null && player.storylineIds.includes(event.storylineId)) ||
    (event.locationId !== null && event.locationId === player.locationId)
  )
    return MAJOR;
  if (event.involvedEntityIds.some((id) => player.knownEntityIds.includes(id))) return EMERGING;
  return BACKGROUND;
};

const rank = (bucket: EventBucket): number => EVENT_BUCKETS.indexOf(bucket);

export const classifyEvent = (event: EventRelevance, player: PlayerContext, target?: EventBucket): EventBucket => {
  if (!isEventRelevance(event) || !isPlayerContext(player)) return CRITICAL;
  const bucket = relevance(event, player);
  if (bucket === CRITICAL || target === undefined || !EVENT_BUCKETS.includes(target)) return bucket;
  return rank(bucket) > rank(target) ? target : bucket;
};

export const surfaceWorldEvents = (
  state: PacingState,
  events: readonly EventRelevance[],
  player: PlayerContext,
  params: PacingParams = DEFAULT_PACING,
): Selection =>
  selectSurfaced(
    state,
    events.map((event) => ({
      id: isRecord(event) && isId(event.eventId) ? event.eventId : MISSING_EVENT_ID,
      bucket: classifyEvent(event, player),
      storylineId: isRecord(event) && isId(event.storylineId) ? event.storylineId : null,
      solicited: false,
    })),
    params,
  );
