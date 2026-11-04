import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldActor, type WorldActor } from './actor.ts';
import type { ActionProposal } from './planner.ts';
import {
  DETERMINISTIC,
  evaluatePolicy,
  FACTION_CONSTRAINT,
  GM_ADJUDICATED,
  HOUSE_RULE,
  OUTSIDE_TIME_LIMIT,
  SIMULATION_DISABLED,
  type SimulationPolicy,
  UNSUPPORTED_MECHANIC,
} from './policy.ts';
import {
  applyProposal,
  type CanonView,
  type RulesetCheckPort,
  WORLD_ACTION_ADJUDICATED,
  WORLD_ACTION_APPLIED,
  type WorldCommit,
} from './validation.ts';

const TICK = 3;
const REVISION = 7;

const guild: WorldActor = createWorldActor({
  id: 'guild',
  kind: 'faction',
  name: 'Guild',
  resources: { coin: 5 },
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

const bare: SimulationPolicy = { mode: 'balanced', adjudicator: true };
const mechanics = { trade: DETERMINISTIC, smuggle: GM_ADJUDICATED } as const;
const policy: SimulationPolicy = {
  ...bare,
  time: { fromTick: 1, untilTick: TICK },
  factionKinds: { guild: ['trade', 'smuggle'] },
  forbiddenKinds: ['assassinate'],
  mechanics,
};

const applyWith = (active: SimulationPolicy, kind = proposal.kind) => {
  const commits: WorldCommit[] = [];
  let checks = 0;
  const check: RulesetCheckPort = () => {
    checks++;
    return { ok: true, costs: { coin: 1 }, outcome: {} };
  };
  const result = applyProposal({
    canon,
    actor: guild,
    proposal: { ...proposal, kind, actionId: `guild:${kind}@${TICK}` },
    expectedRevision: REVISION,
    check,
    commit: (commit) => {
      commits.push(commit);
      return true;
    },
    policy: active,
  });
  return { result, commits, checks };
};

const apply = (overrides: Partial<SimulationPolicy> = {}, kind?: string) =>
  applyWith({ ...policy, ...overrides }, kind);

describe('W10 integrate genre and imported rule simulation policies', () => {
  it('world simulation respects time, faction and house-rule constraints where available', () => {
    const allowed = apply();
    assert.equal(allowed.result.ok, true);
    assert.equal(allowed.commits[0]?.event.type, WORLD_ACTION_APPLIED);

    const rejected = (reason: string, overrides: Partial<SimulationPolicy>, kind?: string) => {
      const { result, commits, checks } = apply(overrides, kind);
      assert.deepEqual(result, { ok: false, reason });
      assert.equal(commits.length, 0);
      assert.equal(checks, 0);
    };
    rejected(OUTSIDE_TIME_LIMIT, { time: { fromTick: TICK + 1, untilTick: TICK + 2 } });
    rejected(OUTSIDE_TIME_LIMIT, { time: { fromTick: 0, untilTick: TICK - 1 } });
    rejected(FACTION_CONSTRAINT, { factionKinds: { guild: ['negotiate'] } });
    rejected(HOUSE_RULE, { forbiddenKinds: ['trade'] });

    const unconstrained = applyWith({ ...bare, mechanics });
    assert.equal(unconstrained.result.ok, true);
    const otherFaction = apply({ factionKinds: { thieves: ['negotiate'] } });
    assert.equal(otherFaction.result.ok, true);
  });

  it('unsupported mechanics are adjudicated visibly or simulation capability is disabled', () => {
    const disabled = (overrides: Partial<SimulationPolicy>, reason: string, kind?: string) => {
      const { result, commits, checks } = apply(overrides, kind);
      assert.deepEqual(result, { ok: false, reason, disabled: true });
      assert.equal(commits.length, 0);
      assert.equal(checks, 0);
    };
    disabled({ mode: 'off' }, SIMULATION_DISABLED);
    disabled({ adjudicator: false }, UNSUPPORTED_MECHANIC, 'smuggle');
    disabled({ adjudicator: false, mechanics: { trade: DETERMINISTIC } }, UNSUPPORTED_MECHANIC, 'smuggle');

    for (const declared of [mechanics, { trade: DETERMINISTIC } as const]) {
      const { result, commits, checks } = apply({ mechanics: declared }, 'smuggle');
      assert.equal(result.ok, true);
      assert.equal(checks, 0);
      const [commit] = commits as [WorldCommit];
      assert.deepEqual(commit.actor, guild);
      assert.equal(commit.event.type, WORLD_ACTION_ADJUDICATED);
      assert.equal(
        commit.event.id,
        `${canon.campaignId}:${canon.branchId}:guild:smuggle@${TICK}:${WORLD_ACTION_ADJUDICATED}`,
      );
      assert.deepEqual((commit.event.payload as { outcome: unknown }).outcome, {
        mode: GM_ADJUDICATED,
        reason: declared === mechanics ? GM_ADJUDICATED : UNSUPPORTED_MECHANIC,
      });
    }

    const noMechanicsDeclared = applyWith({ ...bare, adjudicator: false }, 'smuggle');
    assert.equal(noMechanicsDeclared.result.ok, true);
    assert.equal(noMechanicsDeclared.commits[0]?.event.type, WORLD_ACTION_APPLIED);
  });

  it('faction constraints ignore inherited object keys', () => {
    const inherited = createWorldActor({ id: 'constructor', kind: 'faction', name: 'Ctor' });
    const decision = evaluatePolicy({ ...bare, factionKinds: { guild: ['trade'] } }, inherited, proposal);
    assert.deepEqual(decision, { status: 'allowed' });
  });
});
