import type { DatabaseSync } from 'node:sqlite';
import { createEventLog } from '../../../packages/client-protocol/src/event-log.ts';
import {
  type Accepted,
  type CampaignCommand,
  type CampaignPanels,
  type CampaignSnapshot,
  type CampaignSummary,
  type ClientCommand,
  type ClientEvent,
  type ClientSession,
  deepFreeze,
  type EditSheetField,
  EVENT_COMMITTED,
  type EventCommitted,
  failure,
  type GmSnapshot,
  type ListCampaigns,
  PROTOCOL_VERSION,
  parseCommand,
  type Result,
  toClientEvent,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import {
  requestSheetEdit,
  type SheetEdit,
  type SheetSchema,
} from '../../../packages/client-protocol/src/sheet-widgets.ts';
import { parseViewDescriptor, SHEET_VIEW } from '../../../packages/client-protocol/src/view-registry.ts';
import { VISUALIZATION_EVENT, type ViewerScope } from '../../../packages/client-protocol/src/visualization.ts';
import {
  type CampaignId,
  CHARACTER_CREATED,
  type CharacterId,
  type DomainEvent,
  type EventId,
  MAIN_BRANCH,
  StaleRevisionError,
} from '../../../packages/domain/src/campaign.ts';
import type { CampaignEntity, Relationship, Visibility } from '../../../packages/domain/src/entity.ts';
import { EMPTY_GM_USAGE_TOTALS, type GmSettings } from '../../../packages/domain/src/gm.ts';
import { playTurns, SHEET_FIELD_EDITED } from '../../../packages/engine/src/character.ts';
import { currentEncounter } from '../../../packages/engine/src/encounter.ts';
import type { Engine } from '../../../packages/engine/src/engine.ts';
import { gmSettingsOf, gmUsageOf } from '../../../packages/engine/src/gm-settings.ts';
import { CHECK_RESOLVED, campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import { voiceSettingsOf } from '../../../packages/engine/src/voice-settings.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { type Scoped, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { listScopedEvents } from '../../../packages/persistence/src/event-store.ts';
import { rangeIssue } from '../../../packages/rules/src/character-builder.ts';
import { creationRulesFor } from './quickstart.ts';
import { checkFor, emitVisualizations, resultsOf, visualizationPreferenceOf } from './roll-visualization.ts';
import { panelsOf, printable, sheetFields, type ViewSource } from './views.ts';

export type ScopedEvent = DomainEvent & Scoped;
export type EventSource = (campaignId: CampaignId) => readonly ScopedEvent[];
export type World = { readonly entities: readonly CampaignEntity[]; readonly relationships: readonly Relationship[] };
export type WorldSource = (campaignId: CampaignId, heroId: CharacterId | undefined) => World;
export type Sheet = { readonly schema: SheetSchema; readonly values: Readonly<Record<string, unknown>> };
export type SheetPort = {
  read(campaignId: CampaignId, actorId: CharacterId): Sheet | undefined;
  commit(edit: SheetEdit): void;
};

const HIDDEN: Visibility = 'gm';
const UNSUPPORTED_CAPABILITIES = 'this engine does not support capability selection yet';
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
const NEWLINE = '\n';
const UNKNOWN_PLAY_TIME = null;

export const scopedEventsOf =
  (database: DatabaseSync): EventSource =>
  (campaignId) =>
    listScopedEvents(database, campaignId);

export const worldOf =
  (database: DatabaseSync): WorldSource =>
  (campaignId, heroId) => {
    const store = createEntityStore(database);
    const relationships = heroId === undefined ? [] : store.listRelationships(campaignId, heroId);
    return { entities: store.listEntities(campaignId), relationships };
  };

const savedConfig = (events: ViewSource['state']['events']) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok ? saved.config : undefined;
};

export const campaignSummaryOf = (source: ViewSource, viewer: Viewer, lastPlayedAt: string | null): CampaignSummary => {
  const { campaign, characters, events } = source.state;
  const { recap } = panelsOf(source, viewer);
  const config = savedConfig(events);
  const rulepack = config?.rulepack;
  const genre = config?.genre;
  return {
    id: campaign.id,
    name: campaign.name,
    health: 'ok',
    lastPlayedAt,
    sceneTitle: recap.scene ?? null,
    characters: characters.map(({ id, name }) => ({ id, name })),
    ruleset: config && rulepack ? { ...rulepack, provenance: config.provenance.ruleset } : null,
    genre: config && genre ? { ...genre, provenance: config.provenance.genre } : null,
    lastNarration: recap.latest === undefined ? null : (printable(recap.latest).trim().split(NEWLINE).at(-1) ?? null),
    turnCount: playTurns(source.state).length,
  };
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

const redactSheetFieldEdited = (
  viewer: Viewer,
  committed: EventCommitted,
  visibilitiesOf: (actorId: unknown) => TraitVisibilities | undefined,
): EventCommitted => {
  const { event } = committed;
  const { actorId, fieldId } = event.payload;
  if (event.type !== SHEET_FIELD_EDITED || viewer.scope === GM_SCOPE) return committed;
  const visibilities = visibilitiesOf(actorId);
  const isOwner = viewer.scope === ACTOR_SCOPE && viewer.actorId === actorId;
  const shown = visibilities === undefined ? isOwner : traitShownTo(viewer, actorId, visibilities[String(fieldId)]);
  return shown ? committed : deepFreeze({ ...committed, event: { ...event, payload: { actorId } } });
};

const attempt = <T>(run: () => T): Result<T> => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof StaleRevisionError) return failure('StaleRevision', error.message);
    return failure('Rejected', error instanceof Error ? error.message : String(error));
  }
};

const guarded = <T>(run: () => Result<T>): Result<T> => {
  const result = attempt(run);
  return result.ok ? result.value : result;
};

export type GmSessionContext = { readonly sessionId?: string; readonly defaults?: () => GmSettings };

export const gmSnapshotOf = (
  events: Parameters<typeof gmUsageOf>[0],
  defaults: GmSettings,
  sessionId: string | undefined,
): GmSnapshot | undefined => {
  const campaignSettings = gmSettingsOf(events);
  const settings = { ...defaults, ...campaignSettings };
  const campaign = gmUsageOf(events);
  if (Object.keys(settings).length === 0 && campaign.turns === 0) return undefined;
  const session = sessionId === undefined ? EMPTY_GM_USAGE_TOTALS : gmUsageOf(events, sessionId);
  return { settings, campaignSettings, defaults, session, campaign };
};

export const createClientSessions = (
  engine: Engine,
  campaignId: CampaignId,
  readEvents: EventSource,
  readWorld: WorldSource = NO_WORLD,
  sheets?: SheetPort,
  { sessionId, defaults = () => ({}) }: GmSessionContext = {},
) => {
  const log = createEventLog({ campaignId, branchId: MAIN_BRANCH });
  const scopes = new Map<EventId, Scoped>();

  const replayedRolls = (fromRevision: number) => {
    const { events } = engine.getState(campaignId);
    const acted = new Set(currentEncounter(events)?.actions.map(({ eventId }) => eventId));
    const encounter = events
      .filter(({ id }) => acted.has(id))
      .flatMap(({ id, payload }) => resultsOf(payload, scopes.get(id)?.visibility ?? HIDDEN));
    const checks = readEvents(campaignId)
      .filter(({ type, revision }) => type === CHECK_RESOLVED && revision > fromRevision)
      .flatMap(({ payload, visibility }) => resultsOf(payload, visibility));
    return { results: [...encounter, ...checks], preference: visualizationPreferenceOf(events) };
  };

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
    const state = engine.getState(campaignId);
    const { campaign, revision, characters, currentScene } = state;
    const events = readEvents(campaignId);
    const voice = voiceSettingsOf(events);
    const gm = gmSnapshotOf(events, defaults(), sessionId);
    return deepFreeze(
      structuredClone({
        version: PROTOCOL_VERSION,
        campaignId,
        revision,
        campaign,
        characters,
        currentScene,
        turns: playTurns(state),
        ...(voice === undefined ? {} : { voice }),
        ...(gm === undefined ? {} : { gm }),
      }),
    );
  };

  const viewSource = (): ViewSource => {
    sync();
    const state = engine.getState(campaignId);
    const eventScopes = [...scopes].map(([id, scope]) => ({ id, ...scope }));
    return { state, eventScopes, ...readWorld(campaignId, state.characters[0]?.id) };
  };

  const panels = (viewer: Viewer): CampaignPanels => {
    const source = viewSource();
    const shown = panelsOf(source, viewer);
    return deepFreeze(
      structuredClone({ version: PROTOCOL_VERSION, campaignId, revision: source.state.revision, ...shown }),
    );
  };

  const sheetView = (viewer: Viewer): Result<ViewDescriptor> =>
    parseViewDescriptor({
      campaignId,
      viewId: SHEET_VIEW,
      components: sheetFields(viewSource(), viewer),
    });

  const parsedAs = <T extends ClientCommand>(command: unknown, type: T['type']): Result<T> => {
    const parsed = parseCommand(command);
    if (!parsed.ok) return parsed;
    if (parsed.value.type !== type) return failure('UnknownCommand', `expected ${type}`);
    return parsed as Result<T>;
  };

  const accept = <T extends Exclude<ClientCommand, ListCampaigns | CampaignCommand>>(
    command: unknown,
    type: T['type'],
  ): Result<T> => {
    const parsed = parsedAs<T>(command, type);
    if (!parsed.ok) return parsed;
    if (parsed.value.campaignId !== campaignId)
      return failure('Rejected', `campaign ${parsed.value.campaignId} is not served by this session`);
    return parsed as Result<T>;
  };

  const editSheet = (port: SheetPort, { version: _, type: __, ...edit }: EditSheetField): Result<Accepted> => {
    const sheet = port.read(campaignId, edit.actorId);
    if (sheet === undefined) return failure('Rejected', `${edit.actorId} has no character sheet`);
    const checked = requestSheetEdit(sheet.schema, sheet.values, edit);
    if (!checked.ok) return checked;
    const rules = creationRulesFor(savedConfig(engine.getState(campaignId).events)?.rulepack ?? null);
    const outOfRange = rules === undefined ? undefined : rangeIssue(rules, edit.fieldId, edit.value);
    if (outOfRange !== undefined) return failure('Rejected', `${edit.fieldId} ${outOfRange}`);
    port.commit(edit);
    sync();
    return { ok: true, value: { revision: engine.getState(campaignId).revision } };
  };

  sync();

  const sessionFor = (viewer: Viewer): ClientSession => {
    const traitVisibilityOf = (actorId: unknown) =>
      engine
        .getState(campaignId)
        .events.findLast(({ type, payload }) => type === CHARACTER_CREATED && payload.actorId === actorId)?.payload
        .traitVisibility as TraitVisibilities | undefined;
    const redacted = (committed: EventCommitted) =>
      redactSheetFieldEdited(viewer, redactCharacterCreated(viewer, committed), traitVisibilityOf);
    const canSee = (event: ClientEvent) => {
      if (event.type !== EVENT_COMMITTED)
        return event.type === VISUALIZATION_EVENT && VISUALIZING.includes(viewer.scope);
      const scope = scopes.get(event.event.id);
      return scope !== undefined && visibleTo([scope], viewer).length > 0;
    };
    return {
      listCampaigns: (command) => {
        const parsed = parsedAs(command, 'ListCampaigns');
        if (!parsed.ok) return parsed;
        return attempt(() =>
          deepFreeze({
            version: PROTOCOL_VERSION,
            campaigns: [campaignSummaryOf(viewSource(), viewer, UNKNOWN_PLAY_TIME)],
          }),
        );
      },
      getSnapshot: (command) => {
        const accepted = accept(command, 'GetCampaignSnapshot');
        return accepted.ok ? attempt(snapshot) : accepted;
      },
      getPanels: (command) => {
        const accepted = accept(command, 'GetCampaignPanels');
        return accepted.ok ? attempt(() => panels(viewer)) : accepted;
      },
      submitPlayerAction: (command) => {
        const accepted = accept<typeof command>(command, 'SubmitPlayerAction');
        if (!accepted.ok) return accepted;
        const { actionId, expectedRevision, sceneId, actorId, input } = accepted.value;
        return attempt(() => {
          engine.submitAction(
            { campaignId, actionId, expectedRevision, sceneId, actorId, input, intent: input },
            checkFor(engine.getState(campaignId).events, input, actorId, readWorld(campaignId, actorId).entities),
          );
          sync();
          return { revision: engine.getState(campaignId).revision };
        });
      },
      selectCapability: (command) => {
        const accepted = accept(command, 'SelectCapability');
        return accepted.ok ? failure('Rejected', UNSUPPORTED_CAPABILITIES) : accepted;
      },
      requestView: (command) => {
        const accepted = accept<typeof command>(command, 'RequestView');
        if (!accepted.ok) return accepted;
        if (accepted.value.viewId !== SHEET_VIEW)
          return failure('Rejected', `this engine does not serve the ${accepted.value.viewId} view yet`);
        return guarded(() => sheetView(viewer));
      },
      subscribeEvents: (command, listener) => {
        const accepted = accept<typeof command>(command, 'SubscribeEvents');
        if (!accepted.ok || !attempt(sync).ok) return NO_SUBSCRIPTION;
        const scope = viewer.scope === GM_SCOPE ? GM_SCOPE : PLAYER_SCOPE;
        const filtered = (event: ClientEvent) => {
          if (!canSee(event)) return;
          listener(event.type === EVENT_COMMITTED ? redacted(event) : event);
        };
        const fromRevision = accepted.value.fromRevision ?? 0;
        const unsubscribe = log.subscribe(fromRevision, filtered, scope);
        attempt(() => {
          const { results, preference } = replayedRolls(fromRevision);
          for (const event of emitVisualizations(results, scope, preference)) filtered({ ...event, replayed: true });
        });
        return unsubscribe;
      },
      editSheetField: (command) => {
        const accepted = accept<typeof command>(command, 'EditSheetField');
        if (!accepted.ok) return accepted;
        if (sheets === undefined) return failure('Rejected', UNSUPPORTED_SHEETS);
        return guarded(() => editSheet(sheets, accepted.value));
      },
      saveVoiceSettings: (command) => {
        const accepted = accept<typeof command>(command, 'SaveVoiceSettings');
        if (!accepted.ok) return accepted;
        const { version: _, type: __, campaignId: ___, actionId, expectedRevision, ...settings } = accepted.value;
        return attempt(() => {
          engine.saveVoiceSettings({ campaignId, actionId, expectedRevision, settings });
          sync();
          return { revision: engine.getState(campaignId).revision };
        });
      },
      saveGmSettings: (command) => {
        const accepted = accept<typeof command>(command, 'SaveGmSettings');
        if (!accepted.ok) return accepted;
        const { version: _, type: __, campaignId: ___, actionId, expectedRevision, ...settings } = accepted.value;
        return attempt(() => {
          engine.saveGmSettings({ campaignId, actionId, expectedRevision, settings });
          sync();
          return { revision: engine.getState(campaignId).revision };
        });
      },
    };
  };

  return Object.assign(sessionFor, { visualize: log.visualize });
};
