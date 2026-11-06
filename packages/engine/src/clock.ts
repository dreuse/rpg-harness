import { isDeepStrictEqual } from 'node:util';
import type { CampaignEvent, CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import {
  CLOCK_DEFINED,
  CLOCK_TICKED,
  type Clock,
  type ClockDefinition,
  type ClockId,
  type DelayedEffect,
  EFFECT_FIRED,
  EFFECT_SCHEDULED,
  type EffectDue,
  type EffectId,
  type EffectPayload,
  TIME_ADVANCED,
  type WorldTime,
  worldOf,
} from '../../timelines/src/live-folds.ts';
import { commit, loadState, type PlayerAction, requireValid, storedTurnOf, validate } from './turn.ts';

export const GAME_TIME_TRIGGERS = ['time-passage', 'clock-tick'] as const;
export const EFFECT_DUE_KINDS = ['time', 'clock'] as const;

export type GameTimeTriggerKind = (typeof GAME_TIME_TRIGGERS)[number];
export type GameTimeTrigger =
  | { readonly kind: 'time-passage'; readonly units: number; readonly reason: string }
  | { readonly kind: 'clock-tick'; readonly clockId: ClockId; readonly segments: number; readonly reason: string };
export type { Clock, ClockDefinition, ClockId, DelayedEffect, EffectDue, EffectId, EffectPayload, WorldTime };

export type ClockDefinitionAction = PlayerAction & ClockDefinition;
export type EffectSchedule = PlayerAction & Omit<DelayedEffect, 'fired'>;
export type GameTimeAdvance = PlayerAction & { readonly trigger: GameTimeTrigger };

const CLOCK_COMPLETED = 'ClockCompleted';
const TIME_PASSAGE: GameTimeTriggerKind = 'time-passage';
const TIME = 'time';

type State = { now: number; clocks: Map<ClockId, Clock>; effects: Map<EffectId, DelayedEffect> };
type Step = readonly [string, Record<string, unknown>];

const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const stateOf = ({ now, clocks, effects }: WorldTime): State => ({
  now,
  clocks: new Map(clocks.map((clock) => [clock.clockId, clock])),
  effects: new Map(effects.map((effect) => [effect.effectId, effect])),
});

export const worldTime = (events: readonly CampaignEvent[]): WorldTime => worldOf(events);

const isComplete = ({ current, segments }: Clock) => current >= segments;

const run = (store: CampaignStore, action: PlayerAction, steps: (state: State) => readonly Step[]): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = storedTurnOf(store, state, action.actionId);
  if (stored !== undefined) return stored;
  validate(state, action);
  return commit(store, action, steps(stateOf(state.folds.world)));
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
