import type { BranchId, CampaignId, DomainEvent } from '../../domain/src/campaign.ts';
import { ancestry, type Branch, branchHistory, type ForkPoint, forkFromCheckpoint } from './branches.ts';
import type { CheckpointId, CheckpointPointer } from './checkpoints.ts';
import { type BranchDiff, type DiffState, diffBranches, type Viewer } from './diff.ts';
import type { Projection, Timeline } from './replay.ts';

export type RewindRequest = {
  readonly branches: readonly Branch[];
  readonly checkpoints: readonly CheckpointPointer[];
  readonly log: readonly DomainEvent[];
  readonly parent: Timeline;
  readonly checkpointId: CheckpointId;
  readonly name: string;
};

export type RewindPreview = {
  readonly branchId: BranchId;
  readonly forkPoint: ForkPoint;
  readonly ramifications: BranchDiff;
  readonly discardedEventCount: number;
};

export type Rewind = RewindPreview & {
  readonly branches: readonly Branch[];
  readonly activeBranch: Timeline;
  readonly previous: Timeline;
  readonly confirmation: string;
};

export type BranchSelection = { readonly timeline: Timeline; readonly confirmation: string };

export class RewindNotConfirmedError extends Error {
  readonly checkpointId: CheckpointId;
  constructor(checkpointId: CheckpointId) {
    super(`rewind to checkpoint ${checkpointId} needs explicit confirmation`);
    this.checkpointId = checkpointId;
  }
}

const fork = (projection: Projection<DiffState>, request: RewindRequest, viewer: Viewer) => {
  const { branches, checkpoints, log, parent, checkpointId, name } = request;
  const forked = forkFromCheckpoint(branches, checkpoints, log, parent, checkpointId, name);
  const branch = forked.at(-1) as Branch;
  const activeBranch = { campaignId: branch.campaignId, branchId: branch.branchId };
  const preview: RewindPreview = {
    branchId: branch.branchId,
    forkPoint: { eventCount: branch.forkEventCount, lastEventId: branch.forkEventId },
    ramifications: diffBranches(projection, forked, log, parent, activeBranch, viewer),
    discardedEventCount: branchHistory(branches, log, parent).length - branch.forkEventCount,
  };
  return { forked, activeBranch, preview };
};

export const previewRewind = (
  projection: Projection<DiffState>,
  request: RewindRequest,
  viewer: Viewer,
): RewindPreview => fork(projection, request, viewer).preview;

export const confirmRewind = (
  projection: Projection<DiffState>,
  request: RewindRequest,
  viewer: Viewer,
  confirmed: boolean,
): Rewind => {
  if (confirmed !== true) throw new RewindNotConfirmedError(request.checkpointId);
  const { forked, activeBranch, preview } = fork(projection, request, viewer);
  const previous = { campaignId: request.parent.campaignId, branchId: request.parent.branchId };
  return {
    ...preview,
    branches: forked,
    activeBranch,
    previous,
    confirmation: `Rewound ${preview.discardedEventCount} events to checkpoint ${request.checkpointId}. Active branch is now ${activeBranch.branchId}. Previous branch ${previous.branchId} is kept unchanged.`,
  };
};

export const selectActiveBranch = (
  branches: readonly Branch[],
  campaignId: CampaignId,
  branchId: BranchId,
): BranchSelection => {
  const timeline = { campaignId, branchId };
  ancestry(branches, timeline);
  return { timeline, confirmation: `Active branch is now ${branchId}.` };
};
