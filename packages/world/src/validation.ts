import type { BranchId, CampaignChange, CampaignId } from '../../domain/src/campaign.ts';
import type { WorldActor } from './actor.ts';
import { type ActionProposal, scopeIssue } from './planner.ts';
import { FOREIGN_ACTOR } from './scheduler.ts';
import { isActorAction, MALFORMED_ACTION } from './world.ts';

export const WORLD_ACTION_APPLIED = 'WorldActionApplied';
export const STALE_REVISION = 'stale world revision';
export const STALE_TICK = 'proposal tick is not the current tick';
export const ALREADY_COMMITTED = 'action already committed';
export const MALFORMED_CHECK = 'malformed ruleset check result';
export const INVALID_COST = 'invalid resource cost';
export const INSUFFICIENT_RESOURCE = 'insufficient resource';
export const COMMIT_CONFLICT = 'commit port rejected the change';
const MIN_COST = 0;

export type ResourceCosts = Readonly<Record<string, number>>;
export type CheckResult =
  | { readonly ok: true; readonly costs: ResourceCosts; readonly outcome: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };
export type RulesetCheckPort = (proposal: ActionProposal, actor: WorldActor) => CheckResult;
export type CanonView = {
  readonly campaignId: CampaignId;
  readonly branchId: BranchId;
  readonly revision: number;
  readonly tick: number;
  readonly committed: readonly string[];
};
export type WorldCommit = {
  readonly expectedRevision: number;
  readonly actor: WorldActor;
  readonly event: CampaignChange;
};
export type WorldCommitPort = (commit: WorldCommit) => boolean;
export type ApplyRequest = {
  readonly canon: CanonView;
  readonly actor: WorldActor;
  readonly proposal: ActionProposal;
  readonly expectedRevision: number;
  readonly check: RulesetCheckPort;
  readonly commit: WorldCommitPort;
};
export type ApplyResult = ({ readonly ok: true } & WorldCommit) | { readonly ok: false; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const precondition = ({ canon, actor, proposal, expectedRevision }: ApplyRequest) => {
  if (expectedRevision !== canon.revision) return STALE_REVISION;
  if (!isActorAction(proposal) || !Array.isArray(proposal.resourceRefs)) return MALFORMED_ACTION;
  if (proposal.tick !== canon.tick) return STALE_TICK;
  if (canon.committed.includes(proposal.actionId)) return ALREADY_COMMITTED;
  if (proposal.actorId !== actor.id) return FOREIGN_ACTOR;
  return scopeIssue(actor, proposal, proposal.tick);
};

const runCheck = (check: RulesetCheckPort, proposal: ActionProposal, actor: WorldActor): CheckResult => {
  try {
    const result: unknown = structuredClone(check(structuredClone(proposal), structuredClone(actor)));
    if (isRecord(result) && result.ok === false && typeof result.reason === 'string') return result as CheckResult;
    if (isRecord(result) && result.ok === true && isRecord(result.costs) && isRecord(result.outcome))
      return result as CheckResult;
  } catch {}
  return { ok: false, reason: MALFORMED_CHECK };
};

const costIssue = (actor: WorldActor, proposal: ActionProposal, costs: ResourceCosts) => {
  for (const [ref, cost] of Object.entries(costs)) {
    if (!Number.isFinite(cost) || cost < MIN_COST || !proposal.resourceRefs.includes(ref)) return INVALID_COST;
    if ((actor.resources[ref] as number) < cost) return INSUFFICIENT_RESOURCE;
  }
  return undefined;
};

const charged = (actor: WorldActor, costs: ResourceCosts): WorldActor => ({
  ...actor,
  resources: Object.fromEntries(
    Object.entries(actor.resources).map(([ref, amount]) => [ref, amount - (costs[ref] ?? MIN_COST)]),
  ),
});

const appliedEvent = (canon: CanonView, proposal: ActionProposal, costs: ResourceCosts, outcome: object) => ({
  id: `${proposal.actionId}:${WORLD_ACTION_APPLIED}`,
  campaignId: canon.campaignId,
  branchId: canon.branchId,
  actionId: proposal.actionId,
  type: WORLD_ACTION_APPLIED,
  payload: {
    actorId: proposal.actorId,
    kind: proposal.kind,
    tick: proposal.tick,
    knowledgeRefs: [...proposal.knowledgeRefs],
    costs,
    outcome,
  },
});

export const applyProposal = (request: ApplyRequest): ApplyResult => {
  const reject = (reason: string) => ({ ok: false, reason }) as const;
  const issue = precondition(request);
  if (issue !== undefined) return reject(issue);
  const { canon, actor, proposal, expectedRevision } = request;
  const result = runCheck(request.check, proposal, actor);
  if (!result.ok) return reject(result.reason);
  const spend = costIssue(actor, proposal, result.costs);
  if (spend !== undefined) return reject(spend);
  const commit: WorldCommit = {
    expectedRevision,
    actor: charged(actor, result.costs),
    event: appliedEvent(canon, proposal, result.costs, result.outcome),
  };
  return request.commit(structuredClone(commit)) ? { ok: true, ...commit } : reject(COMMIT_CONFLICT);
};
