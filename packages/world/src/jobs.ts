import { type ActorAction, isActorAction, MAX_BUDGET, MIN_BUDGET } from './world.ts';

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'exhausted'] as const;
export const BASE_BACKOFF_TICKS = 1;
export const MAX_BACKOFF_TICKS = 16;
export const MAX_JOB_ACTIONS = 8;
export const AGENT_FAILED = 'agent call failed';
export const AGENT_TIMEOUT = 'agent call timed out';
export const MALFORMED_RESULT = 'malformed agent result';
export const MALFORMED_LEDGER = 'malformed job ledger';
export const MALFORMED_JOB = 'malformed job';
export const INVALID_BUDGET = 'invalid job budget';
export const INVALID_TICK = 'invalid logical tick';
export const STORE_FAILURE = 'job store failed';
export const RUN_IN_PROGRESS = 'job run already in progress';
export const RETRIES_EXHAUSTED = 'job retries exhausted';
export const EMPTY_LEDGER: JobLedger = { spend: 0, jobs: [] };
const MIN_RETRIES = 0;
const MIN_SPEND = 0;
const TIMED_OUT = Symbol('timed out');

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobBudget = {
  readonly maxCalls: number;
  readonly maxConcurrency: number;
  readonly maxRetries: number;
  readonly maxSpend: number;
};
export type AgentJob = { readonly jobId: string; readonly input: unknown };
export type JobRecord = AgentJob & {
  readonly status: JobStatus;
  readonly attempts: number;
  readonly retryAt: number;
  readonly actions: readonly ActorAction[];
  readonly error?: string;
};
export type JobLedger = { readonly spend: number; readonly jobs: readonly JobRecord[] };
export type JobStore = { readonly load: () => unknown; readonly save: (ledger: JobLedger) => void };
export type AgentRequest = {
  readonly jobId: string;
  readonly input: unknown;
  readonly attempt: number;
  readonly tick: number;
};
export type AgentPort = (request: AgentRequest) => Promise<unknown>;
export type AgentResult = { readonly actions: readonly ActorAction[]; readonly spend: number };
export type JobRunner = {
  readonly budget: JobBudget;
  readonly store: JobStore;
  readonly agent: AgentPort;
  readonly deadline: (jobId: string) => Promise<unknown>;
};
export type JobCommit = { readonly jobId: string; readonly actions: readonly ActorAction[] };
export type JobFailure = { readonly jobId: string; readonly reason: string; readonly status: JobStatus };
export type LedgerResult = { ok: true; ledger: JobLedger; changed: string[] } | { ok: false; reason: string };
export type RunReport =
  | { ok: true; tick: number; calls: number; committed: JobCommit[]; failures: JobFailure[]; ledger: JobLedger }
  | { ok: false; reason: string; committed?: JobCommit[]; failures?: JobFailure[] };

const activeStores = new WeakSet<JobStore>();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTick = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isSpend = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_SPEND;
const isBounded = (v: unknown, min: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= MAX_BUDGET;

const isBudget = (v: unknown): v is JobBudget =>
  isRecord(v) &&
  isBounded(v.maxCalls, MIN_BUDGET) &&
  isBounded(v.maxConcurrency, MIN_BUDGET) &&
  isBounded(v.maxRetries, MIN_RETRIES) &&
  isSpend(v.maxSpend);

const isJobRecord = (v: unknown): v is JobRecord =>
  isRecord(v) &&
  isNonEmpty(v.jobId) &&
  JOB_STATUSES.includes(v.status as JobStatus) &&
  isTick(v.attempts) &&
  isTick(v.retryAt) &&
  Array.isArray(v.actions) &&
  v.actions.every(isActorAction) &&
  (v.error === undefined || typeof v.error === 'string');

const isLedger = (v: unknown): v is JobLedger =>
  isRecord(v) &&
  isSpend(v.spend) &&
  Array.isArray(v.jobs) &&
  v.jobs.every(isJobRecord) &&
  new Set(v.jobs.map((j) => j.jobId)).size === v.jobs.length;

const isAgentResult = (v: unknown): v is AgentResult =>
  isRecord(v) &&
  isSpend(v.spend) &&
  Array.isArray(v.actions) &&
  v.actions.length <= MAX_JOB_ACTIONS &&
  v.actions.every(isActorAction);

export const createMemoryJobStore = (initial: JobLedger = EMPTY_LEDGER): JobStore => {
  let current = structuredClone(initial);
  return {
    load: () => structuredClone(current),
    save: (ledger) => {
      current = structuredClone(ledger);
    },
  };
};

const loadLedger = (store: JobStore): LedgerResult => {
  let raw: unknown;
  try {
    raw = store.load() ?? EMPTY_LEDGER;
  } catch {
    return { ok: false, reason: STORE_FAILURE };
  }
  return isLedger(raw) ? { ok: true, ledger: raw, changed: [] } : { ok: false, reason: MALFORMED_LEDGER };
};

const saved = (store: JobStore, ledger: JobLedger, changed: string[]): LedgerResult => {
  if (changed.length === 0) return { ok: true, ledger, changed };
  try {
    store.save(structuredClone(ledger));
  } catch {
    return { ok: false, reason: STORE_FAILURE };
  }
  return { ok: true, ledger, changed };
};

export const enqueueJobs = (store: JobStore, jobs: readonly AgentJob[]): LedgerResult => {
  const loaded = loadLedger(store);
  if (!loaded.ok) return loaded;
  const known = new Set(loaded.ledger.jobs.map((j) => j.jobId));
  const added: JobRecord[] = [];
  for (const job of jobs) {
    if (!isRecord(job) || !isNonEmpty(job.jobId)) return { ok: false, reason: MALFORMED_JOB };
    if (known.has(job.jobId)) continue;
    let input: unknown;
    try {
      input = structuredClone(job.input);
    } catch {
      return { ok: false, reason: MALFORMED_JOB };
    }
    known.add(job.jobId);
    added.push({ jobId: job.jobId, input, status: 'pending', attempts: 0, retryAt: 0, actions: [] });
  }
  const ledger = { ...loaded.ledger, jobs: [...loaded.ledger.jobs, ...added] };
  return saved(
    store,
    ledger,
    added.map((j) => j.jobId),
  );
};

export const resumeJobs = (store: JobStore): LedgerResult => {
  const loaded = loadLedger(store);
  if (!loaded.ok) return loaded;
  const changed = loaded.ledger.jobs.filter((j) => j.status === 'running').map((j) => j.jobId);
  const jobs = loaded.ledger.jobs.map((j): JobRecord => (j.status === 'running' ? { ...j, status: 'pending' } : j));
  return saved(store, { ...loaded.ledger, jobs }, changed);
};

const backoff = (attempts: number) => Math.min(BASE_BACKOFF_TICKS * 2 ** (attempts - 1), MAX_BACKOFF_TICKS);

const isEligible = (job: JobRecord, tick: number) =>
  job.status === 'pending' || (job.status === 'failed' && job.retryAt <= tick);

const callAgent = async ({ agent, deadline }: JobRunner, request: AgentRequest) => {
  try {
    const timeout = Promise.resolve()
      .then(() => deadline(request.jobId))
      .then(() => TIMED_OUT);
    const output: unknown = await Promise.race([Promise.resolve().then(() => agent(request)), timeout]);
    if (output === TIMED_OUT) return { ok: false, reason: AGENT_TIMEOUT, spend: MIN_SPEND } as const;
    const result = structuredClone(output);
    if (isAgentResult(result)) return { ok: true, result } as const;
    const spend = isRecord(result) && isSpend(result.spend) ? result.spend : MIN_SPEND;
    return { ok: false, reason: MALFORMED_RESULT, spend } as const;
  } catch {
    return { ok: false, reason: AGENT_FAILED, spend: MIN_SPEND } as const;
  }
};

const record = (
  job: JobRecord,
  status: JobStatus,
  retryAt: number,
  actions: readonly ActorAction[],
  error?: string,
) => ({
  jobId: job.jobId,
  input: job.input,
  status,
  attempts: job.attempts,
  retryAt,
  actions,
  ...(error === undefined ? {} : { error }),
});

export const runJobs = async (runner: JobRunner, tick: number): Promise<RunReport> => {
  const { budget, store } = runner;
  if (!isBudget(budget)) return { ok: false, reason: INVALID_BUDGET };
  if (!isTick(tick)) return { ok: false, reason: INVALID_TICK };
  if (!isRecord(store)) return { ok: false, reason: STORE_FAILURE };
  if (activeStores.has(store)) return { ok: false, reason: RUN_IN_PROGRESS };
  activeStores.add(store);
  try {
    return await runExclusive(runner, tick);
  } finally {
    activeStores.delete(store);
  }
};

const runExclusive = async (runner: JobRunner, tick: number): Promise<RunReport> => {
  const { budget, store } = runner;
  const resumed = resumeJobs(store);
  if (!resumed.ok) return resumed;
  const jobs = new Map(resumed.ledger.jobs.map((j) => [j.jobId, j]));
  const seen = new Set(resumed.ledger.jobs.flatMap((j) => j.actions.map((a) => a.actionId)));
  const order = resumed.ledger.jobs.filter((j) => isEligible(j, tick)).map((j) => j.jobId);
  const queue = [...order];
  const committed: JobCommit[] = [];
  const failures: JobFailure[] = [];
  let spend = resumed.ledger.spend;
  let calls = 0;
  let halted = false;
  const ledger = (): JobLedger => ({ spend, jobs: [...jobs.values()] });
  const update = (job: JobRecord) => {
    const previous = jobs.get(job.jobId) as JobRecord;
    jobs.set(job.jobId, job);
    try {
      store.save(structuredClone(ledger()));
    } catch (error) {
      jobs.set(job.jobId, previous);
      halted = true;
      throw error;
    }
  };
  const attempt = async (job: JobRecord) => {
    if (job.attempts > budget.maxRetries) {
      update(record(job, 'exhausted', job.retryAt, [], RETRIES_EXHAUSTED));
      failures.push({ jobId: job.jobId, reason: RETRIES_EXHAUSTED, status: 'exhausted' });
      return;
    }
    calls += 1;
    const running = { ...job, status: 'running', attempts: job.attempts + 1 } as const;
    update(running);
    const outcome = await callAgent(runner, { jobId: job.jobId, input: job.input, attempt: running.attempts, tick });
    if (!outcome.ok) {
      spend += outcome.spend;
      const status = running.attempts > budget.maxRetries ? 'exhausted' : 'failed';
      update(record(running, status, tick + backoff(running.attempts), [], outcome.reason));
      failures.push({ jobId: job.jobId, reason: outcome.reason, status });
      return;
    }
    const actions: ActorAction[] = [];
    for (const action of outcome.result.actions) {
      if (seen.has(action.actionId)) continue;
      seen.add(action.actionId);
      actions.push(action);
    }
    spend += outcome.result.spend;
    update(record(running, 'succeeded', running.retryAt, actions));
    committed.push({ jobId: job.jobId, actions });
  };
  const worker = async () => {
    while (!halted && queue.length > 0 && calls < budget.maxCalls && spend < budget.maxSpend)
      await attempt(jobs.get(queue.shift() as string) as JobRecord);
  };
  const settled = await Promise.allSettled(Array.from({ length: budget.maxConcurrency }, worker));
  committed.sort((a, b) => order.indexOf(a.jobId) - order.indexOf(b.jobId));
  failures.sort((a, b) => order.indexOf(a.jobId) - order.indexOf(b.jobId));
  if (settled.some((s) => s.status === 'rejected')) return { ok: false, reason: STORE_FAILURE, committed, failures };
  return { ok: true, tick, calls, committed, failures, ledger: ledger() };
};
