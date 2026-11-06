import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CampaignState, CampaignStore, CharacterId, CommittedTurn } from '../../domain/src/campaign.ts';
import type { Rng } from '../../rules/src/dice.ts';
import { type EffectiveMechanic, parseRuleDsl, type RuleDsl } from '../../rules/src/dsl.ts';
import { resolveAction } from '../../rules/src/resolve.ts';
import { type TraitSheet, validateTraitSheet } from '../../rules/src/traits.ts';
import {
  ENCOUNTER_ACTION_RESOLVED,
  ENCOUNTER_RESOLVED,
  ENCOUNTER_STARTED,
  ENCOUNTER_TURN_ADVANCED,
  type Encounter,
  type EncounterAction,
  type EncounterId,
  type EncounterResolution,
  type EncounterRules,
  type EncounterStatus,
} from '../../timelines/src/live-folds.ts';
import { commitSystem, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export type { Encounter, EncounterAction, EncounterId, EncounterResolution, EncounterRules, EncounterStatus };

export type EncounterStart = PlayerAction & {
  readonly participants: readonly CharacterId[];
  readonly rules?: EncounterRules;
  readonly sheets?: readonly TraitSheet[];
};
export type EncounterMove = PlayerAction & {
  readonly ruleId: string;
  readonly rng: Rng;
  readonly modifiers?: Readonly<Record<string, number>>;
};
export type EncounterEnd = PlayerAction & { readonly outcome: string };

const ACTIVE: EncounterStatus = 'active';
const FIRST_SEAT = 0;
const NEXT = 1;
const INVALID_ACTION = 'InvalidAction';
const NO_MODIFIERS: Readonly<Record<string, number>> = {};
const DETERMINISTIC = 'deterministic';

export const currentEncounter = (state: CampaignState): Encounter | undefined => state.folds.gm.encounter;

const activeEncounter = (state: CampaignState, actionId: string): Encounter => {
  const encounter = currentEncounter(state);
  requireValid(actionId, encounter?.status === ACTIVE, 'no encounter is active');
  return encounter as Encounter;
};

const requireSheets = (actionId: string, participants: readonly CharacterId[], sheets: readonly TraitSheet[]) => {
  const owners = sheets.map(({ characterId }) => characterId);
  requireValid(actionId, new Set(owners).size === owners.length, 'sheets repeat a participant');
  requireValid(
    actionId,
    owners.every((id) => participants.includes(id)),
    'a sheet does not belong to a participant',
  );
  requireValid(
    actionId,
    sheets.every((sheet) => validateTraitSheet(sheet).ok),
    'a sheet is invalid',
  );
};

const requireRules = (actionId: string, { rulePack, mechanics }: EncounterRules) => {
  const ids = mechanics.map(({ ruleId }) => ruleId);
  requireValid(actionId, new Set(ids).size === ids.length, 'rule ids repeat');
  requireValid(
    actionId,
    mechanics.every((mechanic) => isDeepStrictEqual({ ...mechanic.rulePack }, { ...rulePack })),
    `a rule is not pinned to ${rulePack.id}@${rulePack.revision}`,
  );
  requireValid(
    actionId,
    mechanics.every((mechanic) => mechanic.kind !== DETERMINISTIC || parseRuleDsl(mechanic.rule.rule).ok),
    'a rule is invalid',
  );
};

export const startEncounter = (store: CampaignStore, start: EncounterStart): CommittedTurn => {
  const state = loadState(store, start.campaignId);
  const { actionId, participants, rules, sheets = [] } = start;
  const stored = replayOf(store, state, start, recorded(ENCOUNTER_STARTED, { participants, rules, sheets }));
  if (stored !== undefined) return stored;
  validate(state, start);
  requireValid(actionId, state.folds.gm.encounter?.status !== ACTIVE, 'an encounter is already active');
  requireValid(actionId, participants.length > 0, 'participants are empty');
  requireValid(actionId, new Set(participants).size === participants.length, 'participants repeat');
  const known = new Set(state.characters.map(({ id }) => id));
  requireValid(
    actionId,
    participants.every((id) => known.has(id)),
    'a participant is not in the campaign',
  );
  requireSheets(actionId, participants, sheets);
  if (rules !== undefined) requireRules(actionId, rules);
  return commitSystem(store, start, [
    [ENCOUNTER_STARTED, { encounterId: randomUUID(), participants: [...participants], rules, sheets: [...sheets] }],
  ]);
};

const seatAfter = (encounter: Encounter) => {
  const seat = encounter.participants.indexOf(encounter.actorId) + NEXT;
  const wraps = seat === encounter.participants.length;
  return {
    round: wraps ? encounter.round + NEXT : encounter.round,
    actorId: encounter.participants[wraps ? FIRST_SEAT : seat] as CharacterId,
  };
};

const pinnedRule = (encounter: Encounter, actionId: string, ruleId: string): RuleDsl => {
  const mechanic = encounter.rules?.mechanics.find((candidate) => candidate.ruleId === ruleId);
  requireValid(actionId, mechanic !== undefined, `rule ${ruleId} is not in the pinned RulePack`);
  requireValid(actionId, mechanic?.kind === DETERMINISTIC, `rule ${ruleId} needs GM adjudication`);
  return (mechanic as Extract<EffectiveMechanic, { kind: typeof DETERMINISTIC }>).rule.rule;
};

export const actInEncounter = (store: CampaignStore, move: EncounterMove): CommittedTurn => {
  const { actionId, actorId, ruleId, rng, modifiers } = move;
  const state = loadState(store, move.campaignId);
  const applied = { ...(modifiers ?? NO_MODIFIERS) };
  const stored = replayOf(store, state, move, recorded(ENCOUNTER_ACTION_RESOLVED, { ruleId, modifiers: applied }));
  if (stored !== undefined) return stored;
  validate(state, move);
  const encounter = activeEncounter(state, actionId);
  requireValid(actionId, encounter.actorId === actorId, `it is not ${actorId}'s turn`);
  const rule = pinnedRule(encounter, actionId, ruleId);
  const { dslVersion } = rule;
  const sheet = encounter.sheets[actorId] as TraitSheet;
  const result = resolveAction({ actionId, rule, sheet, rng, modifiers: applied });
  requireValid(actionId, result.ok || result.error.code !== INVALID_ACTION, 'modifiers are invalid');
  const resolution: EncounterResolution = result.ok
    ? { ok: true, changes: result.changes, events: result.events, rolls: result.rolls }
    : result;
  const { id: encounterId, round } = encounter;
  return commitSystem(store, move, [
    [ENCOUNTER_ACTION_RESOLVED, { encounterId, actorId, round, ruleId, dslVersion, modifiers: applied, resolution }],
    [ENCOUNTER_TURN_ADVANCED, { encounterId, ...seatAfter(encounter) }],
  ]);
};

export const resolveEncounter = (store: CampaignStore, end: EncounterEnd): CommittedTurn => {
  const state = loadState(store, end.campaignId);
  const stored = replayOf(store, state, end, recorded(ENCOUNTER_RESOLVED, { outcome: end.outcome }));
  if (stored !== undefined) return stored;
  validate(state, end);
  const { actionId, outcome } = end;
  const { id: encounterId } = activeEncounter(state, actionId);
  requireValid(actionId, outcome.trim() !== '', 'outcome is blank');
  return commitSystem(store, end, [[ENCOUNTER_RESOLVED, { encounterId, outcome }]]);
};
