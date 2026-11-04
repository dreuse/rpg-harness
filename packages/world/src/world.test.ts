import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ActorAction,
  admitProposals,
  DEFAULT_WORLD_CONFIG,
  firingTriggers,
  resolveWorldConfig,
  SIMULATION_MODES,
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
