import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldActor } from './actor.ts';
import type { ActionProposal } from './planner.ts';
import { applyProposal, type RulesetCheckPort } from './validation.ts';
import {
  ACTION_BUDGET_EXCEEDED,
  type ActorAction,
  admitProposals,
  DEFAULT_WORLD_CONFIG,
  firingTriggers,
  KNOB_FIELDS,
  MODE_KNOBS,
  resolveWorldConfig,
  SIMULATION_MODES,
  simulationDiagnostics,
  type WorldConfig,
} from './world.ts';

const action = (n: number, actorId = 'a1'): ActorAction => ({
  actionId: `act-${n}`,
  actorId,
  kind: 'move',
  knowledgeRefs: ['k1'],
  tick: 4,
});

describe('W01 world simulation contracts', () => {
  it('define logical-time triggers, actor action schema, simulation modes and attention budgets', () => {
    assert.deepEqual([...SIMULATION_MODES], ['off', 'ambient', 'balanced', 'dynamic', 'custom']);
    const config = resolveWorldConfig({
      mode: 'balanced',
      budget: { maxActors: 2, maxActions: 2 },
      triggers: [
        { kind: 'tick', at: 4 },
        { kind: 'interval', every: 2, from: 0 },
        { kind: 'event', eventType: 'door.opened' },
      ],
    });
    assert.equal(config.ok, true);
    if (!config.ok) return;
    assert.equal(firingTriggers(config.config, { tick: 4, events: [] }).length, 2);
    assert.equal(firingTriggers(config.config, { tick: 3, events: ['door.opened'] }).length, 1);
    const result = admitProposals(config.config, [action(1), action(2, 'a2'), action(3, 'a3')]);
    assert.deepEqual(
      result.accepted.map((a) => a.actionId),
      ['act-1', 'act-2'],
    );
    assert.equal(result.rejected.length, 1);
  });

  it('rejects invalid budgets, triggers, modes and malformed actions', () => {
    for (const bad of [
      { mode: 'always' },
      { budget: { maxActors: 0, maxActions: 1 } },
      { budget: { maxActors: 1.5, maxActions: 1 } },
      { triggers: [{ kind: 'interval', every: 0 }] },
      { triggers: [{ kind: 'tick', at: 1.5 }] },
      { triggers: [{ kind: 'tick', at: Number.NaN }] },
      { triggers: [{ kind: 'tick', at: -1 }] },
      { triggers: [{ kind: 'wall' }] },
      { triggers: [{ kind: 'interval', every: Number.MAX_SAFE_INTEGER + 1 }] },
      { mode: 'custom', worldAutonomy: 2 },
      { mode: 'custom', storyIntensity: Number.NaN },
      { mode: 'custom', consequenceSeverity: '1' },
    ]) {
      assert.equal(resolveWorldConfig(bad).ok, false);
    }
    const on = resolveWorldConfig({ mode: 'balanced' });
    assert.ok(on.ok);
    if (!on.ok) return;
    const result = admitProposals(on.config, [{ ...action(1), knowledgeRefs: [] }, { ...action(1) }, { ...action(1) }]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 2);
  });

  it('off means no autonomous activity; world simulation is never mandatory', () => {
    const resolved = resolveWorldConfig(undefined);
    assert.ok(resolved.ok);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.config, DEFAULT_WORLD_CONFIG);
    assert.equal(resolved.config.mode, 'off');
    const off = { ...resolved.config, triggers: [{ kind: 'tick' as const, at: 4 }] };
    assert.deepEqual(firingTriggers(off, { tick: 4, events: [] }), []);
    const result = admitProposals(off, [action(1)]);
    assert.deepEqual(result.accepted, []);
    assert.equal(result.rejected.length, 1);
  });

  it('rejects proposals with bad knowledgeRefs without throwing', () => {
    const on = resolveWorldConfig({ mode: 'balanced' });
    assert.ok(on.ok);
    if (!on.ok) return;
    const bad = [undefined, [123], ['']].map((knowledgeRefs, i) => ({
      ...action(i),
      knowledgeRefs,
    })) as unknown as ActorAction[];
    const result = admitProposals(on.config, bad);
    assert.equal(result.accepted.length, 0);
    assert.deepEqual(
      result.rejected.map((r) => r.reason),
      ['malformed action', 'malformed action', 'malformed action'],
    );
  });

  it('supports custom mode knobs and fills partial budgets from defaults', () => {
    const custom = resolveWorldConfig({
      mode: 'custom',
      worldAutonomy: 0.5,
      storyIntensity: 0,
      consequenceSeverity: 1,
    });
    assert.ok(custom.ok);
    if (!custom.ok) return;
    assert.equal(custom.config.worldAutonomy, 0.5);
    assert.equal(custom.config.storyIntensity, 0);
    assert.equal(custom.config.consequenceSeverity, 1);
    const partial = resolveWorldConfig({ budget: { maxActors: 3 } });
    assert.ok(partial.ok);
    if (!partial.ok) return;
    assert.deepEqual(partial.config.budget, { maxActors: 3, maxActions: DEFAULT_WORLD_CONFIG.budget.maxActions });
  });
});

const SEED = 42;
const DIE_SIDES = 20;
const LCG_MULTIPLIER = 1_103_515_245;
const LCG_INCREMENT = 12_345;
const LCG_MODULUS = 2 ** 31;
const SLIDER_VALUES = [0, 0.5, 1];
const ROLLS_PER_CHECK = 3;

const seededRolls = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return (state % DIE_SIDES) + 1;
  };
};

const resolved = (input: unknown): WorldConfig => {
  const result = resolveWorldConfig(input);
  assert.ok(result.ok);
  return result.config;
};

const sliderGrid = () =>
  SLIDER_VALUES.flatMap((worldAutonomy) =>
    SLIDER_VALUES.flatMap((storyIntensity) =>
      SLIDER_VALUES.map((consequenceSeverity) => ({ worldAutonomy, storyIntensity, consequenceSeverity })),
    ),
  );

describe('W13 player simulation settings and diagnostics', () => {
  const actor = createWorldActor({
    id: 'a1',
    kind: 'faction',
    name: 'Guild',
    resources: { coin: 5 },
    knowledge: [{ factId: 'k1', channel: 'witnessed', sourceId: null, eventId: 'e1', tick: 0 }],
  });
  const proposal: ActionProposal = { ...action(1), knowledgeRefs: ['k1'], resourceRefs: ['coin'] };
  const canon = { campaignId: 'c1', branchId: 'main', revision: 1, tick: proposal.tick, committed: [] };

  const rollUnder = (config: WorldConfig) => {
    const seen: unknown[] = [];
    const roll = seededRolls(SEED);
    const check: RulesetCheckPort = (...args) => {
      seen.push(args);
      return { ok: true, costs: { coin: 1 }, outcome: { rolls: Array.from({ length: ROLLS_PER_CHECK }, roll) } };
    };
    const result = applyProposal({
      canon,
      actor,
      proposal,
      expectedRevision: canon.revision,
      check,
      commit: () => true,
      policy: { mode: config.mode, adjudicator: false },
    });
    return { result, seen, admitted: admitProposals(config, [action(1), action(2, 'a2')]) };
  };

  it('world autonomy, intensity and consequence-severity sliders do not cheat rolls', () => {
    const baseline = rollUnder(resolved({ mode: 'custom' }));
    assert.ok(baseline.result.ok);
    for (const sliders of sliderGrid()) {
      const config = resolved({ mode: 'custom', ...sliders });
      assert.deepEqual(simulationDiagnostics(config, { accepted: [], rejected: [] }).knobs, sliders);
      assert.deepEqual(rollUnder(config), baseline, JSON.stringify(sliders));
    }
  });

  it('diagnostics explain the current settings and what the world simulation did or skipped', () => {
    for (const mode of SIMULATION_MODES.filter((m) => m !== 'custom')) {
      const config = resolved({ mode });
      assert.deepEqual(simulationDiagnostics(config, { accepted: [], rejected: [] }).knobs, MODE_KNOBS[mode]);
    }
    const custom = simulationDiagnostics(resolved({ mode: 'custom', worldAutonomy: 1 }), {
      accepted: [],
      rejected: [],
    });
    assert.deepEqual(custom.knobs, { ...MODE_KNOBS.balanced, worldAutonomy: 1 });
    assert.deepEqual(Object.keys(custom.knobs), [...KNOB_FIELDS]);

    const off = resolved(undefined);
    assert.deepEqual(simulationDiagnostics(off, admitProposals(off, [action(1)])), {
      mode: 'off',
      knobs: MODE_KNOBS.off,
      budget: off.budget,
      applied: [],
      skipped: [{ actionId: 'act-1', reason: 'world simulation is off' }],
    });

    const tight = resolved({ mode: 'balanced', budget: { maxActors: 2, maxActions: 1 } });
    const malformed = { kind: 'move' } as unknown as ActorAction;
    const report = simulationDiagnostics(tight, admitProposals(tight, [action(1), action(2), malformed]));
    assert.deepEqual(report.applied, ['act-1']);
    assert.deepEqual(report.skipped, [
      { actionId: 'act-2', reason: ACTION_BUDGET_EXCEEDED },
      { actionId: null, reason: 'malformed action' },
    ]);
  });
});
