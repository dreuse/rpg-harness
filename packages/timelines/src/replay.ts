import {
  type BranchId,
  CampaignBoundaryError,
  type CampaignId,
  type DomainEvent,
  type EventId,
} from '../../domain/src/campaign.ts';

export type Projection<S> = {
  readonly version: number;
  readonly initial: S;
  readonly apply: (state: S, event: DomainEvent) => S;
};

export type Timeline = { readonly campaignId: CampaignId; readonly branchId: BranchId };

export type Snapshot<S> = Timeline & {
  readonly version: number;
  readonly eventCount: number;
  readonly lastEventId: EventId | null;
  readonly state: S;
};

export class SnapshotMismatchError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`snapshot does not match the event log: ${reason}`);
    this.reason = reason;
  }
}

export class EventOrderError extends Error {
  readonly eventId: EventId;
  constructor(eventId: EventId, revision: number, previous: number) {
    super(`event ${eventId} at revision ${revision} follows revision ${previous}`);
    this.eventId = eventId;
  }
}

const NO_EVENTS = 0;

const requireTimeline = ({ campaignId, branchId }: Timeline, events: readonly DomainEvent[]) => {
  events.forEach((event, index) => {
    if (event.campaignId !== campaignId) throw new CampaignBoundaryError(campaignId, `event ${event.id}`);
    if (event.branchId !== branchId) throw new CampaignBoundaryError(campaignId, `branch ${event.branchId}`);
    const previous = events[index - 1];
    if (previous !== undefined && event.revision < previous.revision) {
      throw new EventOrderError(event.id, event.revision, previous.revision);
    }
  });
};

const requireAnchor = <S>(timeline: Timeline, events: readonly DomainEvent[], snapshot: Snapshot<S>) => {
  const { campaignId, branchId, eventCount, lastEventId } = snapshot;
  if (campaignId !== timeline.campaignId) throw new SnapshotMismatchError(`campaign ${campaignId}`);
  if (branchId !== timeline.branchId) throw new SnapshotMismatchError(`branch ${branchId}`);
  if (!Number.isInteger(eventCount) || eventCount < NO_EVENTS || eventCount > events.length) {
    throw new SnapshotMismatchError(`event count ${eventCount}`);
  }
  const anchor = eventCount === NO_EVENTS ? null : (events[eventCount - 1]?.id ?? null);
  if (anchor !== lastEventId) throw new SnapshotMismatchError(`last event ${lastEventId}`);
};

export const replay = <S>(
  projection: Projection<S>,
  timeline: Timeline,
  events: readonly DomainEvent[],
  snapshot?: Snapshot<S>,
): S => {
  requireTimeline(timeline, events);
  const usable = snapshot !== undefined && snapshot.version === projection.version;
  if (usable) requireAnchor(timeline, events, snapshot);
  const start = usable ? snapshot : { state: projection.initial, eventCount: NO_EVENTS };
  return events.slice(start.eventCount).reduce(projection.apply, start.state);
};

export const isResumable = <S>(projection: Projection<S>, timeline: Timeline, snapshot: Snapshot<S>) =>
  snapshot.version === projection.version &&
  snapshot.campaignId === timeline.campaignId &&
  snapshot.branchId === timeline.branchId;

export const checkpoint = <S>(
  projection: Projection<S>,
  timeline: Timeline,
  events: readonly DomainEvent[],
  snapshot?: Snapshot<S>,
): Snapshot<S> => ({
  ...timeline,
  version: projection.version,
  eventCount: events.length,
  lastEventId: events.at(-1)?.id ?? null,
  state: replay(projection, timeline, events, snapshot),
});
