import type { DatabaseSync } from 'node:sqlite';
import { createEventLog } from '../../../packages/client-protocol/src/event-log.ts';
import {
  type Accepted,
  type CampaignPanels,
  type CampaignSnapshot,
  type ClientCommand,
  type ClientEvent,
  type ClientSession,
  deepFreeze,
  type EditSheetField,
  EVENT_COMMITTED,
  type EventCommitted,
  failure,
  PROTOCOL_VERSION,
  parseCommand,
  type Result,
  toClientEvent,
} from '../../../packages/client-protocol/src/protocol.ts';
import {
  requestSheetEdit,
  type SheetEdit,
  type SheetSchema,
} from '../../../packages/client-protocol/src/sheet-widgets.ts';
import { VISUALIZATION_EVENT, type ViewerScope } from '../../../packages/client-protocol/src/visualization.ts';
import {
  type CampaignId,
  CHARACTER_CREATED,
  type CharacterId,
  type DomainEvent,
  type EventId,
  MAIN_BRANCH,
} from '../../../packages/domain/src/campaign.ts';
import type { CampaignEntity, Relationship, Visibility } from '../../../packages/domain/src/entity.ts';
import type { Engine } from '../../../packages/engine/src/engine.ts';
import { type Scoped, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { createEventStore } from '../../../packages/persistence/src/event-store.ts';
import { resultsOf, visualizationPreferenceOf } from './roll-visualization.ts';
import { panelsOf } from './views.ts';

export type ScopedEvent = DomainEvent & Scoped;
export type EventSource = (campaignId: CampaignId) => readonly ScopedEvent[];
export type World = { readonly entities: readonly CampaignEntity[]; readonly relationships: readonly Relationship[] };
export type WorldSource = (campaignId: CampaignId, heroId: CharacterId | undefined) => World;
export type Sheet = { readonly schema: SheetSchema; readonly values: Readonly<Record<string, unknown>> };
export type SheetPort = {
  read(campaignId: CampaignId, actorId: CharacterId): Sheet | undefined;
  commit(edit: SheetEdit): void;
};

const SELECT_EVENT_VISIBILITY = 'SELECT id, visibility FROM event_log WHERE campaign_id = ?';
const HIDDEN: Visibility = 'gm';
const UNSUPPORTED_CAPABILITIES = 'this engine does not support capability selection yet';
const UNSUPPORTED_VIEWS = 'this engine does not serve view descriptors yet';
const UNSUPPORTED_SHEETS = 'this engine does not serve character sheets yet';
const NO_SUBSCRIPTION = () => {};
const ACTOR_SCOPE: Viewer['scope'] = 'actor';
const PUBLIC_TRAIT = 'public';
const OWNER_TRAIT = 'owner';
const GM_SCOPE: ViewerScope = 'gm';
const PLAYER_SCOPE: ViewerScope = 'player';
const VISUALIZING: readonly Viewer['scope'][] = [GM_SCOPE, PLAYER_SCOPE];
const EMPTY_WORLD: World = { entities: [], relationships: [] };
const NO_WORLD: WorldSource = () => EMPTY_WORLD;

export const scopedEventsOf =
  (database: DatabaseSync): EventSource =>
  (campaignId) => {
    const rows = database.prepare(SELECT_EVENT_VISIBILITY).all(campaignId);
    const visibility = new Map(rows.map((row) => [String(row.id), String(row.visibility) as Visibility]));
    return createEventStore(database)
      .list(campaignId, MAIN_BRANCH)
      .map((event) => ({ ...event, visibility: visibility.get(event.id) ?? HIDDEN }));
  };

export const worldOf =
  (database: DatabaseSync): WorldSource =>
  (campaignId, heroId) => {
    const store = createEntityStore(database);
    const relationships = heroId === undefined ? [] : store.listRelationships(campaignId, heroId);
    return { entities: store.listEntities(campaignId), relationships };
  };

type TraitVisibilities = Readonly<Record<string, string>>;

const traitShownTo = (viewer: Viewer, ownerId: unknown, visibility: string | undefined) =>
  viewer.scope === GM_SCOPE ||
  visibility === PUBLIC_TRAIT ||
  (visibility === OWNER_TRAIT && viewer.scope === ACTOR_SCOPE && viewer.actorId === ownerId);

const redactCharacterCreated = (viewer: Viewer, committed: EventCommitted): EventCommitted => {
  const { event } = committed;
  const { payload } = event;
  const visibilities = payload.traitVisibility as TraitVisibilities | undefined;
  const profile = payload.profile as { traits?: { id: string }[] } | undefined;
  const overrides = payload.overrides as { fieldId: string }[] | undefined;
  if (event.type !== CHARACTER_CREATED || viewer.scope === GM_SCOPE) return committed;
  const isOwner = viewer.scope === ACTOR_SCOPE && viewer.actorId === payload.actorId;
  if (visibilities === undefined && isOwner) return committed;
  const known = visibilities ?? {};
  const shown = (id: string) => traitShownTo(viewer, payload.actorId, known[id]);
  const traitVisibility = Object.fromEntries(Object.entries(known).filter(([id]) => shown(id)));
  const redacted = {
    ...payload,
    traitVisibility,
    overrides: overrides?.filter(({ fieldId }) => shown(fieldId)) ?? [],
    profile: { ...profile, traits: profile?.traits?.filter(({ id }) => shown(id)) ?? [] },
  };
  return deepFreeze({ ...committed, event: { ...event, payload: redacted } });
};

const attempt = <T>(run: () => T): Result<T> => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return failure('Rejected', error instanceof Error ? error.message : String(error));
  }
};

const guarded = <T>(run: () => Result<T>): Result<T> => {
  const result = attempt(run);
  return result.ok ? result.value : result;
};

export const createClientSessions = (
  engine: Engine,
  campaignId: CampaignId,
  readEvents: EventSource,
  readWorld: WorldSource = NO_WORLD,
  sheets?: SheetPort,
) => {
  const log = createEventLog({ campaignId, branchId: MAIN_BRANCH });
  const scopes = new Map<EventId, Scoped>();

  const sync = () => {
    const fresh = readEvents(campaignId).filter(({ id }) => !scopes.has(id));
    if (fresh.length === 0) return;
    const preference = visualizationPreferenceOf(engine.getState(campaignId).events);
    for (const { visibility, ...event } of fresh) {
      scopes.set(event.id, { visibility, actorId: event.actorId });
      const published = log.publish(toClientEvent(event));
      if (!published.ok) throw new Error(published.error.message);
      for (const result of resultsOf(event.payload, visibility)) log.visualize(result, preference);
    }
  };

  const snapshot = (): CampaignSnapshot => {
    sync();
    const { campaign, revision, characters, currentScene, turns } = engine.getState(campaignId);
    return deepFreeze(
      structuredClone({ version: PROTOCOL_VERSION, campaignId, revision, campaign, characters, currentScene, turns }),
    );
  };

  const panels = (viewer: Viewer): CampaignPanels => {
    sync();
    const state = engine.getState(campaignId);
    const eventScopes = [...scopes].map(([id, scope]) => ({ id, ...scope }));
    const world = readWorld(campaignId, state.characters[0]?.id);
    const shown = panelsOf({ state, eventScopes, ...world }, viewer);
    return deepFreeze(structuredClone({ version: PROTOCOL_VERSION, campaignId, revision: state.revision, ...shown }));
  };

  const accept = <T extends ClientCommand>(command: unknown, type: T['type']): Result<T> => {
    const parsed = parseCommand(command);
    if (!parsed.ok) return parsed;
    if (parsed.value.type !== type) return failure('UnknownCommand', `expected ${type}`);
    if (parsed.value.campaignId !== campaignId)
      return failure('Rejected', `campaign ${parsed.value.campaignId} is not served by this session`);
    return parsed as Result<T>;
  };

  const editSheet = (port: SheetPort, { version: _, type: __, ...edit }: EditSheetField): Result<Accepted> => {
    const { revision } = engine.getState(campaignId);
    if (edit.expectedRevision !== revision)
      return failure('Rejected', `stale revision ${edit.expectedRevision}, current is ${revision}`);
    const sheet = port.read(campaignId, edit.actorId);
    if (sheet === undefined) return failure('Rejected', `${edit.actorId} has no character sheet`);
    const checked = requestSheetEdit(sheet.schema, sheet.values, edit);
    if (!checked.ok) return checked;
    port.commit(edit);
    sync();
    return { ok: true, value: { revision: engine.getState(campaignId).revision } };
  };

  sync();

  const sessionFor = (viewer: Viewer): ClientSession => {
    const canSee = (event: ClientEvent) => {
      if (event.type !== EVENT_COMMITTED)
        return event.type === VISUALIZATION_EVENT && VISUALIZING.includes(viewer.scope);
      const scope = scopes.get(event.event.id);
      return scope !== undefined && visibleTo([scope], viewer).length > 0;
    };
    return {
      getSnapshot: (command) => {
        const accepted = accept(command, 'GetCampaignSnapshot');
        return accepted.ok ? attempt(snapshot) : accepted;
      },
      getPanels: (command) => {
        const accepted = accept(command, 'GetCampaignSnapshot');
        return accepted.ok ? attempt(() => panels(viewer)) : accepted;
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
        return log.subscribe(
          accepted.value.fromRevision ?? 0,
          (event) => {
            if (!canSee(event)) return;
            listener(event.type === EVENT_COMMITTED ? redactCharacterCreated(viewer, event) : event);
          },
          viewer.scope === GM_SCOPE ? GM_SCOPE : PLAYER_SCOPE,
        );
      },
      editSheetField: (command) => {
        const accepted = accept<typeof command>(command, 'EditSheetField');
        if (!accepted.ok) return accepted;
        if (sheets === undefined) return failure('Rejected', UNSUPPORTED_SHEETS);
        return guarded(() => editSheet(sheets, accepted.value));
      },
    };
  };

  return Object.assign(sessionFor, { visualize: log.visualize });
};
