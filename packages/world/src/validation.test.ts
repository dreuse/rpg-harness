import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldActor, startCooldown, type WorldActor } from './actor.ts';
import { type ActionProposal, INVENTED_RESOURCE, ON_COOLDOWN, UNKNOWN_FACT } from './planner.ts';
import { FOREIGN_ACTOR } from './scheduler.ts';
import {
  ALREADY_COMMITTED,
  applyProposal,
  type CanonView,
  type CheckResult,
  COMMIT_CONFLICT,
  INSUFFICIENT_RESOURCE,
  INVALID_COST,
  MALFORMED_CHECK,
  type RulesetCheckPort,
  STALE_REVISION,
  STALE_TICK,
  WORLD_ACTION_APPLIED,
  type WorldCommit,
} from './validation.ts';
import { MALFORMED_ACTION } from './world.ts';

const TICK = 3;
const REVISION = 7;

const guild: WorldActor = createWorldActor({
  id: 'guild',
  kind: 'faction',
  name: 'Guild',
  resources: { coin: 5, agents: 1 },
  knowledge: [{ factId: 'route-open', channel: 'witnessed', sourceId: null, eventId: 'e1', tick: 0 }],
});

const proposal: ActionProposal = {
  actionId: `guild:trade@${TICK}`,
  actorId: 'guild',
  kind: 'trade',
  knowledgeRefs: ['route-open'],
  resourceRefs: ['coin'],
  tick: TICK,
};

const canon: CanonView = { campaignId: 'c1', branchId: 'main', revision: REVISION, tick: TICK, committed: [] };

const passing =
  (result: CheckResult = { ok: true, costs: { coin: 2 }, outcome: { margin: 1 } }): RulesetCheckPort =>
  () =>
    result;

const recorder = (accept = true) => {
  const commits: WorldCommit[] = [];
  return {
    commits,
    port: (commit: WorldCommit) => {
      commits.push(commit);
      return accept;
    },
  };
};

const apply = (overrides: Partial<Parameters<typeof applyProposal>[0]> = {}) => {
  const commit = recorder();
  const result = applyProposal({
    canon,
    actor: guild,
    proposal,
    expectedRevision: REVISION,
    check: passing(),
    commit: commit.port,
    ...overrides,
  });
  return { result, commits: commit.commits };
};

describe('W05 apply ruleset checks, resource costs, concurrency guards and event commits', () => {
  it('commits one stable event and the charged actor through the commit port', () => {
    const { result, commits } = apply();
    assert.equal(result.ok, true);
    assert.equal(commits.length, 1);
    const [commit] = commits as [WorldCommit];
    assert.equal(commit.expectedRevision, REVISION);
    assert.deepEqual(commit.actor.resources, { coin: 3, agents: 1 });
    assert.deepEqual(commit.event, {
      id: `${canon.campaignId}:${canon.branchId}:${proposal.actionId}:${WORLD_ACTION_APPLIED}`,
      campaignId: 'c1',
      branchId: 'main',
      actionId: proposal.actionId,
      type: WORLD_ACTION_APPLIED,
      payload: {
        actorId: 'guild',
        kind: 'trade',
        tick: TICK,
        knowledgeRefs: ['route-open'],
        costs: { coin: 2 },
        outcome: { margin: 1 },
      },
    });
    assert.deepEqual(result, { ok: true, ...commit });
  });

  it('passes the ruleset port isolated copies and is deterministic', () => {
    const check: RulesetCheckPort = (p, actor) => {
      (actor.resources as Record<string, number>).coin = 0;
      (p.knowledgeRefs as string[]).push('forged');
      return { ok: true, costs: {}, outcome: {} };
    };
    const first = apply({ check });
    assert.equal(guild.resources.coin, 5);
    assert.deepEqual(proposal.knowledgeRefs, ['route-open']);
    assert.deepEqual(first, apply({ check }));
  });

  it('allows spending a referenced resource down to zero', () => {
    const { result } = apply({ check: passing({ ok: true, costs: { coin: 5 }, outcome: {} }) });
    assert.equal(result.ok && result.actor.resources.coin, 0);
  });
});

describe('W05 invalid or stale proposals do not alter canon', () => {
  const rejects = (reason: string, overrides: Partial<Parameters<typeof applyProposal>[0]>) => {
    const before = structuredClone(guild);
    const { result, commits } = apply(overrides);
    assert.deepEqual(result, { ok: false, reason });
    assert.equal(commits.length, 0);
    assert.deepEqual(guild, before);
  };

  it('rejects a stale world revision', () => rejects(STALE_REVISION, { expectedRevision: REVISION - 1 }));
  it('rejects a proposal from another tick', () => rejects(STALE_TICK, { canon: { ...canon, tick: TICK + 1 } }));
  it('rejects an already committed action id', () =>
    rejects(ALREADY_COMMITTED, { canon: { ...canon, committed: [proposal.actionId] } }));
  it('rejects a malformed proposal', () =>
    rejects(MALFORMED_ACTION, { proposal: { ...proposal, actionId: '' } as ActionProposal }));
  it('rejects a proposal for another actor', () =>
    rejects(FOREIGN_ACTOR, { proposal: { ...proposal, actorId: 'thieves' } }));
  it('rejects unknown facts', () => rejects(UNKNOWN_FACT, { proposal: { ...proposal, knowledgeRefs: ['vault'] } }));
  it('rejects resources the actor does not hold', () =>
    rejects(INVENTED_RESOURCE, { proposal: { ...proposal, resourceRefs: ['gems'] } }));
  it('rejects an actor on cooldown', () => rejects(ON_COOLDOWN, { actor: startCooldown(guild, 'trade', TICK, 1) }));
  it('rejects a failed ruleset check with its reason', () =>
    rejects('rival guard', { check: passing({ ok: false, reason: 'rival guard' }) }));
  it('rejects a throwing or malformed ruleset port', () => {
    rejects(MALFORMED_CHECK, {
      check: () => {
        throw new Error('boom');
      },
    });
    rejects(MALFORMED_CHECK, { check: () => ({ ok: true }) as unknown as CheckResult });
  });
  it('rejects costs above holdings', () =>
    rejects(INSUFFICIENT_RESOURCE, { check: passing({ ok: true, costs: { coin: 6 }, outcome: {} }) }));
  it('rejects negative, non-finite or unreferenced costs', () => {
    for (const costs of [{ coin: -1 }, { coin: Number.NaN }, { agents: 1 }])
      rejects(INVALID_COST, { check: passing({ ok: true, costs, outcome: {} }) });
  });
  it('reports a commit port conflict without returning new state', () => {
    const before = structuredClone(guild);
    const result = applyProposal({
      canon,
      actor: guild,
      proposal,
      expectedRevision: REVISION,
      check: passing(),
      commit: recorder(false).port,
    });
    assert.deepEqual(result, { ok: false, reason: COMMIT_CONFLICT });
    assert.deepEqual(guild, before);
  });
});
