import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENT_BUCKETS } from '../../domain/src/campaign.ts';
import { DEFAULT_PACING, type PacingParams, type PacingState, startScene } from '../../domain/src/pacing.ts';
import { classifyEvent, type EventRelevance, type PlayerContext, surfaceWorldEvents } from './relevance.ts';
import { type ActorPlanner, advanceWorld, GAME_TIME_SOURCE, INITIAL_CURSOR } from './scheduler.ts';
import type { ActorAction, WorldConfig } from './world.ts';

const player: PlayerContext = {
  playerId: 'hero',
  locationId: 'harbor',
  knownEntityIds: ['guild'],
  storylineIds: ['smuggling'],
};

const event = (overrides: Partial<EventRelevance> = {}): EventRelevance => ({
  eventId: 'e1',
  involvedEntityIds: [],
  locationId: null,
  storylineId: null,
  directEffect: false,
  ...overrides,
});

describe('classifyEvent', () => {
  it('classify canonical events as background, emerging, major or critical based on player context', () => {
    assert.equal(classifyEvent(event({ involvedEntityIds: ['stranger'] }), player), 'background');
    assert.equal(classifyEvent(event({ involvedEntityIds: ['guild'] }), player), 'emerging');
    assert.equal(classifyEvent(event({ storylineId: 'smuggling' }), player), 'major');
    assert.equal(classifyEvent(event({ locationId: 'harbor' }), player), 'major');
    assert.equal(classifyEvent(event({ involvedEntityIds: ['hero'] }), player), 'major');
    assert.equal(classifyEvent(event({ directEffect: true }), player), 'critical');
  });

  it('caps non-direct events at the pacing target', () => {
    assert.equal(classifyEvent(event({ storylineId: 'smuggling' }), player, 'emerging'), 'emerging');
    assert.equal(classifyEvent(event({ involvedEntityIds: ['guild'] }), player, 'major'), 'emerging');
  });

  it('critical direct effects cannot be suppressed just to hit a pacing target', () => {
    for (const target of EVENT_BUCKETS)
      assert.equal(
        classifyEvent(event({ directEffect: true, involvedEntityIds: ['hero'] }), player, target),
        'critical',
      );
  });

  it('fails closed to critical on malformed input', () => {
    const malformed: unknown[] = [
      null,
      {},
      { ...event(), involvedEntityIds: 'hero' },
      { ...event(), directEffect: 'no' },
    ];
    for (const raw of malformed) assert.equal(classifyEvent(raw as EventRelevance, player, 'background'), 'critical');
    assert.equal(classifyEvent(event(), { ...player, knownEntityIds: null } as never, 'background'), 'critical');
    assert.equal(classifyEvent(event({ directEffect: true }), player, 'bogus' as never), 'critical');
    assert.equal(classifyEvent(event({ storylineId: 'smuggling' }), player, 'bogus' as never), 'major');
  });
});

const WORLD_TICKS = 6;
const ACTORS = ['guild', 'stranger', 'watch'];
const OVER_BUDGET_COST = DEFAULT_PACING.attentionPerScene.balanced + 1;

const dynamicWorld: WorldConfig = {
  mode: 'dynamic',
  budget: { maxActors: ACTORS.length, maxActions: ACTORS.length },
  triggers: [{ kind: 'interval', every: 1, from: 0 }],
};

const planner: ActorPlanner = ({ actorId, clock }) => [
  { actionId: `${actorId}@${clock.tick}`, actorId, kind: 'scheme', knowledgeRefs: ['rumor'], tick: clock.tick },
];

const simulate = () => {
  const result = advanceWorld(
    dynamicWorld,
    INITIAL_CURSOR,
    { source: GAME_TIME_SOURCE, approved: true, fromTick: 0, toTick: WORLD_TICKS },
    ACTORS,
    planner,
  );
  if (!result.ok) assert.fail(result.reason);
  return result;
};

const worldEvent = (action: ActorAction): EventRelevance =>
  event({
    eventId: action.actionId,
    involvedEntityIds: [action.actorId],
    directEffect: action.actorId === 'watch' && action.tick === WORLD_TICKS,
  });

const pacing = (intent: PacingState['intent'], params: PacingParams = DEFAULT_PACING): PacingState =>
  startScene({ intent, tension: 'calm', attention: 0, interruptions: 0, storylines: [] }, params);

const surfacedIds = (selection: ReturnType<typeof surfaceWorldEvents>) => selection.surfaced.map((e) => e.id);

describe('W08 pacing, recovery and fairness controls', () => {
  it('enforce configurable narrative budgets and player attention load without manipulating mechanics', () => {
    const world = simulate();
    const events = world.accepted.map(worldEvent);
    const snapshot = structuredClone({ world, events });
    const tight: PacingParams = {
      ...DEFAULT_PACING,
      bucketCost: { ...DEFAULT_PACING.bucketCost, background: OVER_BUDGET_COST, emerging: OVER_BUDGET_COST },
    };
    const loose = surfaceWorldEvents(pacing('balanced'), events, player);
    const limited = surfaceWorldEvents(pacing('balanced', tight), events, player, tight);
    assert.deepEqual(surfacedIds(loose), [`watch@${WORLD_TICKS}`, 'guild@1']);
    assert.deepEqual(surfacedIds(limited), [`watch@${WORLD_TICKS}`]);
    for (const selection of [loose, limited]) {
      assert.ok(selection.state.attention >= 0);
      assert.ok(selection.state.interruptions >= 0);
      assert.equal(selection.surfaced.length + selection.pending.length, events.length);
    }
    assert.deepEqual({ world, events }, snapshot);
    assert.deepEqual(simulate(), world);
  });

  it('dynamic world with relaxed story pace remains a valid combination', () => {
    const world = simulate();
    const events = world.accepted.map(worldEvent);
    assert.equal(world.cursor.lastProcessedTick, WORLD_TICKS);
    assert.equal(world.accepted.length, WORLD_TICKS * ACTORS.length);
    const relaxed = surfaceWorldEvents(pacing('relaxed'), events, player);
    assert.deepEqual(surfacedIds(relaxed), [`watch@${WORLD_TICKS}`]);
    assert.equal(relaxed.pending.length, events.length - 1);
    assert.ok(relaxed.pending.every((e) => e.bucket !== 'critical'));
  });

  it('surfaces malformed world events as critical without dropping any event', () => {
    const input = [null as never, event()];
    const selection = surfaceWorldEvents(pacing('relaxed'), input, player);
    assert.deepEqual(
      selection.surfaced.map((e) => e.bucket),
      ['critical'],
    );
    assert.equal(selection.surfaced.length + selection.pending.length, input.length);
  });
});
