import { isDeepStrictEqual } from 'node:util';
import type { CampaignEvent, CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import { commit, loadState, type PlayerAction, requireValid, storedTurn, validate } from './turn.ts';

export const GAME_TIME_TRIGGERS = ['time-passage', 'clock-tick'] as const;
export const EFFECT_DUE_KINDS = ['time', 'clock'] as const;

export type ClockId = string;
export type EffectId = string;
export type GameTimeTriggerKind = (typeof GAME_TIME_TRIGGERS)[number];
export type GameTimeTrigger =
  | { readonly kind: 'time-passage'; readonly units: number; readonly reason: string }
  | { readonly kind: 'clock-tick'; readonly clockId: ClockId; readonly segments: number; readonly reason: string };
export type EffectDue =
  | { readonly kind: 'time'; readonly at: number }
  | { readonly kind: 'clock'; readonly clockId: ClockId };
export type EffectPayload = Readonly<Record<string, unknown>> & { readonly summary: string };
export type ClockDefinition = { readonly clockId: ClockId; readonly label: string; readonly segments: number };
export type Clock = ClockDefinition & { readonly current: number };
export type DelayedEffect = {
  readonly effectId: EffectId;
  readonly due: EffectDue;
  readonly effect: EffectPayload;
  readonly fired: boolean;
};
export type WorldTime = {
  readonly now: number;
  readonly clocks: readonly Clock[];
  readonly effects: readonly DelayedEffect[];
};

export type ClockDefinitionAction = PlayerAction & ClockDefinition;
export type EffectSchedule = PlayerAction & Omit<DelayedEffect, 'fired'>;
export type GameTimeAdvance = PlayerAction & { readonly trigger: GameTimeTrigger };

const CLOCK_DEFINED = 'ClockDefined';
const EFFECT_SCHEDULED = 'DelayedEffectScheduled';
const TIME_ADVANCED = 'GameTimeAdvanced';
const CLOCK_TICKED = 'ClockTicked';
const CLOCK_COMPLETED = 'ClockCompleted';
const EFFECT_FIRED = 'DelayedEffectFired';
const TIME_PASSAGE: GameTimeTriggerKind = 'time-passage';
const TIME = 'time';
const START_TIME = 0;

type Payload = Readonly<Record<string, unknown>>;
type State = { now: number; clocks: Map<ClockId, Clock>; effects: Map<EffectId, DelayedEffect> };
type Step = readonly [string, Record<string, unknown>];

const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const fold = (state: State, { type, payload }: CampaignEvent) => {
  const data = payload as Payload;
  if (type === CLOCK_DEFINED) {
    const clockId = String(data.clockId);
    state.clocks.set(clockId, { clockId, label: String(data.label), segments: Number(data.segments), current: 0 });
  }
  if (type === EFFECT_SCHEDULED) {
    const effectId = String(data.effectId);
    const effect = { effectId, due: data.due as EffectDue, effect: data.effect as EffectPayload, fired: false };
    state.effects.set(effectId, effect);
  }
  if (type === TIME_ADVANCED) state.now = Number(data.now);
  const clock = state.clocks.get(String(data.clockId));
  if (type === CLOCK_TICKED && clock !== undefined)
    state.clocks.set(clock.clockId, { ...clock, current: Number(data.current) });
  const effect = state.effects.get(String(data.effectId));
  if (type === EFFECT_FIRED && effect !== undefined) state.effects.set(effect.effectId, { ...effect, fired: true });
  return state;
};

const project = (events: readonly CampaignEvent[]): State =>
  events.reduce(fold, { now: START_TIME, clocks: new Map(), effects: new Map() });

export const worldTime = (events: readonly CampaignEvent[]): WorldTime => {
  const { now, clocks, effects } = project(events);
  return { now, clocks: [...clocks.values()], effects: [...effects.values()] };
};

const isComplete = ({ current, segments }: Clock) => current >= segments;

const run = (store: CampaignStore, action: PlayerAction, steps: (state: State) => readonly Step[]): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = storedTurn(state, action.actionId);
  if (stored !== undefined) return stored;
  validate(state, action);
  return commit(store, action, steps(project(state.events)));
};

export const defineClock = (store: CampaignStore, definition: ClockDefinitionAction): CommittedTurn =>
  run(store, definition, ({ clocks }) => {
    const { actionId, clockId, label, segments } = definition;
    requireValid(actionId, isFilled(clockId), 'clock id is blank');
    requireValid(actionId, !clocks.has(clockId), `clock ${clockId} is already defined`);
    requireValid(actionId, isFilled(label), 'clock label is blank');
    requireValid(actionId, isCount(segments), 'clock segments must be a positive integer');
    return [[CLOCK_DEFINED, { clockId, label, segments }]];
  });

const toDue = (actionId: string, { now, clocks }: State, due: EffectDue): EffectDue => {
  if (due.kind === TIME) {
    requireValid(actionId, isCount(due.at) && due.at > now, `effect must be due after game time ${now}`);
    return { kind: TIME, at: due.at };
  }
  requireValid(actionId, EFFECT_DUE_KINDS.includes(due.kind), 'effect due kind is unknown');
  const clock = clocks.get(due.clockId);
  requireValid(actionId, clock !== undefined, `clock ${due.clockId} is not defined`);
  requireValid(actionId, clock !== undefined && !isComplete(clock), `clock ${due.clockId} is already complete`);
  return { kind: due.kind, clockId: due.clockId };
};

const isPlainData = (effect: unknown): effect is EffectPayload =>
  typeof effect === 'object' && effect !== null && isDeepStrictEqual(JSON.parse(JSON.stringify(effect)), effect);

export const scheduleEffect = (store: CampaignStore, schedule: EffectSchedule): CommittedTurn =>
  run(store, schedule, (state) => {
    const { actionId, effectId, effect } = schedule;
    requireValid(actionId, isFilled(effectId), 'effect id is blank');
    requireValid(actionId, !state.effects.has(effectId), `effect ${effectId} is already scheduled`);
    requireValid(actionId, isPlainData(effect), 'effect must be plain data');
    requireValid(actionId, isFilled(effect.summary), 'effect summary is blank');
    return [[EFFECT_SCHEDULED, { effectId, due: toDue(actionId, state, schedule.due), effect }]];
  });

const isDue = (now: number, completed: ReadonlySet<ClockId>, { due, fired }: DelayedEffect) =>
  !fired && (due.kind === TIME ? due.at <= now : completed.has(due.clockId));

export const advanceGameTime = (store: CampaignStore, advance: GameTimeAdvance): CommittedTurn =>
  run(store, advance, (state) => {
    const { actionId, trigger } = advance;
    requireValid(actionId, GAME_TIME_TRIGGERS.includes(trigger.kind), `trigger ${trigger.kind} is not approved`);
    requireValid(actionId, isFilled(trigger.reason), 'trigger reason is blank');
    const steps: Step[] = [];
    const completed = new Set<ClockId>();
    let now = state.now;
    if (trigger.kind === TIME_PASSAGE) {
      requireValid(actionId, isCount(trigger.units), 'time units must be a positive integer');
      now += trigger.units;
      steps.push([TIME_ADVANCED, { kind: trigger.kind, units: trigger.units, now, reason: trigger.reason }]);
    } else {
      const { clockId, segments, reason } = trigger;
      const clock = state.clocks.get(clockId);
      requireValid(actionId, clock !== undefined, `clock ${clockId} is not defined`);
      requireValid(actionId, isCount(segments), 'clock tick segments must be a positive integer');
      const current = (clock?.current ?? 0) + segments;
      requireValid(actionId, current <= (clock?.segments ?? 0), `clock ${clockId} cannot tick past its segments`);
      steps.push([CLOCK_TICKED, { kind: trigger.kind, clockId, segments, current, reason }]);
      if (current === clock?.segments) {
        completed.add(clockId);
        steps.push([CLOCK_COMPLETED, { clockId }]);
      }
    }
    for (const effect of state.effects.values())
      if (isDue(now, completed, effect))
        steps.push([EFFECT_FIRED, { effectId: effect.effectId, effect: effect.effect }]);
    return steps;
  });
