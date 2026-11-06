import {
  type CampaignEvent,
  type CampaignStore,
  CONDITION_APPLIED,
  CONDITION_REMOVED,
  type CommittedTurn,
  PLAYER_ACTION_SUBMITTED,
  SCENE_OPENED,
} from '../../domain/src/campaign.ts';
import type { EntityStore, Visibility } from '../../domain/src/entity.ts';
import type { RulesStrictness } from '../../domain/src/rules-usage.ts';
import {
  type AppliedModifier,
  type ConditionDuration,
  DURATION_UNITS,
  MAX_CONDITION_DURATION,
  MAX_MODIFIER_TEXT_LENGTH,
  MIN_DURATION,
  type ModifierRequest,
  type ModifierVocabulary,
  resolveModifiers,
} from '../../rules/src/modifiers.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import { commitSystem, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export type ModifierPolicy = {
  readonly vocabulary: ModifierVocabulary;
  readonly strictness: RulesStrictness;
  readonly cites?: (rule: string) => boolean;
};

export type ConditionRequest = {
  readonly conditionId: string;
  readonly reason: string;
  readonly label?: string;
  readonly duration?: ConditionDuration;
  readonly appliesTo?: readonly string[];
  readonly modifiers?: readonly ModifierRequest[];
  readonly targetId?: string;
};

export type ConditionApplying = PlayerAction & ModifierPolicy & { readonly condition: ConditionRequest };
export type ConditionEnding = PlayerAction & { readonly conditionId: string };

export type ActiveCondition = {
  readonly conditionId: string;
  readonly label: string;
  readonly reason: string;
  readonly appliesTo?: readonly string[];
  readonly modifiers: readonly AppliedModifier[];
};

type Tracked = ActiveCondition & {
  readonly actorId: string;
  readonly duration: ConditionDuration;
  readonly turnsAt: number;
  readonly scenesAt: number;
};

const NONE = 0;
const NPC_KIND = 'npc';
export const PLAYER_KNOWN: readonly Visibility[] = ['public', 'player'];

const isDuration = (value: unknown): value is ConditionDuration =>
  isRecord(value) &&
  DURATION_UNITS.some((unit) => unit === value.unit) &&
  Number.isInteger(value.count) &&
  Number(value.count) >= MIN_DURATION &&
  Number(value.count) <= MAX_CONDITION_DURATION;

export const applyCondition = (
  store: CampaignStore,
  input: ConditionApplying,
  entities?: EntityStore,
): CommittedTurn => {
  const { actionId, condition, vocabulary, strictness, cites } = input;
  const { conditionId, reason, targetId } = condition;
  const actorId = targetId ?? input.actorId;
  const state = loadState(store, input.campaignId);
  const stored = replayOf(store, state, input, recorded(CONDITION_APPLIED, { conditionId, actorId }));
  if (stored !== undefined) return stored;
  validate(state, input);
  const target = targetId === undefined ? undefined : entities?.getEntity(input.campaignId, targetId);
  requireValid(
    actionId,
    targetId === undefined || (target?.kind === NPC_KIND && PLAYER_KNOWN.includes(target.visibility)),
    `condition target ${targetId} is not a known npc`,
  );
  requireValid(
    actionId,
    reason.trim() !== '' && reason.length <= MAX_MODIFIER_TEXT_LENGTH,
    'condition reason is invalid',
  );
  const declared = vocabulary.conditions.find(({ id }) => id === conditionId);
  requireValid(
    actionId,
    declared !== undefined || strictness === 'relaxed',
    `condition ${conditionId} is not in the rulepack`,
  );
  const requests =
    declared === undefined
      ? (condition.modifiers ?? [])
      : declared.modifiers.map((id): ModifierRequest => ({ id, reason }));
  requireValid(actionId, requests.length > NONE, 'condition has no modifiers');
  const resolved = resolveModifiers(vocabulary, requests, strictness, vocabulary.effects, cites);
  requireValid(actionId, resolved.ok, resolved.ok ? '' : resolved.issues.map(({ message }) => message).join('; '));
  const asWritten = strictness === 'as-written' && declared !== undefined;
  const duration = asWritten ? declared.duration : (condition.duration ?? declared?.duration);
  requireValid(actionId, isDuration(duration), 'condition duration is invalid');
  const appliesTo = asWritten ? declared.appliesTo : (condition.appliesTo ?? declared?.appliesTo);
  return commitSystem(store, input, [
    [
      CONDITION_APPLIED,
      {
        conditionId,
        label: (asWritten ? undefined : condition.label) ?? declared?.label ?? conditionId,
        actorId,
        reason,
        duration,
        ...(appliesTo === undefined ? {} : { appliesTo }),
        modifiers: resolved.ok ? resolved.applied.map((entry) => ({ ...entry, condition: conditionId })) : [],
      },
      'player',
    ],
  ]);
};

export const endCondition = (store: CampaignStore, input: ConditionEnding): CommittedTurn => {
  const { actorId, conditionId } = input;
  const state = loadState(store, input.campaignId);
  const stored = replayOf(store, state, input, recorded(CONDITION_REMOVED, { conditionId, actorId }));
  if (stored !== undefined) return stored;
  validate(state, input);
  requireValid(
    input.actionId,
    activeConditionsOf(state.events, actorId).some((active) => active.conditionId === conditionId),
    `condition ${conditionId} is not active`,
  );
  return commitSystem(store, input, [[CONDITION_REMOVED, { conditionId, actorId }, 'player']]);
};

const isPlayerTurn = ({ type, payload }: CampaignEvent) => type === PLAYER_ACTION_SUBMITTED && payload.system !== true;

const trackedOf = (payload: CampaignEvent['payload'], turnsAt: number, scenesAt: number): Tracked | undefined => {
  const { conditionId, label, actorId, reason, duration, appliesTo, modifiers } = payload;
  if (typeof conditionId !== 'string' || typeof actorId !== 'string' || !isDuration(duration)) return undefined;
  return {
    conditionId,
    label: typeof label === 'string' ? label : conditionId,
    reason: typeof reason === 'string' ? reason : '',
    actorId,
    duration,
    turnsAt,
    scenesAt,
    ...(Array.isArray(appliesTo) ? { appliesTo: appliesTo.map(String) } : {}),
    modifiers: Array.isArray(modifiers) ? (modifiers as AppliedModifier[]) : [],
  };
};

const keyOf = (actorId: string, conditionId: string) => `${actorId}:${conditionId}`;

export const activeConditionsOf = (
  events: readonly CampaignEvent[],
  actorId: string,
  ruleId?: string,
): readonly ActiveCondition[] => {
  let turns = NONE;
  let scenes = NONE;
  const live = new Map<string, Tracked>();
  for (const event of events) {
    if (isPlayerTurn(event)) turns += 1;
    else if (event.type === SCENE_OPENED) scenes += 1;
    else if (event.type === CONDITION_APPLIED) {
      const tracked = trackedOf(event.payload, turns, scenes);
      if (tracked !== undefined) live.set(keyOf(tracked.actorId, tracked.conditionId), tracked);
    } else if (event.type === CONDITION_REMOVED) {
      live.delete(keyOf(String(event.payload.actorId), String(event.payload.conditionId)));
    }
  }
  return [...live.values()]
    .filter(({ duration, turnsAt, scenesAt }) =>
      duration.unit === 'turns' ? turns - turnsAt < duration.count : scenes - scenesAt < duration.count,
    )
    .filter((tracked) => tracked.actorId === actorId)
    .filter(({ appliesTo }) => ruleId === undefined || appliesTo === undefined || appliesTo.includes(ruleId))
    .map(({ conditionId, label, reason, appliesTo, modifiers }) => ({
      conditionId,
      label,
      reason,
      ...(appliesTo === undefined ? {} : { appliesTo }),
      modifiers,
    }));
};

export const mergeModifiers = (
  explicit: readonly AppliedModifier[],
  fromConditions: readonly AppliedModifier[],
): AppliedModifier[] => [...explicit, ...fromConditions.filter(({ id }) => !explicit.some((entry) => entry.id === id))];

export const conditionModifiersOf = (
  events: readonly CampaignEvent[],
  actorId: string,
  ruleId: string,
): AppliedModifier[] => {
  const seen = new Set<string>();
  return activeConditionsOf(events, actorId, ruleId)
    .flatMap(({ modifiers }) => modifiers)
    .filter(({ id }) => !seen.has(id) && seen.add(id));
};
