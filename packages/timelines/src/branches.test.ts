import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BranchId, type DomainEvent, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import {
  ancestry,
  BranchNotFoundError,
  branchHistory,
  DuplicateBranchError,
  ForkPointError,
  forkBranch,
  forkFromCheckpoint,
  InvalidBranchNameError,
  replayBranch,
} from './branches.ts';
import { CheckpointNotFoundError, createCheckpoint } from './checkpoints.ts';
import type { Projection, Timeline } from './replay.ts';

const CAMPAIGN = 'campaign-branches';
const OTHER_CAMPAIGN = 'campaign-other';
const PLAYER_EVENT = 'Noted';
const WORLD_EVENT = 'WorldActionResolved';
const FACTION = 'faction-harbor-guild';
const STORM = 'before-the-storm';
const MISSING = 'never-saved';
const UNKNOWN_BRANCH = 'branch-unknown';
const WHAT_IF = 'what-if';
const SIBLING = 'sibling';
const DEEPER = 'deeper';
const ORIGIN = 'origin';
const INVALID_NAMES = ['', 'what:if', 'what@if'];
const PROJECTION_VERSION = 1;
const FORK_COUNT = 2;
const MAIN_COUNT = 4;
const main: Timeline = { campaignId: CAMPAIGN, branchId: MAIN_BRANCH };

const event = (branchId: BranchId, revision: number, type = PLAYER_EVENT): DomainEvent => ({
  id: `${branchId}-event-${revision}`,
  campaignId: CAMPAIGN,
  branchId,
  turnId: null,
  actorId: type === WORLD_EVENT ? FACTION : null,
  causationId: null,
  revision,
  type,
  payload: { revision },
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const mainLog = () => Array.from({ length: MAIN_COUNT }, (_, index) => event(MAIN_BRANCH, index + 1));

const ids: Projection<readonly string[]> = {
  version: PROJECTION_VERSION,
  initial: [],
  apply: (state, { id }) => [...state, id],
};

test('fork campaigns non-destructively with stable branch identifiers and shared ancestry', () => {
  const log = deepFreeze(mainLog());
  const checkpoints = deepFreeze(createCheckpoint([], ids, main, log.slice(0, FORK_COUNT), STORM));
  const original = structuredClone(log);

  const branches = deepFreeze(forkFromCheckpoint([], checkpoints, log, main, STORM, WHAT_IF));
  const [child] = branches;
  assert.ok(child);
  assert.deepEqual(child, {
    campaignId: CAMPAIGN,
    branchId: `${MAIN_BRANCH}@${FORK_COUNT}:${WHAT_IF}`,
    parentBranchId: MAIN_BRANCH,
    forkEventCount: FORK_COUNT,
    forkEventId: log[FORK_COUNT - 1]?.id,
  });
  assert.deepEqual(forkFromCheckpoint([], checkpoints, log, main, STORM, WHAT_IF), branches);
  assert.deepEqual(
    forkBranch([], log, main, checkpoints[0] ?? { eventCount: 0, lastEventId: null }, WHAT_IF),
    branches,
  );

  const own = [event(child.branchId, FORK_COUNT + 1), event(child.branchId, FORK_COUNT + 2)];
  const all = deepFreeze([...log, ...own]);
  assert.deepEqual(branchHistory(branches, all, child), [...log.slice(0, FORK_COUNT), ...own]);
  assert.deepEqual(branchHistory(branches, all, main), log);
  assert.deepEqual(
    replayBranch(ids, branches, all, child),
    [...log.slice(0, FORK_COUNT), ...own].map(({ id }) => id),
  );
  assert.deepEqual(log, original);

  const nested = forkBranch(
    branches,
    all,
    child,
    { eventCount: FORK_COUNT + 1, lastEventId: own[0]?.id ?? null },
    DEEPER,
  );
  const grandchild = nested.at(-1);
  assert.ok(grandchild);
  assert.equal(grandchild.parentBranchId, child.branchId);
  assert.deepEqual(
    ancestry(nested, grandchild).map(({ branchId }) => branchId),
    [MAIN_BRANCH, child.branchId, grandchild.branchId],
  );
  assert.deepEqual(branchHistory(nested, all, grandchild), [...log.slice(0, FORK_COUNT), own[0]]);
  assert.equal(nested.length, branches.length + 1);

  assert.throws(() => forkFromCheckpoint(branches, checkpoints, log, main, STORM, WHAT_IF), DuplicateBranchError);
  assert.throws(() => forkFromCheckpoint([], checkpoints, log, main, MISSING, WHAT_IF), CheckpointNotFoundError);
  const unknown = { campaignId: CAMPAIGN, branchId: UNKNOWN_BRANCH };
  assert.throws(() => forkBranch([], log, unknown, { eventCount: 0, lastEventId: null }, WHAT_IF), BranchNotFoundError);
  assert.throws(() => ancestry([], unknown), BranchNotFoundError);
  const beyond = { eventCount: MAIN_COUNT + 1, lastEventId: null };
  assert.throws(() => forkBranch([], log, main, beyond, WHAT_IF), ForkPointError);
  const forged = { eventCount: FORK_COUNT, lastEventId: log[0]?.id ?? null };
  assert.throws(() => forkBranch([], log, main, forged, WHAT_IF), ForkPointError);
  const otherCampaign = { campaignId: OTHER_CAMPAIGN, branchId: child.branchId };
  assert.throws(() => ancestry(branches, otherCampaign), BranchNotFoundError);
});

test('background world actions cannot leak across branches', () => {
  const log = deepFreeze(mainLog());
  const at = (count: number) => ({ eventCount: count, lastEventId: log[count - 1]?.id ?? null });
  const branches = deepFreeze(
    forkBranch(forkBranch([], log, main, at(FORK_COUNT), WHAT_IF), log, main, at(FORK_COUNT), SIBLING),
  );
  const [left, right] = branches;
  assert.ok(left && right);
  assert.notEqual(left.branchId, right.branchId);

  const leftWorld = [
    event(left.branchId, FORK_COUNT + 1, WORLD_EVENT),
    event(left.branchId, FORK_COUNT + 2, WORLD_EVENT),
  ];
  const rightPlayer = [event(right.branchId, FORK_COUNT + 1)];
  const mainWorld = [event(MAIN_BRANCH, MAIN_COUNT + 1, WORLD_EVENT)];
  const foreign = [{ ...event(left.branchId, FORK_COUNT + 3, WORLD_EVENT), campaignId: OTHER_CAMPAIGN }];
  const all = deepFreeze([...log, ...leftWorld, ...rightPlayer, ...mainWorld, ...foreign]);
  const shared = log.slice(0, FORK_COUNT);
  const idsOf = (events: readonly DomainEvent[]) => events.map(({ id }) => id);

  assert.deepEqual(replayBranch(ids, branches, all, left), idsOf([...shared, ...leftWorld]));
  assert.deepEqual(replayBranch(ids, branches, all, right), idsOf([...shared, ...rightPlayer]));
  assert.deepEqual(replayBranch(ids, branches, all, main), idsOf([...log, ...mainWorld]));
  for (const timeline of [left, right, main]) {
    const history = branchHistory(branches, all, timeline);
    assert.equal(
      history.every(({ campaignId }) => campaignId === CAMPAIGN),
      true,
    );
  }
  assert.equal(
    branchHistory(branches, all, right).some(({ type }) => type === WORLD_EVENT),
    false,
  );
});

test('fork from a checkpoint on a child branch and from the start of history', () => {
  const log = deepFreeze(mainLog());
  const at = (count: number) => ({ eventCount: count, lastEventId: log[count - 1]?.id ?? null });
  const branches = deepFreeze(forkBranch([], log, main, at(FORK_COUNT), WHAT_IF));
  const [child] = branches;
  assert.ok(child);
  const childTimeline: Timeline = { campaignId: child.campaignId, branchId: child.branchId };
  const own = [event(child.branchId, FORK_COUNT + 1), event(child.branchId, FORK_COUNT + 2)];
  const saved = createCheckpoint(
    createCheckpoint([], ids, childTimeline, own.slice(0, 1), STORM),
    ids,
    childTimeline,
    [],
    ORIGIN,
  );
  const checkpoints = deepFreeze(saved);
  assert.equal(
    checkpoints.some((pointer) => 'parentBranchId' in pointer),
    false,
  );

  const nested = forkFromCheckpoint(branches, checkpoints, [...log, ...own], childTimeline, STORM, DEEPER);
  const grandchild = nested.at(-1);
  assert.ok(grandchild);
  assert.equal(grandchild.forkEventCount, FORK_COUNT + 1);
  assert.equal(grandchild.forkEventId, own[0]?.id);
  const deeper = [event(grandchild.branchId, FORK_COUNT + 2, WORLD_EVENT)];
  const all = deepFreeze([...log, ...own, ...deeper]);
  assert.deepEqual(branchHistory(nested, all, grandchild), [...log.slice(0, FORK_COUNT), own[0], ...deeper]);
  assert.deepEqual(branchHistory(nested, all, child), [...log.slice(0, FORK_COUNT), ...own]);
  assert.deepEqual(branchHistory(nested, all, main), log);

  const atChildStart = forkFromCheckpoint(branches, checkpoints, all, childTimeline, ORIGIN, ORIGIN).at(-1);
  assert.equal(atChildStart?.forkEventCount, FORK_COUNT);
  assert.equal(atChildStart?.forkEventId, log[FORK_COUNT - 1]?.id);

  const fresh = forkBranch([], log, main, at(0), ORIGIN);
  const [empty] = fresh;
  assert.ok(empty);
  assert.equal(empty.branchId, `${MAIN_BRANCH}@0:${ORIGIN}`);
  const first = [event(empty.branchId, 1, WORLD_EVENT)];
  assert.deepEqual(branchHistory(fresh, [...log, ...first], empty), first);
  assert.deepEqual(
    replayBranch(ids, fresh, [...log, ...first], main),
    log.map(({ id }) => id),
  );
});

test('branch names that are empty or hold id separators are rejected', () => {
  const log = deepFreeze(mainLog());
  for (const name of INVALID_NAMES) {
    assert.throws(() => forkBranch([], log, main, { eventCount: 0, lastEventId: null }, name), InvalidBranchNameError);
  }
});
