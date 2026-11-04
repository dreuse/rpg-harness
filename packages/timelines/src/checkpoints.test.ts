import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DomainEvent, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import {
  CheckpointNotFoundError,
  CheckpointVersionError,
  createCheckpoint,
  DuplicateCheckpointError,
  listCheckpoints,
  restoreCheckpoint,
} from './checkpoints.ts';
import { type Projection, SnapshotMismatchError, type Timeline } from './replay.ts';

const CAMPAIGN = 'campaign-checkpoints';
const SIDE_BRANCH = 'branch-what-if';
const EVENT_TYPE = 'Noted';
const FIRST = 'before-the-storm';
const SECOND = 'after-the-storm';
const MISSING = 'never-saved';
const PROJECTION_VERSION = 1;
const NEXT_VERSION = 2;
const EARLY_COUNT = 2;
const FULL_COUNT = 4;
const timeline: Timeline = { campaignId: CAMPAIGN, branchId: MAIN_BRANCH };
const sideTimeline: Timeline = { campaignId: CAMPAIGN, branchId: SIDE_BRANCH };

const eventAt = (revision: number): DomainEvent => ({
  id: `event-${revision}`,
  campaignId: CAMPAIGN,
  branchId: MAIN_BRANCH,
  turnId: null,
  actorId: null,
  causationId: null,
  revision,
  type: EVENT_TYPE,
  payload: { revision },
});

const log = (count: number) => Object.freeze(Array.from({ length: count }, (_, index) => eventAt(index + 1)));

const notes: Projection<readonly number[]> = {
  version: PROJECTION_VERSION,
  initial: [],
  apply: (state, event) => [...state, event.revision],
};

test('create, list and restore checkpoint pointers without overwriting history', () => {
  const early = log(EARLY_COUNT);
  const full = log(FULL_COUNT);
  const saved = createCheckpoint(createCheckpoint([], notes, timeline, early, FIRST), notes, timeline, full, SECOND);

  assert.deepEqual(
    listCheckpoints(saved, timeline).map(({ id, eventCount, lastEventId }) => ({ id, eventCount, lastEventId })),
    [
      { id: FIRST, eventCount: EARLY_COUNT, lastEventId: `event-${EARLY_COUNT}` },
      { id: SECOND, eventCount: FULL_COUNT, lastEventId: `event-${FULL_COUNT}` },
    ],
  );
  assert.deepEqual(listCheckpoints(saved, sideTimeline), []);
  assert.equal('state' in (saved[0] ?? {}), false);

  const restored = restoreCheckpoint(saved, notes, timeline, full, FIRST);
  assert.deepEqual(restored.state, [1, 2]);
  assert.equal(restored.eventCount, EARLY_COUNT);
  assert.deepEqual(restoreCheckpoint(saved, notes, timeline, full, SECOND).state, [1, 2, 3, 4]);
  assert.deepEqual(full, log(FULL_COUNT));
  assert.throws(() => createCheckpoint(saved, notes, timeline, full, FIRST), DuplicateCheckpointError);
});

test('invalid checkpoint or incompatible version produces no partial restore', () => {
  const full = log(FULL_COUNT);
  const saved = Object.freeze(createCheckpoint([], notes, timeline, full, SECOND));
  const current = restoreCheckpoint(saved, notes, timeline, full, SECOND);
  let target = current;
  const attempt = (events: readonly DomainEvent[], projection: Projection<readonly number[]>, id: string) => () => {
    target = restoreCheckpoint(saved, projection, timeline, events, id);
  };

  assert.throws(attempt(full, notes, MISSING), CheckpointNotFoundError);
  assert.throws(attempt(log(EARLY_COUNT), notes, SECOND), SnapshotMismatchError);
  const rewritten = full.map((event, index) => (index === FULL_COUNT - 1 ? { ...event, id: 'event-forged' } : event));
  assert.throws(attempt(rewritten, notes, SECOND), SnapshotMismatchError);
  assert.throws(attempt(full, { ...notes, version: NEXT_VERSION }, SECOND), CheckpointVersionError);
  assert.throws(() => restoreCheckpoint(saved, notes, sideTimeline, full, SECOND), CheckpointNotFoundError);

  assert.equal(target, current);
  assert.deepEqual(target.state, [1, 2, 3, 4]);
  assert.deepEqual(full, log(FULL_COUNT));
  assert.equal(saved.length, 1);
});
