import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type DomainEvent, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import { BranchNotFoundError, branchHistory, DuplicateBranchError } from './branches.ts';
import { CheckpointNotFoundError, createCheckpoint } from './checkpoints.ts';
import { DIFF_CATEGORIES, type DiffCategory, type DiffEntry, type DiffState, type Viewer } from './diff.ts';
import type { Projection, Timeline } from './replay.ts';
import {
  confirmRewind,
  previewRewind,
  RewindNotConfirmedError,
  type RewindRequest,
  selectActiveBranch,
} from './rewind.ts';

const CAMPAIGN = 'campaign-rewind';
const OTHER_CAMPAIGN = 'campaign-other';
const RECORDED = 'StateRecorded';
const PROJECTION_VERSION = 1;
const CHECKPOINT = 'before-duel';
const UNKNOWN = 'missing';
const RETRY = 'retry';
const PUBLIC: Visibility = 'public';
const GM: Visibility = 'gm';
const GM_VIEWER: Viewer = { scope: 'gm' };
const PLAYER_VIEWER: Viewer = { scope: 'player' };
const CHECKPOINT_AT = 2;
const main: Timeline = { campaignId: CAMPAIGN, branchId: MAIN_BRANCH };

const entry = (key: string, value: unknown, visibility: Visibility = PUBLIC): DiffEntry => ({
  key,
  value,
  visibility,
  actorId: null,
});

type Change = { readonly category: DiffCategory; readonly entry: DiffEntry };

const projection: Projection<DiffState> = {
  version: PROJECTION_VERSION,
  initial: Object.fromEntries(DIFF_CATEGORIES.map((category) => [category, []])) as unknown as DiffState,
  apply: (state, { payload }) => {
    const change = payload as Change;
    const kept = state[change.category].filter((item) => item.key !== change.entry.key);
    return { ...state, [change.category]: [...kept, change.entry] };
  },
};

const OATH = entry('fact-oath', { statement: 'The duke swore an oath' });
const RESCUE = entry('quest-rescue', { status: 'active' });
const WOUND = entry('fact-wound', { statement: 'Mira lost the duel' });
const FAILED = entry('quest-rescue', { status: 'failed' });
const TRAITOR = entry('fact-traitor', { statement: 'The abbess is a spy' }, GM);

const log: readonly DomainEvent[] = [
  { category: 'facts', entry: OATH },
  { category: 'quests', entry: RESCUE },
  { category: 'facts', entry: WOUND },
  { category: 'quests', entry: FAILED },
  { category: 'facts', entry: TRAITOR },
].map((change, index) => ({
  id: `main-event-${index + 1}`,
  campaignId: CAMPAIGN,
  branchId: MAIN_BRANCH,
  turnId: null,
  actorId: null,
  causationId: null,
  revision: index + 1,
  type: RECORDED,
  payload: change,
}));

const request = (): RewindRequest => ({
  branches: [],
  checkpoints: createCheckpoint([], projection, main, log.slice(0, CHECKPOINT_AT), CHECKPOINT),
  log,
  parent: main,
  checkpointId: CHECKPOINT,
  name: RETRY,
});

const RETRY_BRANCH = `${MAIN_BRANCH}@${CHECKPOINT_AT}:${RETRY}`;

test('player can fork at checkpoint, inspect ramifications and select active branch', () => {
  const input = request();
  const preview = previewRewind(projection, input, GM_VIEWER);

  assert.equal(preview.branchId, RETRY_BRANCH);
  assert.deepEqual(preview.forkPoint, { eventCount: CHECKPOINT_AT, lastEventId: 'main-event-2' });
  assert.equal(preview.discardedEventCount, log.length - CHECKPOINT_AT);
  assert.deepEqual(preview.ramifications.facts, { added: [], removed: [TRAITOR, WOUND], changed: [] });
  assert.deepEqual(preview.ramifications.quests, {
    added: [],
    removed: [],
    changed: [{ key: RESCUE.key, before: FAILED, after: RESCUE }],
  });
  assert.deepEqual(input, request());

  const rewind = confirmRewind(projection, input, GM_VIEWER, true);
  const selected = selectActiveBranch(rewind.branches, CAMPAIGN, MAIN_BRANCH);
  assert.deepEqual(selected.timeline, main);
  assert.match(selected.confirmation, new RegExp(MAIN_BRANCH));
  const back = selectActiveBranch(rewind.branches, CAMPAIGN, RETRY_BRANCH);
  assert.deepEqual(back.timeline, { campaignId: CAMPAIGN, branchId: RETRY_BRANCH });
  assert.throws(() => selectActiveBranch(rewind.branches, CAMPAIGN, UNKNOWN), BranchNotFoundError);
  assert.throws(() => selectActiveBranch(rewind.branches, OTHER_CAMPAIGN, RETRY_BRANCH), BranchNotFoundError);
});

test('rewind preserves previous timeline and presents clear confirmation of branch choice', () => {
  const input = request();
  const historyBefore = branchHistory(input.branches, log, main);
  const rewind = confirmRewind(projection, input, GM_VIEWER, true);

  assert.deepEqual(rewind.previous, main);
  assert.deepEqual(rewind.activeBranch, { campaignId: CAMPAIGN, branchId: RETRY_BRANCH });
  assert.equal(rewind.branches.length, 1);
  assert.deepEqual(branchHistory(rewind.branches, log, main), historyBefore);
  assert.deepEqual(branchHistory(rewind.branches, log, rewind.activeBranch), log.slice(0, CHECKPOINT_AT));
  assert.equal(log.length, 5);
  assert.match(rewind.confirmation, new RegExp(MAIN_BRANCH));
  assert.match(rewind.confirmation, new RegExp(RETRY_BRANCH));
  assert.match(rewind.confirmation, new RegExp(`${log.length - CHECKPOINT_AT} events`));
  assert.deepEqual(input, request());
  assert.throws(
    () => confirmRewind(projection, { ...input, branches: rewind.branches }, GM_VIEWER, true),
    DuplicateBranchError,
  );
});

test('unconfirmed rewind throws and leaves branches unchanged', () => {
  const input = request();
  assert.throws(() => confirmRewind(projection, input, GM_VIEWER, false), RewindNotConfirmedError);
  assert.deepEqual(input, request());
});

test('unknown checkpoint or parent branch is rejected', () => {
  assert.throws(
    () => previewRewind(projection, { ...request(), checkpointId: UNKNOWN }, GM_VIEWER),
    CheckpointNotFoundError,
  );
  assert.throws(
    () => previewRewind(projection, { ...request(), parent: { campaignId: CAMPAIGN, branchId: UNKNOWN } }, GM_VIEWER),
    CheckpointNotFoundError,
  );
});

test('ramifications hide facts the viewer cannot read', () => {
  const preview = previewRewind(projection, request(), PLAYER_VIEWER);
  assert.deepEqual(preview.ramifications.facts, { added: [], removed: [WOUND], changed: [] });
  assert.doesNotMatch(JSON.stringify(preview), /traitor|spy/);
});
