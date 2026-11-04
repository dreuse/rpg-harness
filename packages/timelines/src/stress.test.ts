import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type BranchId,
  CAMPAIGN_CREATED,
  type DomainEvent,
  MAIN_BRANCH,
  StaleRevisionError,
} from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEventStore, type EventStore } from '../../persistence/src/event-store.ts';
import { createSequentialIds } from '../../testkit/src/fixtures.ts';
import {
  ancestry,
  type Branch,
  branchHistory,
  DuplicateBranchError,
  forkFromCheckpoint,
  replayBranch,
} from './branches.ts';
import { type CheckpointId, type CheckpointPointer, createCheckpoint } from './checkpoints.ts';
import { DIFF_CATEGORIES, type DiffCategory, type DiffEntry, type DiffState, type Viewer } from './diff.ts';
import type { Projection, Timeline } from './replay.ts';
import { confirmRewind, type RewindRequest } from './rewind.ts';

const TEMP_PREFIX = 'rpg-timelines-stress-';
const DATABASE_FILE = 'campaign.sqlite';
const ID_PREFIX = 'stress';
const CAMPAIGN_NAME = 'Harbor Lights';
const PLAYER_EVENT = 'StateRecorded';
const WORLD_EVENT = 'WorldActionResolved';
const CHANGE_TYPES = [PLAYER_EVENT, WORLD_EVENT];
const FACTS: DiffCategory = 'facts';
const PUBLIC: Visibility = 'public';
const GM_VIEWER: Viewer = { scope: 'gm' };
const APPEND_ONLY = /append-only/;
const PROJECTION_VERSION = 1;
const CREATED_REVISION = 0;
const REVISION_STEP = 1;
const NO_EVENTS = 0;
const SINGLE_EVENT = 1;
const EARLY_EVENTS = 2;
const LATE_EVENTS = 2;
const CHILD_EVENTS = 2;
const WORLD_TICKS = 4;
const WHAT_IF = 'what-if';
const SIBLING = 'sibling';
const RETRY = 'retry';
const DEEPER = 'deeper';

type Change = { readonly category: DiffCategory; readonly entry: DiffEntry };
type Step = Pick<DomainEvent, 'id' | 'branchId' | 'revision' | 'causationId' | 'type'>;
type State = { readonly ledger: DiffState; readonly steps: readonly Step[] };

const ledger: Projection<DiffState> = {
  version: PROJECTION_VERSION,
  initial: Object.fromEntries(DIFF_CATEGORIES.map((category) => [category, []])) as unknown as DiffState,
  apply: (state, { type, payload }) => {
    if (!CHANGE_TYPES.includes(type)) return state;
    const { category, entry } = payload as Change;
    return { ...state, [category]: [...state[category].filter(({ key }) => key !== entry.key), entry] };
  },
};

const projection: Projection<State> = {
  version: PROJECTION_VERSION,
  initial: { ledger: ledger.initial, steps: [] },
  apply: (state, event) => ({
    ledger: ledger.apply(state.ledger, event),
    steps: [
      ...state.steps,
      {
        id: event.id,
        branchId: event.branchId,
        revision: event.revision,
        causationId: event.causationId,
        type: event.type,
      },
    ],
  }),
};

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const createHarness = (path: string) => {
  const nextId = createSequentialIds(ID_PREFIX);
  const campaignId = nextId();
  const connection = openDatabase(path);
  createCampaignStore(connection.database).createCampaign(
    { id: campaignId, name: CAMPAIGN_NAME },
    { id: nextId(), campaignId, branchId: MAIN_BRANCH, actionId: nextId(), type: CAMPAIGN_CREATED, payload: {} },
  );
  const store = createEventStore(connection.database);
  const initial = store.list(campaignId, MAIN_BRANCH).reduce(projection.apply, projection.initial);
  return {
    path,
    campaignId,
    nextId,
    connection,
    store,
    branches: [] as readonly Branch[],
    checkpoints: [] as readonly CheckpointPointer[],
    live: new Map<BranchId, State>([[MAIN_BRANCH, initial]]),
    saved: new Map<CheckpointId, State>(),
  };
};

type Harness = ReturnType<typeof createHarness>;

const withHarness = (run: (harness: Harness) => void) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const harness = createHarness(join(directory, DATABASE_FILE));
  try {
    run(harness);
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

const liveState = (harness: Harness, branchId: BranchId) => {
  const state = harness.live.get(branchId);
  assert.ok(state);
  return state;
};

const headOf = (harness: Harness, branchId: BranchId) => {
  const head = historyOf(harness, branchId).at(-1);
  assert.ok(head);
  return head;
};

const nextEvent = (harness: Harness, head: DomainEvent, branchId: BranchId, type: string): DomainEvent => {
  const entry: DiffEntry = { key: harness.nextId(), value: { branchId }, visibility: PUBLIC, actorId: null };
  return {
    id: harness.nextId(),
    campaignId: harness.campaignId,
    branchId,
    turnId: null,
    actorId: null,
    causationId: head.id,
    revision: head.revision + REVISION_STEP,
    type,
    payload: { category: FACTS, entry },
  };
};

const append = (harness: Harness, branchId: BranchId, type: string, store: EventStore = harness.store): DomainEvent => {
  const head = headOf(harness, branchId);
  const event = nextEvent(harness, head, branchId, type);
  store.append(event, head.revision);
  harness.live.set(branchId, projection.apply(liveState(harness, branchId), event));
  return event;
};

const appendMany = (harness: Harness, branchId: BranchId, type: string, count: number) =>
  Array.from({ length: count }, () => append(harness, branchId, type));

const saveCheckpoint = (harness: Harness, branchId: BranchId): CheckpointId => {
  const id = harness.nextId();
  const own = harness.store.list(harness.campaignId, branchId);
  harness.checkpoints = createCheckpoint(harness.checkpoints, ledger, timeline(harness, branchId), own, id);
  harness.saved.set(id, liveState(harness, branchId));
  return id;
};

const adoptBranch = (harness: Harness, branches: readonly Branch[], checkpointId: CheckpointId): BranchId => {
  const child = branches.at(-1);
  const saved = harness.saved.get(checkpointId);
  assert.ok(child && saved);
  harness.branches = branches;
  harness.live.set(child.branchId, saved);
  return child.branchId;
};

const tryFork = (harness: Harness, parent: BranchId, checkpointId: CheckpointId, name: string) =>
  forkFromCheckpoint(
    harness.branches,
    harness.checkpoints,
    loadLog(harness),
    timeline(harness, parent),
    checkpointId,
    name,
  );

const fork = (harness: Harness, parent: BranchId, checkpointId: CheckpointId, name: string) =>
  adoptBranch(harness, tryFork(harness, parent, checkpointId, name), checkpointId);

const rewindRequest = (harness: Harness, parent: BranchId, checkpointId: CheckpointId, name: string) =>
  ({
    branches: harness.branches,
    checkpoints: harness.checkpoints,
    log: loadLog(harness),
    parent: timeline(harness, parent),
    checkpointId,
    name,
  }) satisfies RewindRequest;

const tryRewind = (harness: Harness, parent: BranchId, checkpointId: CheckpointId, name: string) =>
  confirmRewind(ledger, rewindRequest(harness, parent, checkpointId, name), GM_VIEWER, true);

const rewind = (harness: Harness, parent: BranchId, checkpointId: CheckpointId, name: string) =>
  adoptBranch(harness, tryRewind(harness, parent, checkpointId, name).branches, checkpointId);

const restart = (harness: Harness) => {
  harness.connection.close();
  harness.connection = openDatabase(harness.path);
  harness.store = createEventStore(harness.connection.database);
  harness.branches = roundTrip(harness.branches);
  harness.checkpoints = roundTrip(harness.checkpoints);
};

const assertCausality = (history: readonly DomainEvent[]) => {
  history.forEach((event, index) => {
    const previous = history[index - 1];
    assert.equal(event.causationId, previous?.id ?? null);
    assert.equal(event.revision, previous === undefined ? CREATED_REVISION : previous.revision + REVISION_STEP);
  });
};

const assertConsistent = (harness: Harness) => {
  const log = loadLog(harness);
  assert.equal(new Set(log.map(({ id }) => id)).size, log.length);
  for (const branchId of branchIds(harness)) {
    const view = timeline(harness, branchId);
    const history = branchHistory(harness.branches, log, view);
    const lineage = new Set(ancestry(harness.branches, view).map((branch) => branch.branchId));
    assert.equal(
      history.every((event) => event.campaignId === harness.campaignId && lineage.has(event.branchId)),
      true,
    );
    assertCausality(history);
    assert.deepEqual(replayBranch(projection, harness.branches, log, view), liveState(harness, branchId));
  }
  for (const branch of harness.branches) {
    const parent = branch.parentBranchId ?? MAIN_BRANCH;
    const anchor = branchHistory(harness.branches, log, timeline(harness, parent))[branch.forkEventCount - 1];
    assert.equal(anchor?.id ?? null, branch.forkEventId);
  }
  assert.equal(
    harness.checkpoints.every(({ version }) => version === PROJECTION_VERSION),
    true,
  );
};

test('run forks, retries, restarts and replay consistency tests', () =>
  withHarness((harness) => {
    appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, EARLY_EVENTS);
    const early = saveCheckpoint(harness, MAIN_BRANCH);
    appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, LATE_EVENTS);
    const late = saveCheckpoint(harness, MAIN_BRANCH);
    appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, SINGLE_EVENT);

    assert.deepEqual(tryFork(harness, MAIN_BRANCH, early, WHAT_IF), tryFork(harness, MAIN_BRANCH, early, WHAT_IF));
    const whatIf = fork(harness, MAIN_BRANCH, early, WHAT_IF);
    const afterFork = harness.branches;
    assert.throws(() => fork(harness, MAIN_BRANCH, early, WHAT_IF), DuplicateBranchError);
    assert.equal(harness.branches, afterFork);
    const sibling = fork(harness, MAIN_BRANCH, late, SIBLING);

    assert.deepEqual(tryRewind(harness, MAIN_BRANCH, early, RETRY), tryRewind(harness, MAIN_BRANCH, early, RETRY));
    const retried = rewind(harness, MAIN_BRANCH, early, RETRY);
    const afterRewind = harness.branches;
    assert.throws(() => rewind(harness, MAIN_BRANCH, early, RETRY), DuplicateBranchError);
    assert.equal(harness.branches, afterRewind);

    appendMany(harness, whatIf, PLAYER_EVENT, CHILD_EVENTS);
    const nestedPoint = saveCheckpoint(harness, whatIf);
    appendMany(harness, whatIf, PLAYER_EVENT, SINGLE_EVENT);
    const deeper = fork(harness, whatIf, nestedPoint, DEEPER);
    const [replayed] = appendMany(harness, deeper, PLAYER_EVENT, CHILD_EVENTS);
    appendMany(harness, sibling, PLAYER_EVENT, SINGLE_EVENT);
    appendMany(harness, retried, PLAYER_EVENT, SINGLE_EVENT);
    appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, SINGLE_EVENT);

    const logBeforeRetry = loadLog(harness);
    assert.ok(replayed);
    assert.throws(() => harness.store.append(replayed, headOf(harness, deeper).revision), APPEND_ONLY);
    assert.deepEqual(loadLog(harness), logBeforeRetry);
    assertConsistent(harness);

    const branchesBeforeRestart = harness.branches;
    restart(harness);
    assert.deepEqual(loadLog(harness), logBeforeRetry);
    assert.deepEqual(harness.branches, branchesBeforeRestart);
    assertConsistent(harness);
    assert.throws(() => fork(harness, MAIN_BRANCH, early, WHAT_IF), DuplicateBranchError);
    assert.throws(() => rewind(harness, MAIN_BRANCH, early, RETRY), DuplicateBranchError);

    for (const branchId of branchIds(harness)) appendMany(harness, branchId, PLAYER_EVENT, SINGLE_EVENT);
    const resumed = fork(harness, MAIN_BRANCH, late, `${SIBLING}-${RETRY}`);
    appendMany(harness, resumed, PLAYER_EVENT, SINGLE_EVENT);
    restart(harness);
    assertConsistent(harness);
  }));

test('no branch corruption even with concurrent scheduled world events', () =>
  withHarness((harness) => {
    const scheduler = openDatabase(harness.path);
    try {
      const world = createEventStore(scheduler.database);
      appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, EARLY_EVENTS);
      const start = saveCheckpoint(harness, MAIN_BRANCH);
      const left = fork(harness, MAIN_BRANCH, start, WHAT_IF);
      const shared = historyOf(harness, left);
      const worldEvents: DomainEvent[] = [];
      const schedule = () => worldEvents.push(append(harness, left, WORLD_EVENT, world));
      const rewound: BranchId[] = [];

      for (let tick = 0; tick < WORLD_TICKS; tick++) {
        schedule();
        const point = saveCheckpoint(harness, MAIN_BRANCH);
        appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, SINGLE_EVENT);
        schedule();
        const branchId = rewind(harness, MAIN_BRANCH, point, `${RETRY}-${tick}`);
        rewound.push(branchId);
        schedule();
        appendMany(harness, branchId, PLAYER_EVENT, SINGLE_EVENT);
        appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, SINGLE_EVENT);
        schedule();
        assertConsistent(harness);
      }

      restart(harness);
      assertConsistent(harness);
      assert.deepEqual(historyOf(harness, left), [...shared, ...worldEvents]);
      const mainHistory = historyOf(harness, MAIN_BRANCH);
      assert.deepEqual(mainHistory.slice(NO_EVENTS, shared.length), shared);
      for (const branchId of [MAIN_BRANCH, ...rewound]) {
        assert.equal(
          historyOf(harness, branchId).some(({ type }) => type === WORLD_EVENT),
          false,
        );
      }
      for (const branchId of rewound) {
        const branch = harness.branches.find((candidate) => candidate.branchId === branchId);
        assert.ok(branch);
        assert.deepEqual(
          historyOf(harness, branchId).slice(NO_EVENTS, branch.forkEventCount),
          mainHistory.slice(NO_EVENTS, branch.forkEventCount),
        );
      }
    } finally {
      scheduler.close();
    }
  }));

test('reject a player write that read the same branch head as a committed world write', () =>
  withHarness((harness) => {
    const scheduler = openDatabase(harness.path);
    try {
      const world = createEventStore(scheduler.database);
      appendMany(harness, MAIN_BRANCH, PLAYER_EVENT, EARLY_EVENTS);
      const head = headOf(harness, MAIN_BRANCH);
      const worldEvent = nextEvent(harness, head, MAIN_BRANCH, WORLD_EVENT);
      const playerEvent = nextEvent(harness, head, MAIN_BRANCH, PLAYER_EVENT);

      world.append(worldEvent, head.revision);
      assert.throws(() => harness.store.append(playerEvent, head.revision), StaleRevisionError);
      assert.deepEqual(headOf(harness, MAIN_BRANCH), worldEvent);
      assert.equal(
        loadLog(harness).some(({ id }) => id === playerEvent.id),
        false,
      );
    } finally {
      scheduler.close();
    }
  }));
