import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ActorPlanner,
  advanceWorld,
  GAME_TIME_SOURCE,
  INITIAL_CURSOR,
  MAX_DEFERRED_ACTIONS,
  MAX_TICKS_PER_ADVANCE,
  type SchedulerCursor,
  type TimeTransition,
} from './scheduler.ts';
import { type ActorAction, DEFAULT_WORLD_CONFIG, MALFORMED_ACTION, MAX_BUDGET, type WorldConfig } from './world.ts';

const config: WorldConfig = {
  mode: 'balanced',
  budget: { maxActors: 2, maxActions: 2 },
  triggers: [
    { kind: 'interval', every: 2, from: 0 },
    { kind: 'event', eventType: 'storm.broke' },
  ],
};

const transition = (fromTick: number, toTick: number, extra: Partial<TimeTransition> = {}): TimeTransition => ({
  source: GAME_TIME_SOURCE,
  approved: true,
  fromTick,
  toTick,
  ...extra,
});

const planner: ActorPlanner = ({ actorId, clock }) => [
  { actionId: `${actorId}@${clock.tick}`, actorId, kind: 'scheme', knowledgeRefs: ['rumor'], tick: clock.tick },
];

const pending: ActorAction = { actionId: 'p@0', actorId: 'p', kind: 'scheme', knowledgeRefs: ['rumor'], tick: 0 };

const ids = (actions: readonly ActorAction[]) => actions.map((a) => a.actionId);

const advanced = (result: ReturnType<typeof advanceWorld>) => {
  if (!result.ok) assert.fail(result.reason);
  return result;
};

describe('W03 bounded logical-time scheduler', () => {
  it('advance scheduled actors and world events on approved in-game time transitions', () => {
    const storm = { tick: 3, type: 'storm.broke' };
    const result = advanced(
      advanceWorld(config, INITIAL_CURSOR, transition(0, 4, { events: [storm] }), ['b', 'a'], planner),
    );
    assert.deepEqual(
      result.fired.map((f) => f.tick),
      [2, 3, 4],
    );
    assert.deepEqual(ids(result.accepted), ['a@2', 'b@2', 'a@3', 'b@3', 'a@4', 'b@4']);
    assert.equal(result.cursor.lastProcessedTick, 4);
    assert.equal(result.deferredTicks, 0);
  });

  it('app shutdown does not advance time; jobs resume idempotently', () => {
    const first = advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, 4), ['a'], planner));
    const restored: SchedulerCursor = JSON.parse(JSON.stringify(first.cursor));
    assert.deepEqual(restored, first.cursor);
    assert.equal(restored.lastProcessedTick, 4);
    const rerun = advanced(advanceWorld(config, restored, transition(0, 4), ['a'], planner));
    assert.deepEqual(rerun.accepted, []);
    assert.deepEqual(rerun.cursor, restored);
    const next = advanced(advanceWorld(config, restored, transition(4, 6), ['a'], planner));
    assert.deepEqual(ids(next.accepted), ['a@6']);
    const wallClock = { ...transition(4, 6), source: 'wall-clock' } as unknown as TimeTransition;
    assert.equal(advanceWorld(config, restored, wallClock, ['a'], planner).ok, false);
  });

  it('does nothing in off mode while keeping the cursor in step with game time', () => {
    let calls = 0;
    const counting: ActorPlanner = (request) => {
      calls += 1;
      return planner(request);
    };
    const result = advanced(advanceWorld(DEFAULT_WORLD_CONFIG, INITIAL_CURSOR, transition(0, 10), ['a'], counting));
    assert.equal(calls, 0);
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(result.fired, []);
    assert.equal(result.cursor.lastProcessedTick, 10);
    const held = advanced(
      advanceWorld(DEFAULT_WORLD_CONFIG, { ...INITIAL_CURSOR, deferred: [pending] }, transition(0, 2), ['a'], counting),
    );
    assert.deepEqual(held.cursor.deferred, [pending]);
  });

  it('carries deferred actions from a restored cursor into the next advance', () => {
    const cursor: SchedulerCursor = JSON.parse(JSON.stringify({ ...INITIAL_CURSOR, deferred: [pending] }));
    const result = advanced(advanceWorld(config, cursor, transition(0, 1), ['a'], planner));
    assert.deepEqual(ids(result.accepted), ['p@0']);
    assert.deepEqual(result.cursor.deferred, []);
  });

  it('caps ticks per advance and defers over-budget actions deterministically', () => {
    const far = MAX_TICKS_PER_ADVANCE * 2;
    const step = advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, far), [], planner));
    assert.equal(step.cursor.lastProcessedTick, MAX_TICKS_PER_ADVANCE);
    assert.equal(step.deferredTicks, far - MAX_TICKS_PER_ADVANCE);
    const rest = advanced(advanceWorld(config, step.cursor, transition(0, far), [], planner));
    assert.equal(rest.cursor.lastProcessedTick, far);
    assert.equal(rest.deferredTicks, 0);

    const crowd = advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, 3), ['c', 'b', 'a'], planner));
    assert.deepEqual(ids(crowd.accepted), ['a@2', 'b@2', 'c@2']);
    assert.deepEqual(ids(crowd.cursor.deferred), []);
    assert.deepEqual(crowd.rejected, []);
    const busy = advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, 2), ['c', 'b', 'a'], planner));
    assert.deepEqual(ids(busy.accepted), ['a@2', 'b@2']);
    assert.deepEqual(ids(busy.cursor.deferred), ['c@2']);

    const single: WorldConfig = { ...config, budget: { maxActors: MAX_BUDGET, maxActions: 1 } };
    const horde = Array.from({ length: MAX_DEFERRED_ACTIONS + 2 }, (_, i) => `n${String(i).padStart(3, '0')}`);
    const flood = advanced(advanceWorld(single, INITIAL_CURSOR, transition(0, 2), horde, planner));
    assert.equal(flood.accepted.length, 1);
    assert.equal(flood.cursor.deferred.length, MAX_DEFERRED_ACTIONS);
    assert.deepEqual(
      flood.rejected.map((r) => r.reason),
      ['deferred action queue full'],
    );
  });

  it('rejects non-monotonic, unapproved, gapped and malformed transitions', () => {
    const at4: SchedulerCursor = { ...INITIAL_CURSOR, lastProcessedTick: 4 };
    const reject = (input: unknown, cursor: SchedulerCursor = at4) =>
      advanceWorld(config, cursor, input as TimeTransition, ['a'], planner).ok;
    assert.equal(reject(transition(4, 3)), false);
    assert.equal(reject(transition(4, 4)), false);
    assert.equal(reject(transition(4, 6, { approved: false })), false);
    assert.equal(reject(transition(5, 6)), false);
    assert.equal(reject({ ...transition(4, 6), toTick: Date.now() + 0.5 }), false);
    assert.equal(reject(transition(4, 6, { events: [{ tick: 9, type: 'storm.broke' }] })), false);
    assert.equal(reject(transition(4, 6), { lastProcessedTick: -1 } as unknown as SchedulerCursor), false);
  });

  it('rejects a restored cursor with malformed deferred actions without throwing', () => {
    for (const bad of [null, 5, { ...pending, knowledgeRefs: 'rumor' }]) {
      const cursor = { ...INITIAL_CURSOR, deferred: [bad] } as unknown as SchedulerCursor;
      assert.equal(advanceWorld(config, cursor, transition(0, 2), ['a'], planner).ok, false);
    }
  });

  it('rejects non-array planner output and non-record items as malformed actions', () => {
    const broken = [() => 'nope', () => [null, 5]] as unknown as ActorPlanner[];
    const reasons = broken.map((p) =>
      advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, 2), ['a'], p)).rejected.map((r) => r.reason),
    );
    assert.deepEqual(reasons, [[MALFORMED_ACTION], [MALFORMED_ACTION, MALFORMED_ACTION]]);
  });

  it('rejects planner proposals for a tick other than the current one', () => {
    const stale: ActorPlanner = (request) => planner({ ...request, clock: { ...request.clock, tick: 0 } });
    const result = advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, 2), ['a'], stale));
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(
      result.rejected.map((r) => r.reason),
      ['planner proposed for another tick'],
    );
  });

  it('rejects planner proposals made for another actor', () => {
    const impostor: ActorPlanner = ({ clock }) => [
      { actionId: `x@${clock.tick}`, actorId: 'x', kind: 'scheme', knowledgeRefs: ['rumor'], tick: clock.tick },
    ];
    const result = advanced(advanceWorld(config, INITIAL_CURSOR, transition(0, 2), ['a'], impostor));
    assert.deepEqual(result.accepted, []);
    assert.deepEqual(
      result.rejected.map((r) => r.reason),
      ['planner proposed for another actor'],
    );
  });
});
