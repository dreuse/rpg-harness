import type { WorldActor } from './actor.ts';
import type { ActionProposal } from './planner.ts';
import type { SimulationMode } from './world.ts';

export const DETERMINISTIC = 'deterministic';
export const GM_ADJUDICATED = 'gm-adjudicated';
export const SIMULATION_DISABLED = 'world simulation capability is disabled';
export const UNSUPPORTED_MECHANIC = 'mechanic is not supported by the effective rule pack';
export const OUTSIDE_TIME_LIMIT = 'proposal tick is outside the allowed time window';
export const FACTION_CONSTRAINT = 'faction constraint forbids this action kind';
export const HOUSE_RULE = 'house rule forbids this action kind';
const DISABLED_MODE: SimulationMode = 'off';

export type MechanicSupport = typeof DETERMINISTIC | typeof GM_ADJUDICATED;
export type SimulationPolicy = {
  readonly mode: SimulationMode;
  readonly time?: { readonly fromTick: number; readonly untilTick: number };
  readonly factionKinds?: Readonly<Record<string, readonly string[]>>;
  readonly forbiddenKinds?: readonly string[];
  readonly mechanics?: Readonly<Record<string, MechanicSupport>>;
  readonly adjudicator: boolean;
};
export type PolicyDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'adjudicated' | 'rejected' | 'disabled'; readonly reason: string };

const constraintIssue = (policy: SimulationPolicy, actor: WorldActor, { kind, tick }: ActionProposal) => {
  if (policy.time && (tick < policy.time.fromTick || tick > policy.time.untilTick)) return OUTSIDE_TIME_LIMIT;
  const factions = policy.factionKinds;
  const factionKinds =
    actor.kind === 'faction' && factions && Object.hasOwn(factions, actor.id) ? factions[actor.id] : undefined;
  if (factionKinds && !factionKinds.includes(kind)) return FACTION_CONSTRAINT;
  if (policy.forbiddenKinds?.includes(kind)) return HOUSE_RULE;
  return undefined;
};

const mechanicIssue = ({ mechanics }: SimulationPolicy, kind: string) => {
  if (mechanics === undefined) return undefined;
  const support = Object.hasOwn(mechanics, kind) ? mechanics[kind] : undefined;
  if (support === DETERMINISTIC) return undefined;
  return support === GM_ADJUDICATED ? GM_ADJUDICATED : UNSUPPORTED_MECHANIC;
};

export const evaluatePolicy = (
  policy: SimulationPolicy,
  actor: WorldActor,
  proposal: ActionProposal,
): PolicyDecision => {
  if (policy.mode === DISABLED_MODE) return { status: 'disabled', reason: SIMULATION_DISABLED };
  const constraint = constraintIssue(policy, actor, proposal);
  if (constraint !== undefined) return { status: 'rejected', reason: constraint };
  const mechanic = mechanicIssue(policy, proposal.kind);
  if (mechanic === undefined) return { status: 'allowed' };
  if (!policy.adjudicator) return { status: 'disabled', reason: UNSUPPORTED_MECHANIC };
  return { status: 'adjudicated', reason: mechanic };
};
