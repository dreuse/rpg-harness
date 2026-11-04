import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  type BranchId,
  CAMPAIGN_CREATED,
  type CampaignChange,
  type DomainEvent,
  MAIN_BRANCH,
  StaleRevisionError,
} from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEventStore } from '../../persistence/src/event-store.ts';
import { createSequentialIds } from '../../testkit/src/fixtures.ts';
import {
  type ActorFact,
  createWorldActor,
  type InformationPath,
  learn,
  type WorldActor,
} from '../../world/src/actor.ts';
import { type ClaimPort, resolveConflicts } from '../../world/src/conflict.ts';
import { createFactionPlanner, type FactionTargets } from '../../world/src/faction.ts';
import type { ActionProposal } from '../../world/src/planner.ts';
import { advanceWorld, GAME_TIME_SOURCE, INITIAL_CURSOR, type SchedulerCursor } from '../../world/src/scheduler.ts';
import {
  applyProposal,
  type CanonView,
  type ResourceCosts,
  type RulesetCheckPort,
  STALE_REVISION,
  WORLD_ACTION_APPLIED,
  type WorldCommitPort,
} from '../../world/src/validation.ts';
import type { SimulationMode, WorldConfig } from '../../world/src/world.ts';
import { type Branch, branchHistory, forkFromCheckpoint, replayBranch } from './branches.ts';
import { type CheckpointPointer, createCheckpoint } from './checkpoints.ts';
import type { Projection, Timeline } from './replay.ts';

const TEMP_PREFIX = 'rpg-timelines-world-';
const DATABASE_FILE = 'campaign.sqlite';
const ID_PREFIX = 'world';
const OTHER_ID_PREFIX = 'rival-world';
const CAMPAIGN_NAME = 'Harbor Lights';
const WORLD_TIME_ADVANCED = 'WorldTimeAdvanced';
const FORK_CHECKPOINT = 'day-one';
const WHAT_IF = 'what-if';
const PROJECTION_VERSION = 1;
const REVISION_STEP = 1;
const NO_COST = 0;
const CONTESTED_GOAL = 'harbor';
const OPEN_GOAL = 'grain';
const NEWS_FACT = 'public-news';
const FACTION_KIND = 'faction';
const NORTH = 'north';
const SOUTH = 'south';
const EAST = 'east';
const RELAXED = 'relaxed';
const INTENSE = 'intense';
const RELAXED_EVERY = 4;
const INTENSE_EVERY = 1;
const TICKS_PER_DAY = 4;
const DAYS_AFTER_FORK = 2;
const FIRST_DAY = 0;
const FIRST_TICK = 0;
const SEED = 7;
const SEED_MULTIPLIER = 1664525;
const SEED_INCREMENT = 1013904223;
const UNSIGNED_SHIFT = 0;
const MAX_STRENGTH = 8;
const MIN_STRENGTH = 1;
const HARBOR_TARGET = 10;
const GRAIN_TARGET = 6;
const ACTION_COST = 1;
const CLAIM_PRIORITY = 0;
const RUMOR_PATH: InformationPath = { channel: 'rumor', sourceId: null, eventId: null, tick: FIRST_TICK };
const targets: FactionTargets = { [CONTESTED_GOAL]: HARBOR_TARGET, [OPEN_GOAL]: GRAIN_TARGET };
const factionGoals: Readonly<Record<string, readonly string[]>> = {
  [NORTH]: [CONTESTED_GOAL],
  [SOUTH]: [CONTESTED_GOAL],
  [EAST]: [OPEN_GOAL],
};
const pacings: Readonly<Record<string, { mode: SimulationMode; every: number }>> = {
  [RELAXED]: { mode: 'ambient', every: RELAXED_EVERY },
  [INTENSE]: { mode: 'dynamic', every: INTENSE_EVERY },
};

type WorldState = {
  readonly actors: Readonly<Record<string, WorldActor>>;
  readonly committed: readonly string[];
  readonly cursor: SchedulerCursor;
};

const newsFact: ActorFact = { id: NEWS_FACT, visibility: 'public', actorId: null };
const privateFact = (actorId: string): ActorFact => ({ id: `${actorId}-intel`, visibility: 'actor-scoped', actorId });

const seededStrengths = (seed: number, count: number) => {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, SEED_MULTIPLIER) + SEED_INCREMENT) >>> UNSIGNED_SHIFT;
    return MIN_STRENGTH + (state % MAX_STRENGTH);
  });
};

const initialActors = (seed: number) => {
  const ids = Object.keys(factionGoals).sort();
  const strengths = seededStrengths(seed, ids.length);
  return Object.fromEntries(
    ids.map((id, i) => {
      const goals = factionGoals[id] as readonly string[];
      const resources = Object.fromEntries(goals.map((goal) => [goal, strengths[i] as number]));
      const base = createWorldActor({ id, kind: FACTION_KIND, name: id, goals, resources });
      return [id, [privateFact(id), newsFact].reduce((actor, fact) => learn(actor, fact, RUMOR_PATH), base)];
    }),
  );
};

const charge = (actor: WorldActor, costs: ResourceCosts): WorldActor => ({
  ...actor,
  resources: Object.fromEntries(
    Object.entries(actor.resources).map(([ref, amount]) => [ref, amount - (costs[ref] ?? NO_COST)]),
  ),
});

const world: Projection<WorldState> = {
  version: PROJECTION_VERSION,
  initial: { actors: initialActors(SEED), committed: [], cursor: INITIAL_CURSOR },
  apply: (state, { type, payload }) => {
    if (type === WORLD_TIME_ADVANCED) return { ...state, cursor: payload.cursor as SchedulerCursor };
    if (type !== WORLD_ACTION_APPLIED) return state;
    const actorId = payload.actorId as string;
    const actor = charge(state.actors[actorId] as WorldActor, payload.costs as ResourceCosts);
    return {
      ...state,
      actors: { ...state.actors, [actorId]: actor },
      committed: [...state.committed, payload.actionId as string],
    };
  },
};

const claims: ClaimPort = (proposal) => ({ exclusive: [...proposal.resourceRefs], priority: CLAIM_PRIORITY });
const check: RulesetCheckPort = (proposal) => ({
  ok: true,
  costs: Object.fromEntries(proposal.resourceRefs.map((ref) => [ref, ACTION_COST])),
  outcome: {},
});

const createCampaign = (database: DatabaseSync, prefix: string) => {
  const nextId = createSequentialIds(prefix);
  const campaignId = nextId();
  createCampaignStore(database).createCampaign(
    { id: campaignId, name: CAMPAIGN_NAME },
    { id: nextId(), campaignId, branchId: MAIN_BRANCH, actionId: nextId(), type: CAMPAIGN_CREATED, payload: {} },
  );
  return campaignId;
};

const createHarness = (path: string) => {
  const connection = openDatabase(path);
  const campaignId = createCampaign(connection.database, ID_PREFIX);
  return {
    path,
    campaignId,
    connection,
    store: createEventStore(connection.database),
    branches: [] as readonly Branch[],
    checkpoints: [] as readonly CheckpointPointer[],
  };
};

type Harness = ReturnType<typeof createHarness>;

const withHarness = async <T>(run: (harness: Harness) => Promise<T> | T): Promise<T> => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const harness = createHarness(join(directory, DATABASE_FILE));
  try {
    return await run(harness);
  } finally {
    harness.connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const timeline = (harness: Harness, branchId: BranchId): Timeline => ({ campaignId: harness.campaignId, branchId });
const branchIds = (harness: Harness) => [MAIN_BRANCH, ...harness.branches.map(({ branchId }) => branchId)];
const loadLog = (harness: Harness) =>
  branchIds(harness).flatMap((branchId) => harness.store.list(harness.campaignId, branchId));
const historyOf = (harness: Harness, branchId: BranchId) =>
  branchHistory(harness.branches, loadLog(harness), timeline(harness, branchId));
const stateOf = (harness: Harness, branchId: BranchId) =>
  replayBranch(world, harness.branches, loadLog(harness), timeline(harness, branchId));

const headOf = (harness: Harness, branchId: BranchId) => {
  const head = historyOf(harness, branchId).at(-1);
  assert.ok(head);
  return head;
};

const persisted = (change: CampaignChange, head: DomainEvent): DomainEvent => ({
  id: change.id,
  campaignId: change.campaignId,
  branchId: change.branchId,
  turnId: null,
  actorId: null,
  causationId: head.id,
  revision: head.revision + REVISION_STEP,
  type: change.type,
  payload: { ...change.payload, actionId: change.actionId },
});

const commitTo =
  (harness: Harness, head: DomainEvent): WorldCommitPort =>
  ({ event, expectedRevision }) => {
    try {
      harness.store.append(persisted(event, head), expectedRevision);
      return true;
    } catch (error) {
      if (error instanceof StaleRevisionError) return false;
      throw error;
    }
  };

const canonOf = (harness: Harness, branchId: BranchId, tick: number): CanonView => ({
  campaignId: harness.campaignId,
  branchId,
  revision: headOf(harness, branchId).revision,
  tick,
  committed: stateOf(harness, branchId).committed,
});

const planTick = (state: WorldState, tick: number): ActionProposal[] => {
  const planner = createFactionPlanner(Object.values(state.actors), targets);
  const proposals = Object.keys(state.actors).flatMap((actorId) =>
    planner({ actorId, clock: { tick, events: [] }, triggers: [] }),
  );
  return resolveConflicts(proposals, claims).accepted as ActionProposal[];
};

const recordTime = (harness: Harness, branchId: BranchId, cursor: SchedulerCursor) => {
  const head = headOf(harness, branchId);
  const change: CampaignChange = {
    id: `${harness.campaignId}:${branchId}:${WORLD_TIME_ADVANCED}@${cursor.lastProcessedTick}`,
    campaignId: harness.campaignId,
    branchId,
    actionId: `${WORLD_TIME_ADVANCED}@${cursor.lastProcessedTick}`,
    type: WORLD_TIME_ADVANCED,
    payload: { cursor },
  };
  harness.store.append(persisted(change, head), head.revision);
};

const advanceDay = (harness: Harness, branchId: BranchId, pacing: string) => {
  const { mode, every } = pacings[pacing] as { mode: SimulationMode; every: number };
  const factions = Object.keys(factionGoals).length;
  const config: WorldConfig = {
    mode,
    budget: { maxActors: factions, maxActions: factions },
    triggers: [{ kind: 'interval', every, from: FIRST_TICK }],
  };
  const { cursor } = stateOf(harness, branchId);
  const fromTick = cursor.lastProcessedTick;
  const transition = { source: GAME_TIME_SOURCE, approved: true, fromTick, toTick: fromTick + TICKS_PER_DAY } as const;
  const advanced = advanceWorld(config, cursor, transition, [], () => []);
  assert.ok(advanced.ok);
  for (const { tick } of advanced.fired) {
    for (const proposal of planTick(stateOf(harness, branchId), tick)) {
      const canon = canonOf(harness, branchId, tick);
      const actor = stateOf(harness, branchId).actors[proposal.actorId] as WorldActor;
      const commit = commitTo(harness, headOf(harness, branchId));
      const result = applyProposal({ canon, actor, proposal, expectedRevision: canon.revision, check, commit });
      assert.ok(result.ok, proposal.actionId);
    }
  }
  recordTime(harness, branchId, advanced.cursor);
};

const forkAfterDay = (harness: Harness, pacing: string) => {
  advanceDay(harness, MAIN_BRANCH, pacing);
  const main = timeline(harness, MAIN_BRANCH);
  const own = harness.store.list(harness.campaignId, MAIN_BRANCH);
  harness.checkpoints = createCheckpoint(harness.checkpoints, world, main, own, FORK_CHECKPOINT);
  harness.branches = forkFromCheckpoint(
    harness.branches,
    harness.checkpoints,
    loadLog(harness),
    main,
    FORK_CHECKPOINT,
    WHAT_IF,
  );
  return harness.branches.at(-1) as Branch;
};

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const pauseAndResume = (harness: Harness) => {
  const before = loadLog(harness);
  harness.connection.close();
  harness.connection = openDatabase(harness.path);
  harness.store = createEventStore(harness.connection.database);
  harness.branches = roundTrip(harness.branches);
  harness.checkpoints = roundTrip(harness.checkpoints);
  assert.deepEqual(loadLog(harness), before);
};

const worldActions = (events: readonly DomainEvent[]) => events.filter(({ type }) => type === WORLD_ACTION_APPLIED);
const actionIds = (events: readonly DomainEvent[]) => worldActions(events).map(({ payload }) => payload.actionId);

const evolve = (harness: Harness, pause: (harness: Harness) => void) => {
  const { branchId: fork, forkEventCount } = forkAfterDay(harness, INTENSE);
  pause(harness);
  for (let day = FIRST_DAY; day < DAYS_AFTER_FORK; day += 1) {
    advanceDay(harness, MAIN_BRANCH, RELAXED);
    advanceDay(harness, fork, INTENSE);
    pause(harness);
  }
  return {
    forkEventCount,
    log: loadLog(harness),
    main: { history: historyOf(harness, MAIN_BRANCH), state: stateOf(harness, MAIN_BRANCH) },
    whatIf: { history: historyOf(harness, fork), state: stateOf(harness, fork) },
  };
};

describe('W15 branching, long-run consistency and restart', () => {
  it('prove autonomous evolution in separate timelines and persistent paused/resumed sessions', async () => {
    const uninterrupted = await withHarness((harness) => evolve(harness, () => {}));
    const resumed = await withHarness((harness) => evolve(harness, pauseAndResume));

    assert.deepEqual(resumed, uninterrupted);
    const { main, whatIf, forkEventCount } = uninterrupted;
    const shared = main.history.slice(0, forkEventCount);
    assert.deepEqual(whatIf.history.slice(0, forkEventCount), shared);
    assert.ok(worldActions(shared).length > 0);
    const mainActions = actionIds(main.history.slice(forkEventCount));
    const whatIfActions = actionIds(whatIf.history.slice(forkEventCount));
    assert.ok(mainActions.length > 0);
    assert.ok(whatIfActions.length > mainActions.length);
    assert.notDeepEqual(whatIf.state.actors, main.state.actors);
    assert.equal(main.state.cursor.lastProcessedTick, whatIf.state.cursor.lastProcessedTick);
    assert.equal(new Set(uninterrupted.log.map(({ id }) => id)).size, uninterrupted.log.length);
  });

  it('cross-branch faction actions never mutate another branch', async () => {
    await withHarness((harness) => {
      const { branchId: fork, forkEventCount } = forkAfterDay(harness, INTENSE);
      const mainBefore = historyOf(harness, MAIN_BRANCH);
      const mainStateBefore = stateOf(harness, MAIN_BRANCH);

      advanceDay(harness, fork, INTENSE);
      assert.deepEqual(historyOf(harness, MAIN_BRANCH), mainBefore);
      assert.deepEqual(stateOf(harness, MAIN_BRANCH), mainStateBefore);

      const forkState = stateOf(harness, fork);
      const nextTick = forkState.cursor.lastProcessedTick + INTENSE_EVERY;
      const [foreign] = planTick(forkState, nextTick);
      assert.ok(foreign);
      const logBefore = loadLog(harness);
      const forkRevision = headOf(harness, fork).revision;
      const crossed = applyProposal({
        canon: { ...canonOf(harness, MAIN_BRANCH, nextTick), committed: forkState.committed },
        actor: forkState.actors[foreign.actorId] as WorldActor,
        proposal: foreign,
        expectedRevision: forkRevision,
        check,
        commit: commitTo(harness, headOf(harness, fork)),
      });
      assert.deepEqual(crossed, { ok: false, reason: STALE_REVISION });
      assert.deepEqual(loadLog(harness), logBefore);

      const forkHistory = historyOf(harness, fork);
      advanceDay(harness, MAIN_BRANCH, INTENSE);
      assert.deepEqual(historyOf(harness, fork), forkHistory);
      const mainOwn = worldActions(historyOf(harness, MAIN_BRANCH).slice(forkEventCount));
      const forkOwn = worldActions(forkHistory.slice(forkEventCount));
      assert.ok(forkOwn.length > 0);
      assert.deepEqual(actionIds(mainOwn), actionIds(forkOwn));
      assert.ok(mainOwn.every(({ branchId }) => branchId === MAIN_BRANCH));
      assert.ok(forkOwn.every(({ branchId }) => branchId === fork));
      assert.deepEqual(stateOf(harness, MAIN_BRANCH), stateOf(harness, fork));
    });
  });

  it('the same faction action in two campaigns of one database keeps distinct event ids', async () => {
    await withHarness((harness) => {
      const rival = { ...harness, campaignId: createCampaign(harness.connection.database, OTHER_ID_PREFIX) };
      advanceDay(harness, MAIN_BRANCH, INTENSE);
      advanceDay(rival, MAIN_BRANCH, INTENSE);
      const own = actionIds(historyOf(harness, MAIN_BRANCH));
      assert.ok(own.length > 0);
      assert.deepEqual(actionIds(historyOf(rival, MAIN_BRANCH)), own);
      const log = [...loadLog(harness), ...loadLog(rival)];
      assert.equal(new Set(log.map(({ id }) => id)).size, log.length);
    });
  });
});
