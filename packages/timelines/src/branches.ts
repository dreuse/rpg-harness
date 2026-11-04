import { type BranchId, type DomainEvent, type EventId, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { type CheckpointId, CheckpointNotFoundError, type CheckpointPointer, listCheckpoints } from './checkpoints.ts';
import { type Projection, replay, type Timeline } from './replay.ts';

export type Branch = Timeline & {
  readonly parentBranchId: BranchId | null;
  readonly forkEventCount: number;
  readonly forkEventId: EventId | null;
};

export type ForkPoint = { readonly eventCount: number; readonly lastEventId: EventId | null };

export class BranchNotFoundError extends Error {
  readonly branchId: BranchId;
  constructor(branchId: BranchId) {
    super(`branch ${branchId} does not exist in this campaign`);
    this.branchId = branchId;
  }
}

export class DuplicateBranchError extends Error {
  readonly branchId: BranchId;
  constructor(branchId: BranchId) {
    super(`branch ${branchId} already exists in this campaign`);
    this.branchId = branchId;
  }
}

export class ForkPointError extends Error {
  readonly eventCount: number;
  constructor(eventCount: number, lastEventId: EventId | null) {
    super(`fork point at event count ${eventCount} (last event ${lastEventId}) is not on the parent history`);
    this.eventCount = eventCount;
  }
}

export class InvalidBranchNameError extends Error {
  readonly branchName: string;
  constructor(branchName: string) {
    super(`branch name "${branchName}" must be non-empty and free of id separators`);
    this.branchName = branchName;
  }
}

const NO_EVENTS = 0;
const FORK_COUNT_SEPARATOR = '@';
const NAME_SEPARATOR = ':';

const rootBranch = (campaignId: Timeline['campaignId']): Branch => ({
  campaignId,
  branchId: MAIN_BRANCH,
  parentBranchId: null,
  forkEventCount: NO_EVENTS,
  forkEventId: null,
});

const findBranch = (branches: readonly Branch[], { campaignId, branchId }: Timeline) =>
  branches.find((branch) => branch.campaignId === campaignId && branch.branchId === branchId) ??
  (branchId === MAIN_BRANCH ? rootBranch(campaignId) : undefined);

export const ancestry = (branches: readonly Branch[], timeline: Timeline): readonly Branch[] => {
  const branch = findBranch(branches, timeline);
  if (branch === undefined) throw new BranchNotFoundError(timeline.branchId);
  if (branch.parentBranchId === null) return [branch];
  return [...ancestry(branches, { campaignId: branch.campaignId, branchId: branch.parentBranchId }), branch];
};

const ownEvents = (log: readonly DomainEvent[], { campaignId, branchId }: Timeline) =>
  log.filter((event) => event.campaignId === campaignId && event.branchId === branchId);

type Segment = { readonly timeline: Timeline; readonly events: readonly DomainEvent[] };

const truncate = (segments: readonly Segment[], eventCount: number): Segment[] => {
  let remaining = eventCount;
  return segments.map((segment) => {
    const events = segment.events.slice(0, remaining);
    remaining -= events.length;
    return { ...segment, events };
  });
};

const segments = (branches: readonly Branch[], log: readonly DomainEvent[], timeline: Timeline) =>
  ancestry(branches, timeline).reduce<readonly Segment[]>(
    (inherited, branch) => [
      ...truncate(inherited, branch.forkEventCount),
      { timeline: branch, events: ownEvents(log, branch) },
    ],
    [],
  );

export const branchHistory = (branches: readonly Branch[], log: readonly DomainEvent[], timeline: Timeline) =>
  segments(branches, log, timeline).flatMap(({ events }) => events);

export const replayBranch = <S>(
  projection: Projection<S>,
  branches: readonly Branch[],
  log: readonly DomainEvent[],
  timeline: Timeline,
): S =>
  segments(branches, log, timeline).reduce(
    (state, segment) => replay({ ...projection, initial: state }, segment.timeline, segment.events),
    projection.initial,
  );

export const forkBranch = (
  branches: readonly Branch[],
  log: readonly DomainEvent[],
  parent: Timeline,
  at: ForkPoint,
  name: string,
): readonly Branch[] => {
  if (name === '' || [FORK_COUNT_SEPARATOR, NAME_SEPARATOR].some((separator) => name.includes(separator))) {
    throw new InvalidBranchNameError(name);
  }
  const history = branchHistory(branches, log, parent);
  const { eventCount, lastEventId } = at;
  const valid = Number.isInteger(eventCount) && eventCount >= NO_EVENTS && eventCount <= history.length;
  const anchor = eventCount === NO_EVENTS ? null : (history[eventCount - 1]?.id ?? null);
  if (!valid || anchor !== lastEventId) throw new ForkPointError(eventCount, lastEventId);
  const branchId = `${parent.branchId}${FORK_COUNT_SEPARATOR}${eventCount}${NAME_SEPARATOR}${name}`;
  if (findBranch(branches, { campaignId: parent.campaignId, branchId }) !== undefined) {
    throw new DuplicateBranchError(branchId);
  }
  const branch = {
    campaignId: parent.campaignId,
    branchId,
    parentBranchId: parent.branchId,
    forkEventCount: eventCount,
    forkEventId: lastEventId,
  };
  return [...branches, branch];
};

export const forkFromCheckpoint = (
  branches: readonly Branch[],
  checkpoints: readonly CheckpointPointer[],
  log: readonly DomainEvent[],
  parent: Timeline,
  checkpointId: CheckpointId,
  name: string,
): readonly Branch[] => {
  const pointer = listCheckpoints(checkpoints, parent).find(({ id }) => id === checkpointId);
  if (pointer === undefined) throw new CheckpointNotFoundError(checkpointId);
  const branch = findBranch(branches, parent);
  if (branch === undefined) throw new BranchNotFoundError(parent.branchId);
  const forkPoint = {
    eventCount: branch.forkEventCount + pointer.eventCount,
    lastEventId: pointer.eventCount === NO_EVENTS ? branch.forkEventId : pointer.lastEventId,
  };
  return forkBranch(branches, log, parent, forkPoint, name);
};
