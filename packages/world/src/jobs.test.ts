import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_FAILED,
  AGENT_TIMEOUT,
  type AgentPort,
  type AgentRequest,
  createMemoryJobStore,
  enqueueJobs,
  INVALID_BUDGET,
  type JobBudget,
  type JobLedger,
  type JobStore,
  MALFORMED_JOB,
  MALFORMED_LEDGER,
  MALFORMED_RESULT,
  MAX_BACKOFF_TICKS,
  RETRIES_EXHAUSTED,
  RUN_IN_PROGRESS,
  resumeJobs,
  runJobs,
  STORE_FAILURE,
} from './jobs.ts';
import type { ActorAction } from './world.ts';

const budget: JobBudget = { maxCalls: 8, maxConcurrency: 2, maxRetries: 2, maxSpend: 100 };
const never = () => new Promise<never>(() => {});
const SPEND = 4;

const action = (jobId: string, tick = 0): ActorAction => ({
  actionId: `${jobId}@${tick}`,
  actorId: jobId,
  kind: 'scheme',
  knowledgeRefs: ['rumor'],
  tick,
});

const succeed: AgentPort = async ({ jobId, tick }) => ({ actions: [action(jobId, tick)], spend: SPEND });

const seeded = (ids: readonly string[]) => {
  const store = createMemoryJobStore();
  const result = enqueueJobs(
    store,
    ids.map((jobId) => ({ jobId, input: { goal: jobId } })),
  );
  assert.equal(result.ok, true);
  return store;
};

const ledgerOf = (store: JobStore) => store.load() as JobLedger;
const statuses = (store: JobStore) => Object.fromEntries(ledgerOf(store).jobs.map((j) => [j.jobId, j.status]));

const ran = async (...args: Parameters<typeof runJobs>) => {
  const report = await runJobs(...args);
  assert.ok(report.ok, JSON.stringify(report));
  return report;
};

describe('W11 budgeted agent jobs and recovery', () => {
  it('limit agent calls, concurrency, retries and spend; resume durable job state', async () => {
    const store = seeded(['a', 'b', 'c', 'd', 'e']);
    let inFlight = 0;
    let peak = 0;
    const slow: AgentPort = async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return succeed(request);
    };
    const first = await ran({ budget: { ...budget, maxCalls: 3 }, store, agent: slow, deadline: never }, 0);
    assert.equal(first.calls, 3);
    assert.equal(peak, budget.maxConcurrency);
    assert.deepEqual(
      first.committed.map((c) => c.jobId),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(statuses(store), { a: 'succeeded', b: 'succeeded', c: 'succeeded', d: 'pending', e: 'pending' });
    assert.equal(ledgerOf(store).spend, 3 * SPEND);

    const capped = { ...budget, maxSpend: 4 * SPEND, maxConcurrency: 1 };
    const second = await ran({ budget: capped, store, agent: succeed, deadline: never }, 1);
    assert.equal(second.calls, 1);
    assert.deepEqual(statuses(store), { a: 'succeeded', b: 'succeeded', c: 'succeeded', d: 'succeeded', e: 'pending' });
    const third = await ran({ budget: capped, store, agent: succeed, deadline: never }, 2);
    assert.equal(third.calls, 0);

    const retries = seeded(['x']);
    const attempts: number[] = [];
    const failing: AgentPort = async ({ attempt }) => {
      attempts.push(attempt);
      throw new Error('provider down');
    };
    const runner = { budget, store: retries, agent: failing, deadline: never };
    const ticks = [0, 0, 1, 2, 3, 3 + MAX_BACKOFF_TICKS];
    const reports = [];
    for (const tick of ticks) reports.push(await ran(runner, tick));
    assert.deepEqual(
      reports.map((r) => r.calls),
      [1, 0, 1, 0, 1, 0],
    );
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(reports[4]?.failures, [{ jobId: 'x', reason: AGENT_FAILED, status: 'exhausted' }]);
    assert.equal(statuses(retries).x, 'exhausted');

    const crashed = createMemoryJobStore({
      spend: SPEND,
      jobs: [
        { jobId: 'done', input: null, status: 'succeeded', attempts: 1, retryAt: 0, actions: [action('done')] },
        { jobId: 'mid', input: null, status: 'running', attempts: 1, retryAt: 0, actions: [] },
      ],
    });
    const resumed = resumeJobs(crashed);
    assert.ok(resumed.ok);
    assert.deepEqual(resumed.changed, ['mid']);
    assert.deepEqual(statuses(crashed), { done: 'succeeded', mid: 'pending' });
    const called: string[] = [];
    const tracking: AgentPort = async (request) => {
      called.push(request.jobId);
      return succeed(request);
    };
    const after = await ran({ budget, store: crashed, agent: tracking, deadline: never }, 5);
    assert.deepEqual(called, ['mid']);
    assert.deepEqual(after.committed, [{ jobId: 'mid', actions: [action('mid', 5)] }]);
    assert.equal(ledgerOf(crashed).spend, 2 * SPEND);
  });

  it('a failed agent cannot stall player turns or duplicate events', async () => {
    const store = seeded(['good', 'hang', 'reject', 'sync', 'junk', 'copy']);
    const agent: AgentPort = (request: AgentRequest) => {
      if (request.jobId === 'hang') return never();
      if (request.jobId === 'reject') return Promise.reject(new Error('boom'));
      if (request.jobId === 'sync') throw new Error('sync boom');
      if (request.jobId === 'junk') return Promise.resolve({ actions: 'nope', spend: -1 });
      if (request.jobId === 'copy') return Promise.resolve({ actions: [action('good')], spend: 0 });
      return succeed(request);
    };
    const deadline = (jobId: string) => (jobId === 'hang' ? Promise.resolve() : never());
    const report = await ran({ budget: { ...budget, maxConcurrency: 1 }, store, agent, deadline }, 0);
    assert.deepEqual(report.committed, [
      { jobId: 'good', actions: [action('good')] },
      { jobId: 'copy', actions: [] },
    ]);
    assert.deepEqual(report.failures, [
      { jobId: 'hang', reason: AGENT_TIMEOUT, status: 'failed' },
      { jobId: 'reject', reason: AGENT_FAILED, status: 'failed' },
      { jobId: 'sync', reason: AGENT_FAILED, status: 'failed' },
      { jobId: 'junk', reason: MALFORMED_RESULT, status: 'failed' },
    ]);

    const again = enqueueJobs(store, [{ jobId: 'good', input: {} }]);
    assert.ok(again.ok);
    assert.deepEqual(again.changed, []);
    const rerun = await ran({ budget, store, agent: succeed, deadline: never }, 0);
    assert.equal(rerun.calls, 0);

    let saves = 0;
    const inner = seeded(['once']);
    const flaky: JobStore = {
      load: inner.load,
      save: (ledger) => {
        saves += 1;
        if (saves === 2) throw new Error('disk full');
        inner.save(ledger);
      },
    };
    const crash = await runJobs({ budget, store: flaky, agent: succeed, deadline: never }, 0);
    assert.deepEqual(crash, { ok: false, reason: STORE_FAILURE, committed: [], failures: [] });
    assert.equal(statuses(inner).once, 'running');
    const recovered = await ran({ budget, store: inner, agent: succeed, deadline: never }, 1);
    assert.deepEqual(recovered.committed, [{ jobId: 'once', actions: [action('once', 1)] }]);
    const events = ledgerOf(inner).jobs.flatMap((j) => j.actions.map((a) => a.actionId));
    assert.deepEqual(events, ['once@1']);

    const bad = createMemoryJobStore({ spend: 0, jobs: [{ jobId: '' }] } as unknown as JobLedger);
    assert.deepEqual(await runJobs({ budget, store: bad, agent: succeed, deadline: never }, 0), {
      ok: false,
      reason: MALFORMED_LEDGER,
    });
    const unbounded = { ...budget, maxConcurrency: 0 };
    assert.deepEqual(await runJobs({ budget: unbounded, store, agent: succeed, deadline: never }, 0), {
      ok: false,
      reason: INVALID_BUDGET,
    });
    assert.deepEqual(enqueueJobs(store, [{ jobId: '', input: null }]), { ok: false, reason: MALFORMED_JOB });
  });

  it('refuses an overlapping run on the same store so calls, events and spend are not duplicated', async () => {
    const store = seeded(['solo']);
    let calls = 0;
    const agent: AgentPort = async (request) => {
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return succeed(request);
    };
    const runner = { budget, store, agent, deadline: never };
    const [first, second] = await Promise.all([runJobs(runner, 0), runJobs(runner, 0)]);
    assert.equal(calls, 1);
    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, reason: RUN_IN_PROGRESS });
    const events = ledgerOf(store).jobs.flatMap((j) => j.actions.map((a) => a.actionId));
    assert.deepEqual(events, ['solo@0']);
    assert.equal(ledgerOf(store).spend, SPEND);
    const later = await ran(runner, 1);
    assert.equal(later.calls, 0);
  });

  it('exhausts a resumed job whose crashed attempts already used every retry instead of calling it again', async () => {
    const store = createMemoryJobStore({
      spend: 0,
      jobs: [{ jobId: 'crasher', input: null, status: 'running', attempts: 9, retryAt: 0, actions: [] }],
    });
    const called: string[] = [];
    const agent: AgentPort = async (request) => {
      called.push(request.jobId);
      return succeed(request);
    };
    const report = await ran({ budget: { ...budget, maxRetries: 1 }, store, agent, deadline: never }, 0);
    assert.deepEqual(called, []);
    assert.equal(report.calls, 0);
    assert.deepEqual(report.failures, [{ jobId: 'crasher', reason: RETRIES_EXHAUSTED, status: 'exhausted' }]);
    assert.equal(statuses(store).crasher, 'exhausted');
  });

  it('reports actions already committed when the store fails later in the run', async () => {
    const inner = seeded(['first', 'second']);
    let saves = 0;
    const store: JobStore = {
      load: inner.load,
      save: (ledger) => {
        saves += 1;
        if (saves === 3) throw new Error('disk full');
        inner.save(ledger);
      },
    };
    const report = await runJobs(
      { budget: { ...budget, maxConcurrency: 1 }, store, agent: succeed, deadline: never },
      0,
    );
    assert.deepEqual(report, {
      ok: false,
      reason: STORE_FAILURE,
      committed: [{ jobId: 'first', actions: [action('first')] }],
      failures: [],
    });
    assert.equal(statuses(inner).first, 'succeeded');
  });

  it('counts reported spend even when the agent result is malformed', async () => {
    const store = seeded(['junk']);
    const agent: AgentPort = async () => ({ actions: 'nope', spend: SPEND });
    const report = await ran({ budget, store, agent, deadline: never }, 0);
    assert.deepEqual(report.failures, [{ jobId: 'junk', reason: MALFORMED_RESULT, status: 'failed' }]);
    assert.equal(ledgerOf(store).spend, SPEND);
  });

  it('does not persist an undelivered success when its save fails and a later save succeeds', async () => {
    const inner = seeded(['fast', 'slow']);
    let failed = false;
    const store: JobStore = {
      load: inner.load,
      save: (ledger) => {
        const fast = ledger.jobs.find((j) => j.jobId === 'fast');
        if (!failed && fast?.status === 'succeeded') {
          failed = true;
          throw new Error('disk full');
        }
        inner.save(ledger);
      },
    };
    const agent: AgentPort = async (request) => {
      if (request.jobId === 'slow') await new Promise((resolve) => setImmediate(resolve));
      return succeed(request);
    };
    const report = await runJobs({ budget, store, agent, deadline: never }, 0);
    assert.deepEqual(report, {
      ok: false,
      reason: STORE_FAILURE,
      committed: [{ jobId: 'slow', actions: [action('slow')] }],
      failures: [],
    });
    assert.deepEqual(statuses(inner), { fast: 'running', slow: 'succeeded' });
    const next = await ran({ budget, store: inner, agent: succeed, deadline: never }, 1);
    assert.deepEqual(next.committed, [{ jobId: 'fast', actions: [action('fast', 1)] }]);
    const events = ledgerOf(inner).jobs.flatMap((j) => j.actions.map((a) => a.actionId));
    assert.deepEqual(events, ['fast@1', 'slow@0']);
  });

  it('returns a store failure instead of throwing when the store is not an object', async () => {
    const store = null as unknown as JobStore;
    assert.deepEqual(await runJobs({ budget, store, agent: succeed, deadline: never }, 0), {
      ok: false,
      reason: STORE_FAILURE,
    });
  });
});
