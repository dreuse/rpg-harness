import {
  ACTION_BUDGET_EXCEEDED,
  ACTOR_BUDGET_EXCEEDED,
  type ActorAction,
  admitProposals,
  firingTriggers,
  isActorAction,
  type LogicalClock,
  MALFORMED_ACTION,
  type Rejection,
  type Trigger,
  type WorldConfig,
} from './world.ts';

export const GAME_TIME_SOURCE = 'game-time';
export const MAX_TICKS_PER_ADVANCE = 32;
export const MAX_DEFERRED_ACTIONS = 64;
const BUDGET_REASONS = [ACTION_BUDGET_EXCEEDED, ACTOR_BUDGET_EXCEEDED];
const QUEUE_FULL = 'deferred action queue full';
const FOREIGN_ACTOR = 'planner proposed for another actor';
const FOREIGN_TICK = 'planner proposed for another tick';

export type TimedEvent = { readonly tick: number; readonly type: string };
export type TimeTransition = {
  readonly source: typeof GAME_TIME_SOURCE;
  readonly approved: boolean;
  readonly fromTick: number;
  readonly toTick: number;
  readonly events?: readonly TimedEvent[];
};
export type PlanRequest = {
  readonly actorId: string;
  readonly clock: LogicalClock;
  readonly triggers: readonly Trigger[];
};
export type ActorPlanner = (request: PlanRequest) => readonly ActorAction[];
export type SchedulerCursor = {
  readonly lastProcessedTick: number;
  readonly deferred: readonly ActorAction[];
};
export type FiredTick = { readonly tick: number; readonly triggers: readonly Trigger[] };
export type AdvanceResult =
  | {
      ok: true;
      cursor: SchedulerCursor;
      accepted: ActorAction[];
      rejected: Rejection[];
      fired: FiredTick[];
      deferredTicks: number;
    }
  | { ok: false; reason: string };

export const INITIAL_CURSOR: SchedulerCursor = { lastProcessedTick: 0, deferred: [] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTick = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const isCursor = (v: unknown): v is SchedulerCursor =>
  isRecord(v) && isTick(v.lastProcessedTick) && Array.isArray(v.deferred) && v.deferred.every(isActorAction);

const transitionIssue = (t: unknown, cursor: SchedulerCursor) => {
  if (!isRecord(t)) return 'malformed transition';
  if (t.source !== GAME_TIME_SOURCE) return 'only in-game time may advance the world';
  if (t.approved !== true) return 'transition is not approved';
  if (!isTick(t.fromTick) || !isTick(t.toTick) || t.toTick <= t.fromTick)
    return 'transition must move forward in game time';
  if (t.fromTick > cursor.lastProcessedTick) return 'transition skips unprocessed game time';
  const events = t.events ?? [];
  const inRange = (e: unknown) =>
    isRecord(e) &&
    isTick(e.tick) &&
    e.tick > (t.fromTick as number) &&
    e.tick <= (t.toTick as number) &&
    isNonEmpty(e.type);
  if (!Array.isArray(events) || !events.every(inRange)) return 'malformed transition events';
  return undefined;
};

export const advanceWorld = (
  config: WorldConfig,
  cursor: SchedulerCursor,
  transition: TimeTransition,
  actorIds: readonly string[],
  planner: ActorPlanner,
): AdvanceResult => {
  if (!isCursor(cursor)) return { ok: false, reason: 'malformed scheduler cursor' };
  const issue = transitionIssue(transition, cursor);
  if (issue) return { ok: false, reason: issue };
  const accepted: ActorAction[] = [];
  const rejected: Rejection[] = [];
  const fired: FiredTick[] = [];
  const last = Math.max(cursor.lastProcessedTick, transition.toTick);
  if (config.mode === 'off')
    return { ok: true, cursor: { ...cursor, lastProcessedTick: last }, accepted, rejected, fired, deferredTicks: 0 };
  const actors = [...new Set(actorIds)].sort();
  let deferred = [...cursor.deferred];
  const end = Math.min(transition.toTick, cursor.lastProcessedTick + MAX_TICKS_PER_ADVANCE);
  let tick = cursor.lastProcessedTick;
  while (tick < end) {
    tick += 1;
    const events = (transition.events ?? []).filter((e) => e.tick === tick).map((e) => e.type);
    const clock: LogicalClock = { tick, events };
    const triggers = firingTriggers(config, clock);
    if (triggers.length > 0) fired.push({ tick, triggers });
    const proposals =
      triggers.length === 0 ? [] : actors.flatMap((actorId) => planned(planner, actorId, clock, triggers, rejected));
    const admitted = admitProposals(config, [...deferred, ...proposals]);
    accepted.push(...admitted.accepted);
    deferred = [];
    for (const rejection of admitted.rejected) {
      if (!BUDGET_REASONS.includes(rejection.reason)) rejected.push(rejection);
      else if (deferred.length < MAX_DEFERRED_ACTIONS) deferred.push(rejection.action);
      else rejected.push({ action: rejection.action, reason: QUEUE_FULL });
    }
  }
  return {
    ok: true,
    cursor: { lastProcessedTick: tick, deferred },
    accepted,
    rejected,
    fired,
    deferredTicks: Math.max(0, transition.toTick - tick),
  };
};

const planned = (
  planner: ActorPlanner,
  actorId: string,
  clock: LogicalClock,
  triggers: readonly Trigger[],
  rejected: Rejection[],
) => {
  const output: unknown = planner({ actorId, clock, triggers });
  const items: unknown[] = Array.isArray(output) ? output : [output];
  const own: ActorAction[] = [];
  for (const item of items) {
    const reason = !isActorAction(item)
      ? MALFORMED_ACTION
      : item.actorId !== actorId
        ? FOREIGN_ACTOR
        : item.tick !== clock.tick
          ? FOREIGN_TICK
          : undefined;
    if (reason === undefined) own.push(item as ActorAction);
    else rejected.push({ action: item as ActorAction, reason });
  }
  return own;
};
