import type { DatabaseSync } from 'node:sqlite';
import { createEventLog, EVENT_LOG_WINDOW } from '../../../packages/client-protocol/src/event-log.ts';
import { parseOocInput } from '../../../packages/client-protocol/src/ooc.ts';
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
  type NoRoll,
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
  type CampaignState,
  CHARACTER_CREATED,
  CHECK_RESOLVED,
  CHECK_SKIPPED,
  type CharacterId,
  type DomainEvent,
  type EventId,
  GM_ROLLED,
  MAIN_BRANCH,
  type NoCheckReason,
  StaleRevisionError,
} from '../../../packages/domain/src/campaign.ts';
import type { CampaignEntity, Relationship, Visibility } from '../../../packages/domain/src/entity.ts';
import {
  DEFAULT_WHO_ROLLS,
  EMPTY_GM_USAGE_TOTALS,
  type GmSettings,
  ledgerTotals,
} from '../../../packages/domain/src/gm.ts';
import { ROLL_CORRECTED } from '../../../packages/domain/src/ooc.ts';
import type { StoryMemory } from '../../../packages/domain/src/story-memory.ts';
import { playTurns, SHEET_FIELD_EDITED } from '../../../packages/engine/src/character.ts';
import { pendingCheckOffer } from '../../../packages/engine/src/check-offer.ts';
import { campaignLanguageOf, type Engine } from '../../../packages/engine/src/engine.ts';
import { contextDroppedOften, gmSettingsOf } from '../../../packages/engine/src/gm-settings.ts';
import { RollReportError } from '../../../packages/engine/src/roll-report.ts';
import type { StoryCorrection } from '../../../packages/engine/src/story-memory.ts';
import { campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import { voiceSettingsOf } from '../../../packages/engine/src/voice-settings.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { type Scoped, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { type EventQuery, listScopedEvents } from '../../../packages/persistence/src/event-store.ts';
import { rangeIssue } from '../../../packages/rules/src/character-builder.ts';
import { correctD20Roll, fakeOocReply, houseRuleOf } from './gm-ooc.ts';
import { DEFAULT_LOCALE, errorText, LocalizedError, say } from './messages.ts';
import { creationRulesFor, usageFor } from './quickstart.ts';
import {
  checkForAction,
  emitVisualizations,
  resultsOf,
  rollExpressionFor,
  rulesStrictnessFor,
  visualizationPreferenceOf,
  whoRollsFor,
} from './roll-visualization.ts';
import { encounterOf, panelsOf, printable, sheetFields, type ViewSource } from './views.ts';

export type ScopedEvent = DomainEvent & Scoped & { readonly seq: number };
export type EventSource = (campaignId: CampaignId, query?: EventQuery) => readonly ScopedEvent[];
export type World = { readonly entities: readonly CampaignEntity[]; readonly relationships: readonly Relationship[] };
export type WorldSource = (campaignId: CampaignId, heroId: CharacterId | undefined) => World;
export type Sheet = { readonly schema: SheetSchema; readonly values: Readonly<Record<string, unknown>> };
export type StoryPort = {
  read(campaignId: CampaignId): StoryMemory;
  correct(correction: StoryCorrection): void;
};
export type SheetPort = {
  read(campaignId: CampaignId, actorId: CharacterId): Sheet | undefined;
  commit(edit: SheetEdit): void;
};

const HIDDEN: Visibility = 'gm';
const UNSUPPORTED_CAPABILITIES = 'this engine does not support capability selection yet';
const UNSUPPORTED_STORY = 'this engine does not serve story memory yet';
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
const SCOPE_CACHE_SLACK = 2;
const UNKNOWN_PLAY_TIME = null;

const ROLL_EVENT_TYPES = [CHECK_RESOLVED, GM_ROLLED, ROLL_CORRECTED];

export const scopedEventsOf =
  (database: DatabaseSync): EventSource =>
  (campaignId, query) =>
    listScopedEvents(database, campaignId, query);

export const worldOf =
  (database: DatabaseSync): WorldSource =>
  (campaignId, heroId) => {
    const store = createEntityStore(database);
    const relationships = heroId === undefined ? [] : store.listRelationships(campaignId, heroId);
    return { entities: store.listEntities(campaignId), relationships };
  };

const NPC_KIND = 'npc';

const speakersOf = (entities: World['entities'], viewer: Viewer) =>
  visibleTo(entities, viewer)
    .filter(({ kind }) => kind === NPC_KIND)
    .map(({ id, name }) => ({ id, name }));

const noRollOf = (state: CampaignState): NoRoll | undefined => {
  const latest = playTurns(state).at(-1);
  const skipped = state.events.find(({ type, turnId }) => type === CHECK_SKIPPED && turnId === latest?.id);
  return latest === undefined || skipped === undefined
    ? undefined
    : { actionId: latest.actionId, reason: skipped.payload.reason as NoCheckReason };
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

const localizedFailure = (error: unknown, language: string | undefined) =>
  error instanceof LocalizedError || error instanceof RollReportError
    ? new Error(errorText(language ?? DEFAULT_LOCALE, error), { cause: error })
    : error;

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

export type GmSessionContext = {
  readonly sessionId?: string;
  readonly defaults?: () => GmSettings;
  readonly logWindow?: number;
  readonly story?: StoryPort;
};

export const gmSnapshotOf = (
  { changes, gmUsage }: Pick<CampaignState, 'changes' | 'gmUsage'>,
  defaults: GmSettings,
  sessionId: string | undefined,
): GmSnapshot | undefined => {
  const campaignSettings = gmSettingsOf(changes);
  const settings = { ...defaults, ...campaignSettings };
  const campaign = ledgerTotals(gmUsage);
  if (Object.keys(settings).length === 0 && campaign.turns === 0) return undefined;
  const session = sessionId === undefined ? EMPTY_GM_USAGE_TOTALS : ledgerTotals(gmUsage, sessionId);
  return {
    settings,
    campaignSettings,
    defaults,
    session,
    campaign,
    ...(contextDroppedOften(changes) ? { contextTight: true } : {}),
  };
};

export const createScopeLookup = (
  read: EventSource,
  campaignId: CampaignId,
  known: (id: EventId) => Scoped | undefined = () => undefined,
) => {
  const remembered = new Map<EventId, Scoped>();
  return (wanted: readonly EventId[]): ReadonlyMap<EventId, Scoped> => {
    const missing: EventId[] = [];
    for (const id of wanted) {
      const scope = known(id);
      if (scope !== undefined) remembered.set(id, scope);
      else if (!remembered.has(id)) missing.push(id);
    }
    if (missing.length > 0)
      for (const { id, visibility, actorId } of read(campaignId, { ids: missing }))
        remembered.set(id, { visibility, actorId });
    if (remembered.size > wanted.length * SCOPE_CACHE_SLACK) {
      const keep = new Set(wanted);
      for (const id of remembered.keys()) if (!keep.has(id)) remembered.delete(id);
    }
    return remembered;
  };
};

const scopeLookups = new WeakMap<DatabaseSync, Map<CampaignId, ReturnType<typeof createScopeLookup>>>();

export const scopeLookupOf = (database: DatabaseSync, campaignId: CampaignId) => {
  const byCampaign = scopeLookups.get(database) ?? new Map();
  scopeLookups.set(database, byCampaign);
  const existing = byCampaign.get(campaignId);
  if (existing !== undefined) return existing;
  const created = createScopeLookup(scopedEventsOf(database), campaignId);
  byCampaign.set(campaignId, created);
  return created;
};

export const createClientSessions = (
  engine: Engine,
  campaignId: CampaignId,
  readEvents: EventSource,
  readWorld: WorldSource = NO_WORLD,
  sheets?: SheetPort,
  { sessionId, defaults = () => ({}), logWindow = EVENT_LOG_WINDOW, story }: GmSessionContext = {},
) => {
  const log = createEventLog({ campaignId, branchId: MAIN_BRANCH }, logWindow);
  const scopes = new Map<EventId, Scoped & { readonly seq: number }>();
  let cursor: number | undefined;

  const scopesFor = createScopeLookup(readEvents, campaignId, (id) => scopes.get(id));
  const viewScopes = createScopeLookup(readEvents, campaignId, (id) => scopes.get(id));

  const replayedRolls = (fromRevision: number) => {
    const state = engine.getState(campaignId);
    const { events } = state;
    const acted = new Set(encounterOf(state)?.actions.map(({ eventId }) => eventId));
    const actedEvents = events.filter(({ id }) => acted.has(id));
    const actedScopes = scopesFor(actedEvents.map(({ id }) => id));
    const encounter = actedEvents.flatMap(({ id, payload }) =>
      resultsOf(payload, actedScopes.get(id)?.visibility ?? HIDDEN),
    );
    const checks = ROLL_EVENT_TYPES.flatMap((type) => readEvents(campaignId, { type, afterRevision: fromRevision }))
      .sort((first, second) => first.seq - second.seq)
      .flatMap(({ payload, visibility }) => resultsOf(payload, visibility));
    return { results: [...encounter, ...checks], preference: visualizationPreferenceOf(events) };
  };

  const sync = () => {
    const fresh = readEvents(campaignId, cursor === undefined ? { tail: logWindow } : { afterSeq: cursor });
    if (fresh.length === 0) return;
    const preference = visualizationPreferenceOf(engine.getState(campaignId).events);
    for (const { visibility, seq, ...event } of fresh) {
      scopes.set(event.id, { visibility, actorId: event.actorId, seq });
      cursor = seq;
      const published = log.publish(toClientEvent(event));
      if (!published.ok) throw new Error(published.error.message);
      for (const result of resultsOf(event.payload, visibility)) log.visualize(result, preference);
    }
    for (const oldest of scopes.keys()) {
      if (scopes.size <= logWindow) break;
      scopes.delete(oldest);
    }
  };

  const snapshot = (viewer: Viewer): CampaignSnapshot => {
    sync();
    const state = engine.getState(campaignId);
    const { campaign, revision, characters, currentScene } = state;
    const voice = voiceSettingsOf(state.changes);
    const language = campaignLanguageOf(state.changes);
    const gm = gmSnapshotOf(state, defaults(), sessionId);
    const config = savedConfig(state.events);
    const pending = pendingCheckOffer(state.events);
    const expression =
      pending !== undefined && whoRollsFor(state, defaults()) !== DEFAULT_WHO_ROLLS
        ? rollExpressionFor(
            state.events,
            pending,
            characters[0]?.id ?? '',
            readWorld(campaignId, characters[0]?.id).entities,
          )
        : undefined;
    const rollOffer =
      pending === undefined
        ? undefined
        : {
            ...pending,
            ...(pending.modifiers === undefined
              ? {}
              : { modifiers: pending.modifiers.map(({ id, reason }) => ({ id, reason })) }),
            ...(expression === undefined ? {} : { expression }),
          };
    const noRoll = noRollOf(state);
    return deepFreeze(
      structuredClone({
        version: PROTOCOL_VERSION,
        campaignId,
        revision,
        campaign,
        characters,
        speakers: speakersOf(readWorld(campaignId, characters[0]?.id).entities, viewer),
        currentScene,
        turns: playTurns(state),
        ...(rollOffer === undefined ? {} : { rollOffer }),
        ...(noRoll === undefined ? {} : { noRoll }),
        ...(language === undefined ? {} : { language }),
        ...(voice === undefined ? {} : { voice }),
        ...(gm === undefined ? {} : { gm }),
        ...(config === undefined ? {} : { rules: usageFor(config.rulepack) }),
      }),
    );
  };

  const viewSource = (): ViewSource => {
    sync();
    const state = engine.getState(campaignId);
    const known = viewScopes(state.events.map(({ id }) => id));
    const eventScopes = [...known].map(([id, scope]) => ({ id, ...scope }));
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
      components: sheetFields(
        viewSource(),
        viewer,
        campaignLanguageOf(engine.getState(campaignId).changes) ?? DEFAULT_LOCALE,
      ),
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
    const canSee = (
      event: ClientEvent,
      scope: Scoped | undefined = scopes.get(event.type === EVENT_COMMITTED ? event.event.id : ''),
    ) => {
      if (event.type !== EVENT_COMMITTED)
        return event.type === VISUALIZATION_EVENT && VISUALIZING.includes(viewer.scope);
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
        return accepted.ok ? attempt(() => snapshot(viewer)) : accepted;
      },
      getPanels: (command) => {
        const accepted = accept(command, 'GetCampaignPanels');
        return accepted.ok ? attempt(() => panels(viewer)) : accepted;
      },
      submitPlayerAction: (command) => {
        const accepted = accept<typeof command>(command, 'SubmitPlayerAction');
        if (!accepted.ok) return accepted;
        const { actionId, expectedRevision, sceneId, actorId, input, rollOfferId, reportedRoll } = accepted.value;
        if (parseOocInput(input) !== undefined)
          return failure(
            'Rejected',
            say(campaignLanguageOf(engine.getState(campaignId).changes) ?? DEFAULT_LOCALE, 'ooc.notAction'),
          );
        return attempt(() => {
          const state = engine.getState(campaignId);
          try {
            engine.submitAction(
              { campaignId, actionId, expectedRevision, sceneId, actorId, input, intent: input },
              checkForAction(
                state.events,
                { input, rollOfferId, reportedRoll, whoRolls: whoRollsFor(state, defaults()) },
                actorId,
                readWorld(campaignId, actorId).entities,
                rulesStrictnessFor(state, defaults()),
              ),
            );
          } catch (error) {
            throw localizedFailure(error, campaignLanguageOf(state.changes));
          }
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
        const filtered = (event: ClientEvent, known?: Scoped) => {
          if (!canSee(event, known)) return;
          listener(event.type === EVENT_COMMITTED ? redacted(event) : event);
        };
        const { fromRevision: requested } = accepted.value;
        const fromRevision = requested ?? 0;
        const floor = scopes.values().next().value?.seq;
        if (requested !== undefined && floor !== undefined)
          for (const { visibility, seq: _, ...event } of readEvents(campaignId, {
            afterRevision: requested,
            beforeSeq: floor,
          }))
            filtered(toClientEvent(event), { visibility, actorId: event.actorId });
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
      getStoryMemory: (command) => {
        const accepted = accept<typeof command>(command, 'GetStoryMemory');
        if (!accepted.ok) return accepted;
        if (story === undefined) return failure('Rejected', UNSUPPORTED_STORY);
        return attempt(() => {
          sync();
          return deepFreeze({
            version: PROTOCOL_VERSION,
            campaignId,
            revision: engine.getState(campaignId).revision,
            memory: structuredClone(story.read(campaignId)),
          });
        });
      },
      correctStoryFact: (command) => {
        const accepted = accept<typeof command>(command, 'CorrectStoryFact');
        if (!accepted.ok) return accepted;
        if (story === undefined) return failure('Rejected', UNSUPPORTED_STORY);
        const { version: _, type: __, ...correction } = accepted.value;
        return attempt(() => {
          story.correct(correction);
          sync();
          return { revision: engine.getState(campaignId).revision };
        });
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
      setCampaignLanguage: (command) => {
        const accepted = accept<typeof command>(command, 'SetCampaignLanguage');
        if (!accepted.ok) return accepted;
        const { actionId, expectedRevision, language } = accepted.value;
        return attempt(() => {
          engine.setCampaignLanguage({ campaignId, actionId, expectedRevision, language });
          sync();
          return { revision: engine.getState(campaignId).revision };
        });
      },
      submitOocMessage: (command) => {
        const accepted = accept<typeof command>(command, 'SubmitOocMessage');
        if (!accepted.ok) return accepted;
        return attempt(() =>
          deepFreeze(
            fakeOocReply(
              parseOocInput(accepted.value.text) ?? accepted.value.text,
              campaignLanguageOf(engine.getState(campaignId).changes) ?? DEFAULT_LOCALE,
            ),
          ),
        );
      },
      confirmOocProposal: (command) => {
        const accepted = accept<typeof command>(command, 'ConfirmOocProposal');
        if (!accepted.ok) return accepted;
        const { actionId, expectedRevision, proposal } = accepted.value;
        return attempt(() => {
          const state = engine.getState(campaignId);
          const locale = campaignLanguageOf(state.changes) ?? DEFAULT_LOCALE;
          const prepared =
            proposal.kind === 'house_rule' ? { ...proposal, rule: houseRuleOf(state, proposal, locale) } : proposal;
          const applied = engine.applyOoc({
            campaignId,
            actionId,
            expectedRevision,
            proposal: prepared,
            correctRoll: correctD20Roll,
          });
          sync();
          return applied;
        });
      },
      undoOocChange: (command) => {
        const accepted = accept<typeof command>(command, 'UndoOocChange');
        if (!accepted.ok) return accepted;
        const { actionId, expectedRevision } = accepted.value;
        return attempt(() => {
          const undone = engine.undoOoc({ campaignId, actionId, expectedRevision });
          sync();
          return undone;
        });
      },
    };
  };

  return Object.assign(sessionFor, { visualize: log.visualize });
};
