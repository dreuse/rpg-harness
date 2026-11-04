import type { DomainEvent } from '../../domain/src/campaign.ts';
import { checkpoint, type Projection, type Snapshot, SnapshotMismatchError, type Timeline } from './replay.ts';

export type CheckpointId = string;

export type CheckpointPointer = Omit<Snapshot<unknown>, 'state'> & { readonly id: CheckpointId };

export class CheckpointNotFoundError extends Error {
  readonly checkpointId: CheckpointId;
  constructor(checkpointId: CheckpointId) {
    super(`checkpoint ${checkpointId} does not exist on this timeline`);
    this.checkpointId = checkpointId;
  }
}

export class DuplicateCheckpointError extends Error {
  readonly checkpointId: CheckpointId;
  constructor(checkpointId: CheckpointId) {
    super(`checkpoint ${checkpointId} already exists on this timeline`);
    this.checkpointId = checkpointId;
  }
}

export class CheckpointVersionError extends Error {
  readonly checkpointId: CheckpointId;
  constructor(checkpointId: CheckpointId, version: number, expected: number) {
    super(`checkpoint ${checkpointId} uses snapshot version ${version}, expected ${expected}`);
    this.checkpointId = checkpointId;
  }
}

const onTimeline =
  ({ campaignId, branchId }: Timeline) =>
  (pointer: CheckpointPointer) =>
    pointer.campaignId === campaignId && pointer.branchId === branchId;

export const listCheckpoints = (checkpoints: readonly CheckpointPointer[], timeline: Timeline) =>
  checkpoints.filter(onTimeline(timeline));

const findCheckpoint = (checkpoints: readonly CheckpointPointer[], timeline: Timeline, id: CheckpointId) =>
  listCheckpoints(checkpoints, timeline).find((pointer) => pointer.id === id);

export const createCheckpoint = <S>(
  checkpoints: readonly CheckpointPointer[],
  projection: Projection<S>,
  timeline: Timeline,
  events: readonly DomainEvent[],
  id: CheckpointId,
): readonly CheckpointPointer[] => {
  if (findCheckpoint(checkpoints, timeline, id) !== undefined) throw new DuplicateCheckpointError(id);
  const { state: _state, ...pointer } = checkpoint(projection, timeline, events);
  return [...checkpoints, { ...pointer, id }];
};

export const restoreCheckpoint = <S>(
  checkpoints: readonly CheckpointPointer[],
  projection: Projection<S>,
  timeline: Timeline,
  events: readonly DomainEvent[],
  id: CheckpointId,
): Snapshot<S> => {
  const pointer = findCheckpoint(checkpoints, timeline, id);
  if (pointer === undefined) throw new CheckpointNotFoundError(id);
  if (pointer.version !== projection.version) throw new CheckpointVersionError(id, pointer.version, projection.version);
  const restored = checkpoint(projection, timeline, events.slice(0, pointer.eventCount));
  if (restored.eventCount !== pointer.eventCount) throw new SnapshotMismatchError(`event count ${pointer.eventCount}`);
  if (restored.lastEventId !== pointer.lastEventId)
    throw new SnapshotMismatchError(`last event ${pointer.lastEventId}`);
  return restored;
};
