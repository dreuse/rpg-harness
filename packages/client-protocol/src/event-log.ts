import type { ClientEvent, Unsubscribe } from './protocol.ts';

type Listener = (event: ClientEvent) => void;

export const createEventLog = () => {
  const events: ClientEvent[] = [];
  const listeners = new Set<Listener>();
  const lastRevision = () => events.at(-1)?.revision ?? 0;
  return {
    publish(event: ClientEvent): void {
      if (event.revision <= lastRevision()) return;
      events.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(fromRevision: number, listener: Listener): Unsubscribe {
      for (const event of events) if (event.revision > fromRevision) listener(event);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
