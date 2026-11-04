import { randomUUID } from 'node:crypto';
import type {
  CampaignEvent,
  CampaignState,
  CampaignStore,
  CharacterId,
  CommittedTurn,
  EventId,
} from '../../domain/src/campaign.ts';
import type { Rng, RollEvent } from '../../rules/src/dice.ts';
import { parseRuleDsl, type RuleDsl } from '../../rules/src/dsl.ts';
import { type ResolutionError, type RuleEvent, resolveAction, type TraitChange } from '../../rules/src/resolve.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import {
  commit,
  InvalidActionError,
  loadState,
  type PlayerAction,
  requireValid,
  storedTurn,
  validate,
} from './turn.ts';

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
};

export type EncounterStart = PlayerAction & { readonly participants: readonly CharacterId[] };
export type EncounterMove = PlayerAction & {
  readonly rule: unknown;
  readonly sheet: TraitSheet;
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
    return { ...encounter, actions: [...encounter.actions, action] };
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

export const startEncounter = (store: CampaignStore, start: EncounterStart): CommittedTurn => {
  const state = loadState(store, start.campaignId);
  const stored = storedTurn(state, start.actionId);
  if (stored !== undefined) return stored;
  validate(state, start);
  const { actionId, participants } = start;
  requireValid(actionId, currentEncounter(state.events)?.status !== ACTIVE, 'an encounter is already active');
  requireValid(actionId, participants.length > 0, 'participants are empty');
  requireValid(actionId, new Set(participants).size === participants.length, 'participants repeat');
  const known = new Set(state.characters.map(({ id }) => id));
  requireValid(
    actionId,
    participants.every((id) => known.has(id)),
    'a participant is not in the campaign',
  );
  return commit(store, start, [[STARTED, { encounterId: randomUUID(), participants: [...participants] }]]);
};

const seatAfter = (encounter: Encounter) => {
  const seat = encounter.participants.indexOf(encounter.actorId) + NEXT;
  const wraps = seat === encounter.participants.length;
  return {
    round: wraps ? encounter.round + NEXT : encounter.round,
    actorId: encounter.participants[wraps ? FIRST_SEAT : seat] as CharacterId,
  };
};

export const actInEncounter = (store: CampaignStore, move: EncounterMove): CommittedTurn => {
  const state = loadState(store, move.campaignId);
  const stored = storedTurn(state, move.actionId);
  if (stored !== undefined) return stored;
  validate(state, move);
  const { actionId, actorId, rule, sheet, rng, modifiers } = move;
  const encounter = activeEncounter(state, actionId);
  requireValid(actionId, encounter.actorId === actorId, `it is not ${actorId}'s turn`);
  requireValid(actionId, sheet.characterId === actorId, `sheet does not belong to ${actorId}`);
  const parsed = parseRuleDsl(rule);
  if (!parsed.ok) throw new InvalidActionError(actionId, 'rule is invalid');
  const { id: ruleId, dslVersion } = parsed.rule;
  const applied = { ...(modifiers ?? NO_MODIFIERS) };
  const result = resolveAction({ actionId, rule, sheet, rng, modifiers: applied });
  requireValid(actionId, result.ok || result.error.code !== INVALID_ACTION, 'sheet or modifiers are invalid');
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
  const stored = storedTurn(state, end.actionId);
  if (stored !== undefined) return stored;
  validate(state, end);
  const { actionId, outcome } = end;
  const { id: encounterId } = activeEncounter(state, actionId);
  requireValid(actionId, outcome.trim() !== '', 'outcome is blank');
  return commit(store, end, [[RESOLVED, { encounterId, outcome }]]);
};
