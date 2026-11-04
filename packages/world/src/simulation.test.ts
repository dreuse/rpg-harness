import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CampaignChange } from '../../domain/src/campaign.ts';
import { type ActorFact, createWorldActor, type InformationPath, learn, type WorldActor } from './actor.ts';
import { type ClaimPort, CONTESTED_CLAIM, resolveConflicts } from './conflict.ts';
import { createFactionPlanner, type FactionTargets } from './faction.ts';
import { AGENT_FAILED, type AgentPort, createMemoryJobStore, enqueueJobs, type JobBudget, runJobs } from './jobs.ts';
import { type ActionProposal, UNKNOWN_FACT } from './planner.ts';
import {
  advanceWorld,
  GAME_TIME_SOURCE,
  INITIAL_CURSOR,
  type SchedulerCursor,
  type TimeTransition,
} from './scheduler.ts';
import { applyProposal, type CanonView, type RulesetCheckPort, STALE_TICK } from './validation.ts';
import type { SimulationMode, WorldConfig } from './world.ts';

const CAMPAIGN_ID = 'sim-campaign';
const BRANCH_ID = 'main';
const CONTESTED_GOAL = 'harbor';
const OPEN_GOAL = 'grain';
const NEWS_FACT = 'public-news';
const TICKS_PER_DAY = 4;
const DAYS = 3;
const SEED = 7;
const ACTION_COST = 1;
const ACTION_SPEND = 1;
const MAX_STRENGTH = 8;
const MIN_STRENGTH = 1;
const SEED_MULTIPLIER = 1664525;
const SEED_INCREMENT = 1013904223;
const UNSIGNED_SHIFT = 0;
const FIRST_TICK = 0;
const HARBOR_TARGET = 10;
const GRAIN_TARGET = 6;
const JOB_CALLS = 4;
const JOB_CONCURRENCY = 1;
const JOB_RETRIES = 2;
const AMPLE_SPEND = 100;
const SCARCE_SPEND = 2;
const RELAXED_EVERY = 4;
const INTENSE_EVERY = 1;
const CLAIM_PRIORITY = 0;
const RETRY_ATTEMPT = 2;
const NORTH = 'north';
const SOUTH = 'south';
const EAST = 'east';
const RELAXED = 'relaxed';
const INTENSE = 'intense';
const FACTION_KIND = 'faction';
const LEAKED_KIND = 'negotiate';
const LEAK_TAG = 'leak';
const FAILING_TICK = TICKS_PER_DAY;
const FAILING_JOB_ID = `${NORTH}@${FAILING_TICK}`;
const RUMOR_PATH: InformationPath = { channel: 'rumor', sourceId: null, eventId: null, tick: FIRST_TICK };
const targets: FactionTargets = { [CONTESTED_GOAL]: HARBOR_TARGET, [OPEN_GOAL]: GRAIN_TARGET };
const factionGoals: Readonly<Record<string, readonly string[]>> = {
  [NORTH]: [CONTESTED_GOAL],
  [SOUTH]: [CONTESTED_GOAL],
  [EAST]: [OPEN_GOAL],
};
const generous: JobBudget = {
  maxCalls: JOB_CALLS,
  maxConcurrency: JOB_CONCURRENCY,
  maxRetries: JOB_RETRIES,
  maxSpend: AMPLE_SPEND,
};
const factionBudgets: Readonly<Record<string, JobBudget>> = {
  [NORTH]: generous,
  [SOUTH]: generous,
  [EAST]: { ...generous, maxSpend: SCARCE_SPEND },
};
const pacings: Readonly<Record<string, { mode: SimulationMode; every: number }>> = {
  [RELAXED]: { mode: 'ambient', every: RELAXED_EVERY },
  [INTENSE]: { mode: 'dynamic', every: INTENSE_EVERY },
};
const never = () => new Promise<never>(() => {});

type Scenario = { readonly seed: number; readonly pacing: string; readonly failingJobId?: string };
type JobInput = { readonly actorId: string; readonly tick: number };
type AgentCall = { readonly jobId: string; readonly attempt: number; readonly actionIds: readonly string[] };
type Commit = { readonly tick: number; readonly event: CampaignChange };
type CommitRejection = { readonly actionId: string; readonly reason: string };
type SimulationRun = {
  readonly events: readonly CampaignChange[];
  readonly commits: readonly Commit[];
  readonly rejections: readonly CommitRejection[];
  readonly contested: number;
  readonly failures: readonly string[];
  readonly agentInputs: readonly unknown[];
  readonly calls: readonly AgentCall[];
  readonly actors: ReadonlyMap<string, WorldActor>;
};

const privateFact = (actorId: string): ActorFact => ({
  id: `${actorId}-intel`,
  visibility: 'actor-scoped',
  actorId,
});
const newsFact: ActorFact = { id: NEWS_FACT, visibility: 'public', actorId: null };

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
  return new Map(
    ids.map((id, i) => {
      const goals = factionGoals[id] as readonly string[];
      const resources = Object.fromEntries(goals.map((goal) => [goal, strengths[i] as number]));
      const base = createWorldActor({ id, kind: FACTION_KIND, name: id, goals, resources });
      const known = [privateFact(id), newsFact].reduce((actor, fact) => learn(actor, fact, RUMOR_PATH), base);
      return [id, known] as const;
    }),
  );
};

const claims: ClaimPort = (proposal) => ({ exclusive: [...proposal.resourceRefs], priority: CLAIM_PRIORITY });
const check: RulesetCheckPort = (proposal) => ({
  ok: true,
  costs: Object.fromEntries(proposal.resourceRefs.map((ref) => [ref, ACTION_COST])),
  outcome: {},
});

const simulate = async ({ seed, pacing, failingJobId }: Scenario): Promise<SimulationRun> => {
  const { mode, every } = pacings[pacing] as { mode: SimulationMode; every: number };
  const config: WorldConfig = {
    mode,
    budget: { maxActors: Object.keys(factionGoals).length, maxActions: Object.keys(factionGoals).length },
    triggers: [{ kind: 'interval', every, from: 0 }],
  };
  const actors = initialActors(seed);
  const ids = [...actors.keys()];
  const stores = new Map(ids.map((id) => [id, createMemoryJobStore()]));
  const commits: Commit[] = [];
  const rejections: CommitRejection[] = [];
  const calls: AgentCall[] = [];
  const committed: string[] = [];
  const failures: string[] = [];
  const agentInputs: unknown[] = [];
  const failed = new Set<string>();
  let contested = 0;
  let revision = 0;
  let cursor: SchedulerCursor = INITIAL_CURSOR;
  const leakedProposal = (actorId: string, tick: number): ActionProposal => ({
    actionId: `${actorId}:${LEAK_TAG}@${tick}`,
    actorId,
    kind: LEAKED_KIND,
    knowledgeRefs: [privateFact(SOUTH).id],
    resourceRefs: [],
    tick,
  });
  const agent: AgentPort = async ({ jobId, input, attempt, tick }) => {
    agentInputs.push(structuredClone(input));
    if (jobId === failingJobId && !failed.has(jobId)) {
      failed.add(jobId);
      calls.push({ jobId, attempt, actionIds: [] });
      throw new Error(AGENT_FAILED);
    }
    const scheduled = input as JobInput;
    const planner = createFactionPlanner([...actors.values()], targets);
    const planned = planner({ actorId: scheduled.actorId, clock: { tick: scheduled.tick, events: [] }, triggers: [] });
    const retried = jobId === failingJobId ? [leakedProposal(scheduled.actorId, tick)] : [];
    const actions = [...planned, ...retried];
    calls.push({ jobId, attempt, actionIds: actions.map((a) => a.actionId) });
    return { actions, spend: ACTION_SPEND };
  };
  for (let day = 0; day < DAYS; day += 1) {
    const fromTick = day * TICKS_PER_DAY;
    const transition: TimeTransition = {
      source: GAME_TIME_SOURCE,
      approved: true,
      fromTick,
      toTick: fromTick + TICKS_PER_DAY,
    };
    const advanced = advanceWorld(config, cursor, transition, [], () => []);
    assert.ok(advanced.ok);
    cursor = advanced.cursor;
    for (const { tick } of advanced.fired) {
      const proposals: ActionProposal[] = [];
      for (const id of ids) {
        const store = stores.get(id) as ReturnType<typeof createMemoryJobStore>;
        assert.ok(enqueueJobs(store, [{ jobId: `${id}@${tick}`, input: { actorId: id, tick } }]).ok);
        const report = await runJobs({ budget: factionBudgets[id] as JobBudget, store, agent, deadline: never }, tick);
        assert.ok(report.ok);
        failures.push(...report.failures.map((f) => f.jobId));
        proposals.push(...(report.committed.flatMap((c) => c.actions) as ActionProposal[]));
      }
      const resolution = resolveConflicts(proposals, claims);
      contested += resolution.rejected.filter((r) => r.reason === CONTESTED_CLAIM).length;
      for (const proposal of resolution.accepted) {
        const canon: CanonView = { campaignId: CAMPAIGN_ID, branchId: BRANCH_ID, revision, tick, committed };
        const actor = actors.get(proposal.actorId) as WorldActor;
        const commit = (c: { expectedRevision: number }) => c.expectedRevision === revision;
        const result = applyProposal({ canon, actor, proposal, expectedRevision: revision, check, commit });
        if (!result.ok) {
          rejections.push({ actionId: proposal.actionId, reason: result.reason });
          continue;
        }
        actors.set(actor.id, result.actor);
        commits.push({ tick, event: result.event });
        committed.push(proposal.actionId);
        revision += 1;
      }
    }
  }
  const events = commits.map((c) => c.event);
  return { events, commits, rejections, contested, failures, agentInputs, calls, actors };
};

const tickOf = (event: CampaignChange) => event.payload.tick as number;
const actorOf = (event: CampaignChange) => event.payload.actorId as string;
const refsOf = (event: CampaignChange) => event.payload.knowledgeRefs as readonly string[];

describe('W14 deterministic multi-agent simulation', () => {
  it('simulates budgeted factions in conflict across game days deterministically under each pacing', async () => {
    const relaxed = await simulate({ seed: SEED, pacing: RELAXED });
    const intense = await simulate({ seed: SEED, pacing: INTENSE });
    const replay = await simulate({ seed: SEED, pacing: INTENSE });

    assert.deepEqual(replay.events, intense.events);
    assert.deepEqual([...replay.actors.values()], [...intense.actors.values()]);
    assert.ok(intense.events.length > relaxed.events.length);
    assert.ok(relaxed.events.length > 0);
    assert.ok(intense.contested > 0);
    assert.equal(new Set(intense.events.map(actorOf)).size, Object.keys(factionGoals).length);
    for (const [id, budget] of Object.entries(factionBudgets)) {
      const acted = intense.events.filter((e) => actorOf(e) === id).length;
      assert.ok(acted * ACTION_SPEND <= budget.maxSpend, id);
    }
    const ticks = intense.events.map(tickOf);
    for (const tick of new Set(ticks)) {
      const sameTick = intense.events.filter((e) => tickOf(e) === tick);
      const claimed = sameTick.flatMap((e) => Object.keys(e.payload.costs as object));
      assert.equal(new Set(claimed).size, claimed.length);
    }
  });

  it('never emits out-of-order, leaked or duplicated events after a failed agent call is retried', async () => {
    const run = await simulate({ seed: SEED, pacing: INTENSE, failingJobId: FAILING_JOB_ID });
    const replay = await simulate({ seed: SEED, pacing: INTENSE, failingJobId: FAILING_JOB_ID });

    assert.deepEqual(run.failures, [FAILING_JOB_ID]);
    assert.deepEqual(replay.events, run.events);
    const retry = run.calls.find((c) => c.jobId === FAILING_JOB_ID && c.attempt === RETRY_ATTEMPT);
    assert.ok(retry);
    const [staleId, leakedId] = retry.actionIds;
    const rejectionOf = (actionId: string | undefined) => run.rejections.find((r) => r.actionId === actionId)?.reason;
    assert.equal(rejectionOf(staleId), STALE_TICK);
    assert.equal(rejectionOf(leakedId), UNKNOWN_FACT);
    assert.ok(run.commits.every(({ tick, event }) => tickOf(event) === tick));
    const ticks = run.events.map(tickOf);
    assert.deepEqual(
      ticks,
      [...ticks].sort((a, b) => a - b),
    );
    assert.equal(new Set(run.events.map((e) => e.id)).size, run.events.length);
    assert.equal(new Set(run.events.map((e) => e.actionId)).size, run.events.length);
    assert.ok(!run.events.some((e) => e.actionId === staleId || e.actionId === leakedId));
    assert.ok(run.events.some((e) => actorOf(e) === NORTH && tickOf(e) > FAILING_TICK));
    for (const event of run.events) {
      const actor = run.actors.get(actorOf(event)) as WorldActor;
      const others = [...run.actors.keys()].filter((id) => id !== actor.id).map((id) => privateFact(id).id);
      assert.ok(refsOf(event).every((ref) => actor.knowledge.some((k) => k.factId === ref)));
      assert.ok(!refsOf(event).some((ref) => others.includes(ref)));
    }
    for (const input of run.agentInputs) assert.deepEqual(Object.keys(input as object), ['actorId', 'tick']);
  });
});
