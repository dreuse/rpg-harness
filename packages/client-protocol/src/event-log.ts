import type { BranchId, CampaignId, EventId } from '../../domain/src/campaign.ts';
import { type Accepted, type ClientEvent, failure, type Result, type Unsubscribe } from './protocol.ts';

type Listener = (event: ClientEvent) => void;

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
  const events: ClientEvent[] = [];
  const seen = new Set<EventId>();
  const listeners = new Set<Listener>();
  return {
    publish(event: ClientEvent): Result<Accepted> {
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
      for (const listener of [...listeners]) deliver(listener, event);
      return accepted;
    },
    subscribe(fromRevision: number, listener: Listener): Unsubscribe {
      for (const event of events) if (event.revision > fromRevision) deliver(listener, event);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
