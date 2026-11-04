import { EVENT_BUCKETS, type EventBucket, type EventId } from './campaign.ts';

export { EVENT_BUCKETS, type EventBucket };

export const PACING_INTENTS = ['relaxed', 'balanced', 'intense'] as const;
export type PacingIntent = (typeof PACING_INTENTS)[number];

export const TENSION_LEVELS = ['calm', 'rising', 'high', 'peak'] as const;
export type TensionLevel = (typeof TENSION_LEVELS)[number];

export type PendingEvent = {
  readonly id: EventId;
  readonly bucket: EventBucket;
  readonly storylineId: string | null;
  readonly solicited: boolean;
};

export type PacingState = {
  readonly intent: PacingIntent;
  readonly tension: TensionLevel;
  readonly attention: number;
  readonly interruptions: number;
  readonly storylines: readonly string[];
};

export type PacingParams = {
  readonly attentionPerScene: Readonly<Record<PacingIntent, number>>;
  readonly interruptionsPerScene: Readonly<Record<PacingIntent, number>>;
  readonly bucketCost: Readonly<Record<EventBucket, number>>;
  readonly maxActiveStorylines: number;
  readonly criticalTension: TensionLevel;
  readonly recoveryThreshold: TensionLevel;
  readonly tensionDecayPerScene: number;
};

export type Selection = {
  readonly state: PacingState;
  readonly surfaced: readonly PendingEvent[];
  readonly pending: readonly PendingEvent[];
};

export const DEFAULT_PACING: PacingParams = {
  attentionPerScene: { relaxed: 1, balanced: 3, intense: 5 },
  interruptionsPerScene: { relaxed: 0, balanced: 1, intense: 2 },
  bucketCost: { background: 1, emerging: 1, major: 2, critical: 1 },
  maxActiveStorylines: 1,
  criticalTension: 'high',
  recoveryThreshold: 'high',
  tensionDecayPerScene: 1,
};

const CRITICAL: EventBucket = 'critical';
const MAJOR: EventBucket = 'major';
const CALM_INDEX = 0;

const tensionIndex = (level: TensionLevel): number => TENSION_LEVELS.indexOf(level);
const priority = (event: PendingEvent): number => -EVENT_BUCKETS.indexOf(event.bucket);

const startsStoryline = (state: PacingState, event: PendingEvent): boolean =>
  event.bucket === MAJOR && event.storylineId !== null && !state.storylines.includes(event.storylineId);

const canSurface = (state: PacingState, event: PendingEvent, params: PacingParams): boolean =>
  event.bucket === CRITICAL ||
  (state.attention >= params.bucketCost[event.bucket] &&
    (event.solicited || state.interruptions > 0) &&
    (!startsStoryline(state, event) || state.storylines.length < params.maxActiveStorylines));

const surface = (state: PacingState, event: PendingEvent, params: PacingParams): PacingState => ({
  ...state,
  attention: Math.max(0, state.attention - params.bucketCost[event.bucket]),
  interruptions: event.bucket === CRITICAL || event.solicited ? state.interruptions : state.interruptions - 1,
  tension:
    event.bucket === CRITICAL && tensionIndex(state.tension) < tensionIndex(params.criticalTension)
      ? params.criticalTension
      : state.tension,
  storylines:
    startsStoryline(state, event) && event.storylineId !== null
      ? [...state.storylines, event.storylineId]
      : state.storylines,
});

export const selectSurfaced = (
  state: PacingState,
  pending: readonly PendingEvent[],
  params: PacingParams = DEFAULT_PACING,
): Selection => {
  let next = state;
  const surfaced: PendingEvent[] = [];
  for (const event of pending.toSorted((a, b) => priority(a) - priority(b))) {
    if (canSurface(next, event, params)) {
      next = surface(next, event, params);
      surfaced.push(event);
    }
  }
  return { state: next, surfaced, pending: pending.filter((event) => !surfaced.includes(event)) };
};

export const startScene = (state: PacingState, params: PacingParams = DEFAULT_PACING): PacingState => {
  const recovering = tensionIndex(state.tension) >= tensionIndex(params.recoveryThreshold);
  return {
    ...state,
    tension:
      TENSION_LEVELS[Math.max(CALM_INDEX, tensionIndex(state.tension) - params.tensionDecayPerScene)] ?? state.tension,
    attention: params.attentionPerScene[state.intent],
    interruptions: recovering ? 0 : params.interruptionsPerScene[state.intent],
  };
};

export const concludeStoryline = (state: PacingState, storylineId: string): PacingState => ({
  ...state,
  storylines: state.storylines.filter((id) => id !== storylineId),
});
