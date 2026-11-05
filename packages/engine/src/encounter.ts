import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CampaignEvent,
  CampaignState,
  CampaignStore,
  CharacterId,
  CommittedTurn,
  EventId,
} from '../../domain/src/campaign.ts';
import type { RulePackLink } from '../../domain/src/character.ts';
import type { Rng, RollEvent } from '../../rules/src/dice.ts';
import { type EffectiveMechanic, parseRuleDsl, type RuleDsl } from '../../rules/src/dsl.ts';
import { type ResolutionError, type RuleEvent, resolveAction, type TraitChange } from '../../rules/src/resolve.ts';
import { type Trait, type TraitSheet, type TraitValue, validateTraitSheet } from '../../rules/src/traits.ts';
import { commit, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export type EncounterId = string;
export type EncounterStatus = 'active' | 'resolved';
export type EncounterResolution =
  | { readonly ok: true; readonly changes: TraitChange[]; readonly events: RuleEvent[]; readonly rolls: RollEvent[] }
  | { readonly ok: false; readonly error: ResolutionError; readonly rolls: RollEvent[] };
export type EncounterAction = {
  readonly eventId: EventId;
  readonly actorId: CharacterId;
  readonly round: number;
  readonly ruleId: string;
  readonly dslVersion: RuleDsl['dslVersion'];
  readonly modifiers: Readonly<Record<string, number>>;
  readonly resolution: EncounterResolution;
};
export type Encounter = {
  readonly id: EncounterId;
  readonly participants: readonly CharacterId[];
  readonly status: EncounterStatus;
  readonly round: number;
  readonly actorId: CharacterId;
  readonly outcome: string | undefined;
  readonly actions: readonly EncounterAction[];
  readonly rules: EncounterRules | undefined;
  readonly sheets: Readonly<Record<CharacterId, TraitSheet>>;
};
export type EncounterRules = { readonly rulePack: RulePackLink; readonly mechanics: readonly EffectiveMechanic[] };

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

const STARTED = 'EncounterStarted';
const ACTION_RESOLVED = 'EncounterActionResolved';
const TURN_ADVANCED = 'EncounterTurnAdvanced';
const RESOLVED = 'EncounterResolved';
const ACTIVE: EncounterStatus = 'active';
const FIRST_ROUND = 1;
const FIRST_SEAT = 0;
const NEXT = 1;
const INVALID_ACTION = 'InvalidAction';
const NO_MODIFIERS: Readonly<Record<string, number>> = {};
const DETERMINISTIC = 'deterministic';

const blankSheet = (characterId: CharacterId): TraitSheet => ({ characterId, traits: [] });

const sheetsOf = (participants: readonly CharacterId[], sheets: readonly TraitSheet[]) =>
  Object.fromEntries(
    participants.map((id) => [id, sheets.find(({ characterId }) => characterId === id) ?? blankSheet(id)]),
  );

const changed = (trait: Trait, to: TraitValue): Trait => {
  if (trait.kind === 'resource') return { ...trait, current: Number(to) };
  if (trait.kind === 'trait') return { ...trait, value: to };
  return trait;
};

const applyChanges = (sheet: TraitSheet, changes: readonly TraitChange[]): TraitSheet => {
  const latest = new Map(changes.map(({ id, to }) => [id, to]));
  return {
    ...sheet,
    traits: sheet.traits.map((trait) => {
      const to = latest.get(trait.id);
      return to === undefined ? trait : changed(trait, to);
    }),
  };
};

type Payload = Readonly<Record<string, unknown>>;

const fold = (encounter: Encounter | undefined, { id, type, payload }: CampaignEvent): Encounter | undefined => {
  const data = payload as Payload;
  if (type === STARTED) {
    const participants = data.participants as CharacterId[];
    return {
      id: String(data.encounterId),
      participants,
      status: ACTIVE,
      round: FIRST_ROUND,
      actorId: participants[FIRST_SEAT] as CharacterId,
      outcome: undefined,
      actions: [],
      rules: data.rules as EncounterRules | undefined,
      sheets: sheetsOf(participants, (data.sheets ?? []) as TraitSheet[]),
    };
  }
  if (encounter === undefined || data.encounterId !== encounter.id) return encounter;
  if (type === ACTION_RESOLVED) {
    const action = {
      eventId: id,
      actorId: String(data.actorId),
      round: Number(data.round),
      ruleId: String(data.ruleId),
      dslVersion: data.dslVersion as RuleDsl['dslVersion'],
      modifiers: data.modifiers as Readonly<Record<string, number>>,
      resolution: data.resolution as EncounterResolution,
    };
    const { resolution, actorId } = action;
    const sheets = resolution.ok
      ? { ...encounter.sheets, [actorId]: applyChanges(encounter.sheets[actorId] as TraitSheet, resolution.changes) }
      : encounter.sheets;
    return { ...encounter, actions: [...encounter.actions, action], sheets };
  }
  if (type === TURN_ADVANCED) return { ...encounter, round: Number(data.round), actorId: String(data.actorId) };
  if (type === RESOLVED) return { ...encounter, status: 'resolved', outcome: String(data.outcome) };
  return encounter;
};

export const currentEncounter = (events: readonly CampaignEvent[]): Encounter | undefined =>
  events.reduce<Encounter | undefined>(fold, undefined);

const activeEncounter = (state: CampaignState, actionId: string): Encounter => {
  const encounter = currentEncounter(state.events);
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
  const stored = replayOf(store, state, start, recorded(STARTED, { participants, rules, sheets }));
  if (stored !== undefined) return stored;
  validate(state, start);
  requireValid(actionId, currentEncounter(state.events)?.status !== ACTIVE, 'an encounter is already active');
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
  return commit(store, start, [
    [STARTED, { encounterId: randomUUID(), participants: [...participants], rules, sheets: [...sheets] }],
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
  const stored = replayOf(store, state, move, recorded(ACTION_RESOLVED, { ruleId, modifiers: applied }));
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
  return commit(store, move, [
    [ACTION_RESOLVED, { encounterId, actorId, round, ruleId, dslVersion, modifiers: applied, resolution }],
    [TURN_ADVANCED, { encounterId, ...seatAfter(encounter) }],
  ]);
};

export const resolveEncounter = (store: CampaignStore, end: EncounterEnd): CommittedTurn => {
  const state = loadState(store, end.campaignId);
  const stored = replayOf(store, state, end, recorded(RESOLVED, { outcome: end.outcome }));
  if (stored !== undefined) return stored;
  validate(state, end);
  const { actionId, outcome } = end;
  const { id: encounterId } = activeEncounter(state, actionId);
  requireValid(actionId, outcome.trim() !== '', 'outcome is blank');
  return commit(store, end, [[RESOLVED, { encounterId, outcome }]]);
};
