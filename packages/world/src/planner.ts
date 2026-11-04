import { type ActorKind, canDecide, MAX_ACTOR_ENTRIES, unknownRefs, type WorldActor } from './actor.ts';
import { FOREIGN_ACTOR, type PlanRequest } from './scheduler.ts';
import type { ActorAction, LogicalClock, Trigger } from './world.ts';

export const MAX_PROPOSALS_PER_ACTOR = 4;
export const MAX_LLM_DRAFTS = 8;
export const MALFORMED_OUTPUT = 'malformed llm output';
export const MALFORMED_DRAFT = 'malformed draft';
export const PORT_FAILURE = 'llm planner port failed';
export const UNKNOWN_ACTOR = 'unknown actor';
export const UNKNOWN_FACT = 'references a fact the actor does not know';
export const INVENTED_RESOURCE = 'references a resource the actor does not own';
export const UNEXPECTED_FIELD = 'unexpected field in draft';
export const KIND_NOT_PERMITTED = 'kind not permitted';
export const ON_COOLDOWN = 'decision on cooldown';
export const DUPLICATE_ACTION = 'duplicate action id';
export const PROPOSAL_LIMIT = 'proposal limit reached';
const DRAFT_FIELDS = ['actorId', 'kind', 'knowledgeRefs', 'resourceRefs'];
const MIN_KNOWLEDGE_REFS = 1;
const MIN_RESOURCE_REFS = 0;

export type ActionProposal = ActorAction & { readonly resourceRefs: readonly string[] };
export type SimpleBehavior = Pick<ActionProposal, 'kind' | 'knowledgeRefs' | 'resourceRefs'>;
export type LlmPlanContext = {
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly goals: readonly string[];
  readonly knownFacts: readonly string[];
  readonly resources: Readonly<Record<string, number>>;
  readonly allowedKinds: readonly string[];
  readonly clock: LogicalClock;
  readonly triggers: readonly Trigger[];
};
export type LlmPlannerPort = (context: LlmPlanContext) => Promise<unknown>;
export type DraftRejection = { readonly item: unknown; readonly reason: string };
export type PlanOutcome = {
  readonly source: 'llm' | 'fallback' | 'rejected';
  readonly proposals: readonly ActionProposal[];
  readonly rejected: readonly DraftRejection[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isRefs = (v: unknown, min: number): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= MAX_ACTOR_ENTRIES && Array.from(v).every(isNonEmpty);

const owns = (actor: WorldActor, ref: string) =>
  Object.hasOwn(actor.resources, ref) && (actor.resources[ref] as number) > 0;

const scopeIssue = (actor: WorldActor, behavior: SimpleBehavior, tick: number) => {
  if (behavior.knowledgeRefs.length === 0 || unknownRefs(actor, behavior.knowledgeRefs).length > 0) return UNKNOWN_FACT;
  if (!behavior.resourceRefs.every((ref) => owns(actor, ref))) return INVENTED_RESOURCE;
  if (!canDecide(actor, behavior.kind, tick)) return ON_COOLDOWN;
  return undefined;
};

const propose = (actor: WorldActor, { kind, knowledgeRefs, resourceRefs }: SimpleBehavior, tick: number) => ({
  actionId: `${actor.id}:${kind}@${tick}`,
  actorId: actor.id,
  kind,
  knowledgeRefs: [...knowledgeRefs],
  resourceRefs: [...resourceRefs],
  tick,
});

const simplePlan = (actor: WorldActor, behaviors: readonly SimpleBehavior[], tick: number) => {
  const proposals: ActionProposal[] = [];
  for (const behavior of behaviors) {
    if (proposals.length >= MAX_PROPOSALS_PER_ACTOR) break;
    const proposal = propose(actor, behavior, tick);
    if (scopeIssue(actor, behavior, tick) === undefined && !proposals.some((p) => p.actionId === proposal.actionId))
      proposals.push(proposal);
  }
  return proposals;
};

const indexed = (actors: readonly WorldActor[]) => new Map(actors.map((actor) => [actor.id, actor]));

export const createSimplePlanner = (actors: readonly WorldActor[], behaviors: readonly SimpleBehavior[]) => {
  const index = indexed(actors);
  return ({ actorId, clock }: PlanRequest): ActionProposal[] => {
    const actor = index.get(actorId);
    return actor === undefined ? [] : simplePlan(actor, behaviors, clock.tick);
  };
};

const contextFor = (actor: WorldActor, allowedKinds: readonly string[], request: PlanRequest): LlmPlanContext =>
  structuredClone({
    actorId: actor.id,
    actorKind: actor.kind,
    goals: actor.goals,
    knownFacts: actor.knowledge.map((k) => k.factId),
    resources: actor.resources,
    allowedKinds,
    clock: request.clock,
    triggers: request.triggers,
  });

const draftIssue = (actor: WorldActor, allowedKinds: readonly string[], item: unknown, tick: number) => {
  if (!isRecord(item)) return MALFORMED_DRAFT;
  if (Object.keys(item).some((key) => !DRAFT_FIELDS.includes(key))) return UNEXPECTED_FIELD;
  if (
    !isNonEmpty(item.actorId) ||
    !isNonEmpty(item.kind) ||
    !isRefs(item.knowledgeRefs, MIN_KNOWLEDGE_REFS) ||
    !isRefs(item.resourceRefs, MIN_RESOURCE_REFS)
  )
    return MALFORMED_DRAFT;
  if (item.actorId !== actor.id) return FOREIGN_ACTOR;
  if (!allowedKinds.includes(item.kind)) return KIND_NOT_PERMITTED;
  return scopeIssue(actor, item as SimpleBehavior, tick);
};

const fromDrafts = (actor: WorldActor, allowedKinds: readonly string[], drafts: readonly unknown[], tick: number) => {
  const proposals: ActionProposal[] = [];
  const rejected: DraftRejection[] = [];
  for (const item of drafts) {
    const issue = draftIssue(actor, allowedKinds, item, tick);
    if (issue !== undefined) {
      rejected.push({ item, reason: issue });
      continue;
    }
    const proposal = propose(actor, item as SimpleBehavior, tick);
    if (proposals.some((p) => p.actionId === proposal.actionId)) rejected.push({ item, reason: DUPLICATE_ACTION });
    else if (proposals.length >= MAX_PROPOSALS_PER_ACTOR) rejected.push({ item, reason: PROPOSAL_LIMIT });
    else proposals.push(proposal);
  }
  return { source: 'llm', proposals, rejected } as const;
};

export const createLlmPlanner = (
  actors: readonly WorldActor[],
  behaviors: readonly SimpleBehavior[],
  port: LlmPlannerPort,
) => {
  const index = indexed(actors);
  const allowedKinds = [...new Set(behaviors.map((b) => b.kind))];
  return async (request: PlanRequest): Promise<PlanOutcome> => {
    const actor = index.get(request.actorId);
    if (actor === undefined)
      return { source: 'rejected', proposals: [], rejected: [{ item: request.actorId, reason: UNKNOWN_ACTOR }] };
    const tick = request.clock.tick;
    const fallback = (rejection: DraftRejection): PlanOutcome => ({
      source: 'fallback',
      proposals: simplePlan(actor, behaviors, tick),
      rejected: [rejection],
    });
    let output: unknown;
    try {
      output = structuredClone(await port(contextFor(actor, allowedKinds, request)));
    } catch {
      return fallback({ item: null, reason: PORT_FAILURE });
    }
    if (!Array.isArray(output) || output.length > MAX_LLM_DRAFTS)
      return fallback({ item: output, reason: MALFORMED_OUTPUT });
    return fromDrafts(actor, allowedKinds, output, tick);
  };
};
