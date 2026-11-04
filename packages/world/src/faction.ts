import type { WorldActor } from './actor.ts';
import { type ActionProposal, createSimplePlanner } from './planner.ts';
import type { PlanRequest } from './scheduler.ts';

export const FACTION_STRATEGIES = ['negotiate', 'compete', 'expand', 'retreat'] as const;
export const FULL_COVERAGE = 1;
export const RETREAT_COVERAGE = 0.25;
const FACTION_KIND = 'faction';
const NONE = 0;

export type FactionStrategy = (typeof FACTION_STRATEGIES)[number];
export type FactionTargets = Readonly<Record<string, number>>;

const isTarget = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > NONE;
const targetedGoals = (actor: WorldActor, targets: FactionTargets) =>
  actor.goals.filter((goal) => Object.hasOwn(targets, goal) && isTarget(targets[goal]));
const held = (actor: WorldActor, goal: string) => Math.max(NONE, actor.resources[goal] ?? NONE);
const strength = (actor: WorldActor, goals: readonly string[]) => goals.reduce((sum, g) => sum + held(actor, g), NONE);
const coverage = (actor: WorldActor, goals: readonly string[], targets: FactionTargets) =>
  goals.reduce((sum, g) => sum + Math.min(held(actor, g), targets[g] as number), NONE) /
  goals.reduce((sum, g) => sum + (targets[g] as number), NONE);

export const decideStrategy = (
  actor: WorldActor,
  others: readonly WorldActor[],
  targets: FactionTargets,
): FactionStrategy | undefined => {
  const goals = targetedGoals(actor, targets);
  if (goals.length === NONE) return undefined;
  const covered = coverage(actor, goals, targets);
  if (covered >= FULL_COVERAGE) return 'expand';
  const rivalries = others
    .filter((other) => other.kind === FACTION_KIND && other.id !== actor.id)
    .map((rival) => ({ rival, shared: goals.filter((g) => rival.goals.includes(g)) }))
    .filter(({ shared }) => shared.length > NONE);
  if (rivalries.length === NONE) return 'expand';
  if (rivalries.every(({ rival, shared }) => strength(actor, shared) > strength(rival, shared))) return 'compete';
  return covered < RETREAT_COVERAGE ? 'retreat' : 'negotiate';
};

export const createFactionPlanner = (actors: readonly WorldActor[], targets: FactionTargets) => {
  const index = new Map(actors.map((actor) => [actor.id, actor]));
  return (request: PlanRequest): ActionProposal[] => {
    const actor = index.get(request.actorId);
    if (actor?.kind !== FACTION_KIND || actor.knowledge.length === NONE) return [];
    const strategy = decideStrategy(actor, actors, targets);
    if (strategy === undefined) return [];
    const behavior = {
      kind: strategy,
      knowledgeRefs: actor.knowledge.map((k) => k.factId),
      resourceRefs: targetedGoals(actor, targets).filter((g) => held(actor, g) > NONE),
    };
    return createSimplePlanner([actor], [behavior])(request);
  };
};
