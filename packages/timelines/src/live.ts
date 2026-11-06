import {
  ACTION_VALIDATED,
  type CampaignEvent,
  CHECK_RESOLVED,
  type DomainEvent,
  PLAYER_ACTION_SUBMITTED,
} from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import { EMPTY_GM_USAGE_LEDGER, GM_USAGE_RECORDED, type GmUsageLedger, recordInLedger } from '../../domain/src/gm.ts';
import { EMPTY_LIVE_FOLDS, FOLD_EVENT_TYPES, foldLive, type LiveFolds } from './live-folds.ts';
import type { Projection } from './replay.ts';

export const LIVE_PROJECTION_VERSION = 3;
export const RECENT_TURN_WINDOW = 200;
export const SNAPSHOT_EVERY_EVENTS = 1000;
const PRUNE_EVERY_EVENTS = 1000;
const DEFAULT_VISIBILITY: Visibility = 'gm';

const HIGH_VOLUME_TYPES: ReadonlySet<string> = new Set([PLAYER_ACTION_SUBMITTED, ACTION_VALIDATED, CHECK_RESOLVED]);

export type LiveChange = Pick<CampaignEvent, 'type' | 'payload'>;

export type LiveState = {
  readonly count: number;
  readonly events: readonly CampaignEvent[];
  readonly changes: Readonly<Record<string, LiveChange>>;
  readonly gmUsage: GmUsageLedger;
  readonly folds: LiveFolds;
};

const toTurnEvent = ({ id, campaignId, turnId, causationId, type, payload }: DomainEvent & { turnId: string }) => ({
  id,
  campaignId,
  turnId,
  causationId,
  type,
  payload,
});

const windowStart = (events: readonly CampaignEvent[]) => {
  const recent = new Set<string>();
  for (let index = events.length - 1; index >= 0; index--) {
    const { turnId } = events[index] as CampaignEvent;
    if (recent.size === RECENT_TURN_WINDOW && !recent.has(turnId)) return index + 1;
    recent.add(turnId);
  }
  return 0;
};

const pruned = (events: readonly CampaignEvent[]) => {
  const start = windowStart(events);
  return start === 0 ? events : events.filter(({ type }, index) => index >= start || !HIGH_VOLUME_TYPES.has(type));
};

export const createLiveAccumulator = (from: LiveState) => {
  let { count, changes, gmUsage, folds } = from;
  let events = [...from.events];
  let sincePrune = 0;
  return {
    push: (event: DomainEvent, visibility: Visibility = DEFAULT_VISIBILITY) => {
      count += 1;
      if (event.turnId !== null) {
        const turnEvent = toTurnEvent({ ...event, turnId: event.turnId });
        if (FOLD_EVENT_TYPES.has(event.type)) folds = foldLive(folds, turnEvent, visibility, event.actorId);
        else {
          events.push(turnEvent);
          sincePrune += 1;
          if (sincePrune >= PRUNE_EVERY_EVENTS) {
            events = [...pruned(events)];
            sincePrune = 0;
          }
        }
      } else if (event.type === GM_USAGE_RECORDED) gmUsage = recordInLedger(gmUsage, event.payload);
      else changes = { ...changes, [event.type]: { type: event.type, payload: event.payload } };
    },
    state: (): LiveState => ({ count, events: [...pruned(events)], changes, gmUsage, folds }),
  };
};

export const liveProjection: Projection<LiveState> = {
  version: LIVE_PROJECTION_VERSION,
  initial: { count: 0, events: [], changes: {}, gmUsage: EMPTY_GM_USAGE_LEDGER, folds: EMPTY_LIVE_FOLDS },
  apply: (state, event) => {
    const accumulator = createLiveAccumulator(state);
    accumulator.push(event);
    return accumulator.state();
  },
};
