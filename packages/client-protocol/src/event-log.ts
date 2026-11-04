import type { BranchId, CampaignId, EventId } from '../../domain/src/campaign.ts';
import {
  type Accepted,
  type ClientEvent,
  type EventCommitted,
  failure,
  type Result,
  type Unsubscribe,
} from './protocol.ts';
import {
  type MechanicResult,
  toVisualizationEvent,
  type ViewerScope,
  type VisualizationPreference,
} from './visualization.ts';

type Listener = (event: ClientEvent) => void;

const LEAST_PRIVILEGED: ViewerScope = 'player';

export type Timeline = { readonly campaignId: CampaignId; readonly branchId: BranchId };

const NEXT = 1;

const deliver = (listener: Listener, event: ClientEvent) => {
  try {
    listener(event);
  } catch {
    return;
  }
};

export const createEventLog = ({ campaignId, branchId }: Timeline) => {
  const events: EventCommitted[] = [];
  const seen = new Set<EventId>();
  const listeners = new Map<Listener, ViewerScope>();
  return {
    publish(event: EventCommitted): Result<Accepted> {
      const { id } = event.event;
      const accepted: Result<Accepted> = { ok: true, value: { revision: event.revision } };
      if (event.event.campaignId !== campaignId || event.event.branchId !== branchId)
        return failure('Rejected', `event ${id} is outside ${campaignId}/${branchId}`);
      if (seen.has(id)) return accepted;
      const last = events.at(-1)?.revision ?? event.revision;
      if (event.revision !== last && event.revision !== last + NEXT)
        return failure('Rejected', `event ${id} at revision ${event.revision} does not follow revision ${last}`);
      events.push(event);
      seen.add(id);
      for (const listener of [...listeners.keys()]) deliver(listener, event);
      return accepted;
    },
    visualize(result: MechanicResult, preference: VisualizationPreference) {
      for (const [listener, viewer] of [...listeners]) {
        const event = toVisualizationEvent(result, viewer, preference);
        if (event !== undefined) deliver(listener, event);
      }
    },
    subscribe(fromRevision: number, listener: Listener, viewer: ViewerScope = LEAST_PRIVILEGED): Unsubscribe {
      for (const event of events) if (event.revision > fromRevision) deliver(listener, event);
      listeners.set(listener, viewer);
      return () => listeners.delete(listener);
    },
  };
};
