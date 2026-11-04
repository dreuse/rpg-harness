import type { DatabaseSync } from 'node:sqlite';
import { createEventLog } from '../../../packages/client-protocol/src/event-log.ts';
import {
  type CampaignSnapshot,
  type ClientCommand,
  type ClientEvent,
  type ClientSession,
  deepFreeze,
  failure,
  PROTOCOL_VERSION,
  parseCommand,
  type Result,
  toClientEvent,
} from '../../../packages/client-protocol/src/protocol.ts';
import { type CampaignId, type DomainEvent, type EventId, MAIN_BRANCH } from '../../../packages/domain/src/campaign.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import type { Engine } from '../../../packages/engine/src/engine.ts';
import { type Scoped, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import { createEventStore } from '../../../packages/persistence/src/event-store.ts';

export type ScopedEvent = DomainEvent & Scoped;
export type EventSource = (campaignId: CampaignId) => readonly ScopedEvent[];

const SELECT_EVENT_VISIBILITY = 'SELECT id, visibility FROM event_log WHERE campaign_id = ?';
const HIDDEN: Visibility = 'gm';
const UNSUPPORTED_CAPABILITIES = 'this engine does not support capability selection yet';
const UNSUPPORTED_VIEWS = 'this engine does not serve view descriptors yet';
const NO_SUBSCRIPTION = () => {};

export const scopedEventsOf =
  (database: DatabaseSync): EventSource =>
  (campaignId) => {
    const rows = database.prepare(SELECT_EVENT_VISIBILITY).all(campaignId);
    const visibility = new Map(rows.map((row) => [String(row.id), String(row.visibility) as Visibility]));
    return createEventStore(database)
      .list(campaignId, MAIN_BRANCH)
      .map((event) => ({ ...event, visibility: visibility.get(event.id) ?? HIDDEN }));
  };

const attempt = <T>(run: () => T): Result<T> => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return failure('Rejected', error instanceof Error ? error.message : String(error));
  }
};

export const createClientSessions = (engine: Engine, campaignId: CampaignId, readEvents: EventSource) => {
  const log = createEventLog({ campaignId, branchId: MAIN_BRANCH });
  const scopes = new Map<EventId, Scoped>();

  const sync = () => {
    for (const { visibility, ...event } of readEvents(campaignId)) {
      if (scopes.has(event.id)) continue;
      scopes.set(event.id, { visibility, actorId: event.actorId });
      const published = log.publish(toClientEvent(event));
      if (!published.ok) throw new Error(published.error.message);
    }
  };

  const snapshot = (): CampaignSnapshot => {
    sync();
    const { campaign, revision, characters, currentScene, turns } = engine.getState(campaignId);
    return deepFreeze(
      structuredClone({ version: PROTOCOL_VERSION, campaignId, revision, campaign, characters, currentScene, turns }),
    );
  };

  const accept = <T extends ClientCommand>(command: unknown, type: T['type']): Result<T> => {
    const parsed = parseCommand(command);
    if (!parsed.ok) return parsed;
    if (parsed.value.type !== type) return failure('UnknownCommand', `expected ${type}`);
    if (parsed.value.campaignId !== campaignId)
      return failure('Rejected', `campaign ${parsed.value.campaignId} is not served by this session`);
    return parsed as Result<T>;
  };

  sync();

  return (viewer: Viewer): ClientSession => {
    const canSee = (event: ClientEvent) => {
      const scope = scopes.get(event.event.id);
      return scope !== undefined && visibleTo([scope], viewer).length > 0;
    };
    return {
      getSnapshot: (command) => {
        const accepted = accept(command, 'GetCampaignSnapshot');
        return accepted.ok ? attempt(snapshot) : accepted;
      },
      submitPlayerAction: (command) => {
        const accepted = accept<typeof command>(command, 'SubmitPlayerAction');
        if (!accepted.ok) return accepted;
        const { actionId, expectedRevision, sceneId, actorId, input } = accepted.value;
        return attempt(() => {
          engine.submitAction({ campaignId, actionId, expectedRevision, sceneId, actorId, input, intent: input });
          sync();
          return { revision: engine.getState(campaignId).revision };
        });
      },
      selectCapability: (command) => {
        const accepted = accept(command, 'SelectCapability');
        return accepted.ok ? failure('Rejected', UNSUPPORTED_CAPABILITIES) : accepted;
      },
      requestView: (command) => {
        const accepted = accept(command, 'RequestView');
        return accepted.ok ? failure('Rejected', UNSUPPORTED_VIEWS) : accepted;
      },
      subscribeEvents: (command, listener) => {
        const accepted = accept<typeof command>(command, 'SubscribeEvents');
        if (!accepted.ok || !attempt(sync).ok) return NO_SUBSCRIPTION;
        return log.subscribe(accepted.value.fromRevision ?? 0, (event) => {
          if (canSee(event)) listener(event);
        });
      },
    };
  };
};
