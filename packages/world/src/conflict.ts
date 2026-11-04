import { MAX_ACTOR_ENTRIES } from './actor.ts';
import type { ActionProposal } from './planner.ts';
import { isActorAction, MALFORMED_ACTION, type Rejection } from './world.ts';

export const CONTESTED_CLAIM = 'exclusive claim already won by another action';
export const DUPLICATE_ACTION_ID = 'duplicate action id in batch';
export const MALFORMED_CLAIM = 'malformed claim';

export type ActionClaim = { readonly exclusive: readonly string[]; readonly priority: number };
export type ClaimPort = (proposal: ActionProposal) => ActionClaim;
export type ConflictRejection = Rejection & { readonly claim: string | null; readonly winnerId: string | null };
export type ConflictResolution = {
  readonly accepted: readonly ActionProposal[];
  readonly rejected: readonly ConflictRejection[];
};
type Claimed = { readonly proposal: ActionProposal; readonly claim: ActionClaim };

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const stableKey = (p: unknown) => {
  try {
    return JSON.stringify(p) ?? '';
  } catch {
    return '';
  }
};
const isProposal = (v: unknown): v is ActionProposal =>
  isActorAction(v) && Array.isArray((v as Partial<ActionProposal>).resourceRefs);
const byStableKey = (a: ActionProposal, b: ActionProposal) =>
  compareText(a.actionId, b.actionId) || compareText(stableKey(a), stableKey(b));
const byResolutionOrder = (a: Claimed, b: Claimed) =>
  a.proposal.tick - b.proposal.tick || b.claim.priority - a.claim.priority || byStableKey(a.proposal, b.proposal);

const readClaim = (port: ClaimPort, proposal: ActionProposal): ActionClaim | undefined => {
  try {
    const raw: unknown = structuredClone(port(structuredClone(proposal)));
    const { exclusive, priority } = (raw ?? {}) as Record<string, unknown>;
    if (
      Array.isArray(exclusive) &&
      exclusive.length <= MAX_ACTOR_ENTRIES &&
      exclusive.every(isNonEmpty) &&
      Number.isFinite(priority)
    )
      return { exclusive, priority: priority as number };
  } catch {}
  return undefined;
};

const invalid = (action: unknown, reason: string): ConflictRejection => ({
  action: action as ActionProposal,
  reason,
  claim: null,
  winnerId: null,
});

export const resolveConflicts = (proposals: readonly ActionProposal[], port: ClaimPort): ConflictResolution => {
  const invalids = proposals
    .filter((p) => !isProposal(p))
    .map((p) => ({ p, key: stableKey(p) }))
    .sort((a, b) => compareText(a.key, b.key))
    .map(({ p }) => invalid(p, MALFORMED_ACTION));
  const wellFormed = proposals.filter(isProposal);
  const counts = new Map<string, number>();
  for (const p of wellFormed) counts.set(p.actionId, (counts.get(p.actionId) ?? 0) + 1);
  const claimed: Claimed[] = [];
  for (const proposal of wellFormed.sort(byStableKey)) {
    if (counts.get(proposal.actionId) !== 1) {
      invalids.push(invalid(proposal, DUPLICATE_ACTION_ID));
      continue;
    }
    const claim = readClaim(port, proposal);
    if (claim === undefined) invalids.push(invalid(proposal, MALFORMED_CLAIM));
    else claimed.push({ proposal, claim });
  }
  const owners = new Map<string, string>();
  const accepted: ActionProposal[] = [];
  const contested: ConflictRejection[] = [];
  for (const { proposal, claim } of claimed.sort(byResolutionOrder)) {
    const taken = claim.exclusive.find((key) => owners.has(key));
    if (taken !== undefined) {
      contested.push({ action: proposal, reason: CONTESTED_CLAIM, claim: taken, winnerId: owners.get(taken) ?? null });
      continue;
    }
    for (const key of claim.exclusive) owners.set(key, proposal.actionId);
    accepted.push(proposal);
  }
  return { accepted, rejected: [...invalids, ...contested] };
};
