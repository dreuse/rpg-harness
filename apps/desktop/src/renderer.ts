import {
  GM_FAILURE_KINDS,
  type GmFailure,
  type GmFailureKind,
} from '../../../packages/client-protocol/src/gm-failure.ts';
import {
  createCommand,
  DEFAULT_ADVENTURE_NAME,
  genreLabel,
  INITIAL_DRAFT,
  nextDraft,
  OWN_RULES_FIELD,
  planCommand,
  rulesetLabel,
  SETTING_FILES_FIELD,
  type StartAction,
  type StartDraft,
  type StartVoices,
  startScreen,
  stepOf,
} from '../../../packages/client-protocol/src/guided-start.ts';
import { hasSearch, homeCards, relativeTime } from '../../../packages/client-protocol/src/home.ts';
import { parseOocInput } from '../../../packages/client-protocol/src/ooc.ts';
import {
  CAMPAIGN_HEALTHS,
  type CampaignPanels,
  type CampaignPlan,
  type CampaignSnapshot,
  type CampaignSummary,
  type ClientCommand,
  type EditSheetField,
  EVENT_COMMITTED,
  failure,
  PROTOCOL_VERSION,
  parseCommand,
  type Result,
  type SavedVoiceSettings,
  type SaveVoiceSettings,
  type StartOptions,
  type StoryMemoryView,
  type SubmitOocMessage,
  type SubmitPlayerAction,
  type ViewComponent,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import { resolveSlash, type SlashClient, slashText } from '../../../packages/client-protocol/src/slash-commands.ts';
import { storyFacts } from '../../../packages/client-protocol/src/story-memory-text.ts';
import { parseViewDescriptor } from '../../../packages/client-protocol/src/view-registry.ts';
import { VISUALIZATION_EVENT, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import { NARRATION, NARRATION_FAILED, type Ready } from '../../../packages/client-protocol/src/wire.ts';
import type { CampaignId, NoCheckReason } from '../../../packages/domain/src/campaign.ts';
import type { GmSettings } from '../../../packages/domain/src/gm.ts';
import type { OocProposal } from '../../../packages/domain/src/ooc.ts';
import { DEFAULT_RULES_USAGE, usesDice, usesSheet } from '../../../packages/domain/src/rules-usage.ts';
import { ATTRIBUTES, attributeModifier, D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { componentValue, DEFAULT_LOCALE, DEFAULT_PREFERENCES, translate, type UiPreferences } from './accessibility.ts';
import { effectiveMotion, parseVisualization, ROLL_HISTORY, rollPlan, signed } from './dice.ts';
import type { ImportRequest, ImportResult } from './preload.ts';

export const COMPACT_MAX_WIDTH = 720;
export const MEDIUM_MAX_WIDTH = 1200;
export const DESKTOP_VIEW_IDS = ['sheet'] as const;

const SHEET_VIEW = 'sheet';
const READY = 'Ready';
const NEWLINE = '\n';
type ConversationTurn = {
  readonly actionId: string;
  readonly input: string;
  readonly narration: string;
  readonly pending: boolean;
  readonly rollOfferId?: string | undefined;
  readonly noRoll?: NoCheckReason | undefined;
  readonly failure?: GmFailure | undefined;
};
const ROLL_PATTERN = /^\/roll$/i;
const DESKTOP_SLASH_CLIENT: SlashClient = 'desktop';
const PLAIN_ROLL = 'roll';
const SEGMENT_JOIN = ' ';
const CAMPAIGNS = 'Campaigns';
const SNAPSHOT = 'Snapshot';
const PANELS = 'Panels';
const VIEW = 'View';
const ACCEPTED = 'Accepted';
const REJECTED = 'Rejected';
const PLANNED = 'Planned';
const CREATED = 'Created';
const CHANGED = 'Changed';
const OOC_RESULT = 'OocResult';
const STORY_RESULT = 'StoryResult';
const DESKTOP_CLIENT = 'desktop';
const OPTIONS_REQUEST = planCommand(INITIAL_DRAFT);
const NO_REVISION = -1;
const IMPORT_UNAVAILABLE = { status: 'failed', lines: ['Importing is not available in this window.'] } as const;
const VOICE_SAVE_INPUT = 'voice settings';
const GM_SAVE_INPUT = 'GM settings';
const STALE_REVISION = 'StaleRevision';
export const UNGROUPED = '';
const LIST_CAMPAIGNS: ClientCommand = { version: PROTOCOL_VERSION, type: 'ListCampaigns' };

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
export type Connection = {
  readonly status: ConnectionStatus;
  readonly attempts: number;
  readonly lastError?: string;
  readonly engine?: Pick<Ready, 'pid' | 'gm'>;
};
export type StalledTurn = { readonly action: SubmitPlayerAction; readonly failure: GmFailure };
export type StreamedNarration = { readonly turnId: string; readonly text: string };
export type RejectedAction = { readonly actionId: string; readonly input: string; readonly message: string };
export type ImportState = {
  readonly status: 'needsPack' | 'preview' | 'installed' | 'declined' | 'failed' | 'ownFiles' | 'settingFiles';
  readonly lines: readonly string[];
};
export type StartState = {
  readonly open: boolean;
  readonly draft: StartDraft;
  readonly options?: StartOptions | undefined;
  readonly plan?: Result<CampaignPlan> | undefined;
  readonly created?: string | undefined;
  readonly import?: ImportState | undefined;
};
export type MemoryState = {
  readonly open: boolean;
  readonly view?: StoryMemoryView;
  readonly unavailable?: boolean;
  readonly error?: string;
};

export type OocProposalStatus = 'open' | 'applying' | 'applied' | 'declined';
export type OocProposalState = {
  readonly proposal: OocProposal;
  readonly status: OocProposalStatus;
  readonly error?: string;
};
export type OocExchange = {
  readonly id: string;
  readonly text: string;
  readonly asking: boolean;
  readonly reply?: string;
  readonly error?: string;
  readonly proposals: readonly OocProposalState[];
};
export type OocState = {
  readonly active: boolean;
  readonly exchanges: readonly OocExchange[];
  readonly undoable?: string | undefined;
};
export type HomeConfirm = {
  readonly kind: 'rename' | 'archive' | 'delete';
  readonly name: string;
  readonly archived?: boolean;
};
export type HomeState = {
  readonly query: string;
  readonly confirm?: HomeConfirm | undefined;
  readonly undo?: string | undefined;
  readonly error?: string | undefined;
};
const LOST_REPLY: GmFailure = { kind: 'lost' };

const stalledTurnOf = (state: DesktopState): StalledTurn | undefined => {
  if (state.stalled !== undefined) return state.stalled;
  const { snapshot } = state;
  const turn = snapshot?.turns.at(-1);
  if (snapshot === undefined || turn === undefined || turn.narration !== '') return undefined;
  if (state.outbox.some(({ campaignId }) => campaignId === state.selected)) return undefined;
  if (state.streaming?.turnId === turn.id) return undefined;
  const parsed = parseCommand({
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId: snapshot.campaignId,
    actionId: turn.actionId,
    expectedRevision: snapshot.revision,
    sceneId: turn.sceneId,
    actorId: turn.actorId,
    input: turn.input,
  });
  return parsed.ok ? { action: parsed.value as SubmitPlayerAction, failure: LOST_REPLY } : undefined;
};

export type DesktopState = {
  readonly connection: Connection;
  readonly campaigns: readonly CampaignSummary[];
  readonly archived: readonly CampaignSummary[];
  readonly home: HomeState;
  readonly selected?: CampaignId;
  readonly snapshot?: CampaignSnapshot;
  readonly panels?: CampaignPanels;
  readonly views: Readonly<Record<string, ViewDescriptor>>;
  readonly outbox: readonly SubmitPlayerAction[];
  readonly streaming?: StreamedNarration | undefined;
  readonly stalled?: StalledTurn | undefined;
  readonly rejected: readonly RejectedAction[];
  readonly start: StartState;
  readonly rolls: readonly VisualizationEvent[];
  readonly rolling: boolean;
  readonly rollsCollapsed: boolean;
  readonly rollBadgeFresh: boolean;
  readonly sheetChanged: readonly string[];
  readonly sheetErrors: Readonly<Record<string, string>>;
  readonly sheetEditing: boolean;
  readonly ooc: OocState;
  readonly memory: MemoryState;
};

export type Transport = {
  connect(): void;
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error: string) => void): void;
};

export const REGIONS = ['campaigns', 'status', 'conversation', 'sheet', 'character', 'panels'] as const;
export type Region = (typeof REGIONS)[number];
export const PLAY_REGIONS = ['conversation', 'sheet', 'character', 'panels'] as const satisfies readonly Region[];
export type Layout = { readonly name: 'compact' | 'medium' | 'wide'; readonly columns: readonly (readonly Region[])[] };
export { OPENING_ACTION_ID } from '../../../packages/domain/src/campaign.ts';

const SIDE_BY_SIDE: Layout['columns'] = [['conversation'], ['sheet', 'character', 'panels']];

export const layoutFor = (width: number, hidden: readonly Region[] = []): Layout => {
  const shown = (regions: readonly Region[]) => regions.filter((region) => !hidden.includes(region));
  const compact = !(width > COMPACT_MAX_WIDTH);
  const columns = (compact ? [PLAY_REGIONS] : SIDE_BY_SIDE).map(shown).filter((column) => column.length > 0);
  return { name: compact ? 'compact' : width <= MEDIUM_MAX_WIDTH ? 'medium' : 'wide', columns };
};

export const initialState: DesktopState = {
  connection: { status: 'connecting', attempts: 0 },
  campaigns: [],
  archived: [],
  home: { query: '' },
  views: {},
  outbox: [],
  rejected: [],
  start: { open: false, draft: INITIAL_DRAFT },
  rolls: [],
  rolling: false,
  rollsCollapsed: false,
  rollBadgeFresh: false,
  sheetChanged: [],
  sheetErrors: {},
  sheetEditing: false,
  ooc: { active: false, exchanges: [] },
  memory: { open: false },
};

const statusLabel = ({ status, attempts }: Connection, locale: string) =>
  translate(locale, `status.${status}`, { attempts });

const rulesLabel = ({ ruleset, genre }: CampaignSummary, locale: string) =>
  [ruleset && rulesetLabel(locale, ruleset), genre && genreLabel(locale, genre.id)]
    .filter((part): part is string => !!part)
    .join(', ');

const homeOf = ({ campaigns, archived, selected, home }: DesktopState, locale: string, now: number) => {
  const timed = (list: readonly CampaignSummary[], query?: string) =>
    homeCards(list, query).map((card) => {
      const source = list.find(({ name }) => name === card.name);
      return {
        ...card,
        rules: source === undefined ? '' : rulesLabel(source, locale),
        selected: source?.id === selected,
        when: relativeTime(card.lastPlayedAt, now, locale),
      };
    });
  return {
    cards: timed(campaigns, home.query),
    total: campaigns.length,
    search: hasSearch(campaigns),
    query: home.query,
    archived: timed(archived),
    confirm: home.confirm,
    undo: home.undo,
    error: home.error,
  };
};

export type SheetField = {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly value: ViewComponent['value'];
  readonly editable: boolean;
  readonly explanation?: string;
  readonly changed: boolean;
  readonly modifier?: string;
  readonly error?: string;
  readonly min?: number;
  readonly max?: number;
};
export type SheetInput = string | boolean;
type Bounds = Pick<SheetField, 'value' | 'min' | 'max'>;

type SheetParse =
  | { readonly ok: true; readonly value: ViewComponent['value'] }
  | { readonly ok: false; readonly error: string };

const failed = (locale: string, key: string, params?: Readonly<Record<string, unknown>>): SheetParse => ({
  ok: false,
  error: translate(locale, key, params),
});

const parseNumber = ({ min, max }: Bounds, raw: SheetInput, locale: string): SheetParse => {
  const text = String(raw);
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value)) return failed(locale, 'sheet.number');
  if (min !== undefined && value < min) return failed(locale, 'sheet.min', { min });
  if (max !== undefined && value > max) return failed(locale, 'sheet.max', { max });
  return { ok: true, value };
};

export const parseSheetValue = (field: Bounds, raw: SheetInput, locale: string): SheetParse => {
  if (typeof field.value === 'number') return parseNumber(field, raw, locale);
  return { ok: true, value: typeof field.value === 'boolean' ? raw === true : String(raw) };
};

const isAttribute = (id: string) => (ATTRIBUTES as readonly string[]).includes(id);

const hasD20Modifiers = ({ campaigns, selected }: DesktopState) =>
  campaigns.find(({ id }) => id === selected)?.ruleset?.id === D20_LITE_MANIFEST.id;

const modifierOf = ({ id, value }: ViewComponent, state: DesktopState) =>
  isAttribute(id) && Number.isInteger(value) && hasD20Modifiers(state)
    ? { modifier: signed(attributeModifier(value as number)) }
    : {};

export type SheetGroup = { readonly id: string; readonly fields: SheetField[] };

const sheetGroupsOf = (components: readonly ViewComponent[], state: DesktopState, locale: string) =>
  components.reduce<SheetGroup[]>((groups, component) => {
    const id = component.group ?? UNGROUPED;
    const error = state.sheetErrors[component.id];
    const field: SheetField = {
      id: component.id,
      name: component.label,
      text: componentValue(component, locale),
      value: component.value,
      editable: component.editable === true,
      ...(component.explanation === undefined ? {} : { explanation: component.explanation }),
      changed: state.sheetChanged.includes(component.id),
      ...modifierOf(component, state),
      ...(error === undefined ? {} : { error }),
      ...(component.min === undefined ? {} : { min: component.min }),
      ...(component.max === undefined ? {} : { max: component.max }),
    };
    const last = groups.at(-1);
    if (last?.id === id) last.fields.push(field);
    else groups.push({ id, fields: [field] });
    return groups;
  }, []);

const identityOf = (view: ViewDescriptor | undefined) => {
  const fieldValue = (id: string) => view?.components.find((component) => component.id === id)?.value;
  const name = fieldValue('name');
  const description = fieldValue('description');
  return typeof name === 'string'
    ? { name, description: typeof description === 'string' ? description : undefined }
    : undefined;
};

export const viewModel = (
  state: DesktopState,
  width: number,
  preferences: UiPreferences = DEFAULT_PREFERENCES,
  now = Date.now(),
  voices?: StartVoices,
) => {
  const committed = state.snapshot?.turns ?? [];
  const stalled = stalledTurnOf(state);
  const motion = effectiveMotion(preferences.motion, preferences.reducedMotion);
  const rules = state.snapshot?.rules ?? DEFAULT_RULES_USAGE;
  const dice = usesDice(rules);
  const sheet = usesSheet(rules);
  const pending = state.outbox.filter(
    ({ campaignId, actionId }) =>
      campaignId === state.selected && !committed.some((turn) => turn.actionId === actionId),
  );
  const characterCard = sheet ? undefined : identityOf(state.views[SHEET_VIEW]);
  const hidden: readonly Region[] = sheet
    ? ['character']
    : characterCard === undefined
      ? ['sheet', 'character']
      : ['sheet'];
  return {
    layout: layoutFor(width, hidden),
    uses: { dice, sheet },
    characterCard,
    status: {
      connection: state.connection.status,
      label: statusLabel(state.connection, preferences.locale),
      canRetry: state.connection.status === 'disconnected',
      queued: state.outbox.length,
    },
    diagnostics: {
      pid: state.connection.engine?.pid,
      gm: state.connection.engine?.gm,
      error: state.connection.lastError,
      attempts: state.connection.attempts,
    },
    title: { campaign: state.snapshot?.campaign.name, scene: state.snapshot?.currentScene?.title },
    scene: state.snapshot?.currentScene,
    character: state.snapshot?.characters[0]?.name,
    playing: state.selected !== undefined,
    home: homeOf(state, preferences.locale, now),
    conversation: [
      ...committed.map(({ actionId, input, narration, rollOfferId }) => ({
        actionId,
        input,
        narration,
        ...(rollOfferId === undefined ? {} : { rollOfferId }),
        pending: narration === '' && state.outbox.some((queued) => queued.actionId === actionId),
        ...(stalled?.action.actionId === actionId ? { failure: stalled.failure } : {}),
        ...(state.snapshot?.noRoll?.actionId === actionId ? { noRoll: state.snapshot.noRoll.reason } : {}),
      })),
      ...pending.map(({ actionId, input, rollOfferId }) => ({
        actionId,
        input,
        narration: '',
        pending: true,
        ...(rollOfferId === undefined ? {} : { rollOfferId }),
      })),
    ].map(
      (turn, index, turns): ConversationTurn =>
        index === turns.length - 1 &&
        turn.narration === '' &&
        state.streaming !== undefined &&
        state.outbox.some(({ actionId }) => actionId === turn.actionId)
          ? { ...turn, narration: state.streaming.text }
          : turn,
    ),
    rollOffer: pending.length === 0 ? state.snapshot?.rollOffer : undefined,
    sheet: state.views[SHEET_VIEW],
    sheetGroups: sheetGroupsOf(state.views[SHEET_VIEW]?.components ?? [], state, preferences.locale),
    sheetEditing: state.sheetEditing,
    rolls: dice ? state.rolls.map((roll, index) => rollPlan(roll, index === 0 && state.rolling ? motion : 'off')) : [],
    rollsCollapsed: state.rollsCollapsed,
    rollBadgeFresh: state.rollBadgeFresh,
    fontScale: preferences.fontScale,
    animate: motion === 'full',
    motion: preferences.motion,
    sound: preferences.sound,
    panels: state.panels,
    rejected: state.rejected,
    gm: state.snapshot?.gm,
    storyLanguage: state.snapshot?.language,
    start: state.start.open
      ? startScreen(state.start.draft, state.start.options, state.start.plan, preferences.locale, voices, true)
      : undefined,
    created: state.start.created,
    rulebookImport: state.start.import,
    ooc: state.ooc,
    memory: state.memory,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isResult = (value: unknown): value is Result<unknown> => isRecord(value) && typeof value.ok === 'boolean';
const sameCommand = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const textOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
const pinOf = <T>(value: unknown, field: string) =>
  isRecord(value) && typeof value.id === 'string' && typeof value[field] === 'string' ? (value as T) : null;

const summariesFrom = (value: unknown): CampaignSummary[] =>
  (Array.isArray(value) ? value : []).flatMap((item): CampaignSummary[] => {
    if (!isRecord(item) || typeof item.name !== 'string') return [];
    const id = textOrNull(item.id);
    const health = CAMPAIGN_HEALTHS.find((known) => known === item.health) ?? (id === null ? 'unreadable' : 'ok');
    const characters = Array.isArray(item.characters)
      ? item.characters.filter(
          (character): character is CampaignSummary['characters'][number] =>
            isRecord(character) && typeof character.id === 'string' && typeof character.name === 'string',
        )
      : [];
    return [
      {
        id,
        name: item.name,
        health,
        lastPlayedAt: textOrNull(item.lastPlayedAt),
        sceneTitle: textOrNull(item.sceneTitle),
        characters,
        ruleset: pinOf<CampaignSummary['ruleset']>(item.ruleset, 'edition'),
        genre: pinOf<CampaignSummary['genre']>(item.genre, 'version'),
        lastNarration: textOrNull(item.lastNarration),
        turnCount: typeof item.turnCount === 'number' ? item.turnCount : 0,
      },
    ];
  });

const changedIds = (before: ViewDescriptor | undefined, after: ViewDescriptor) =>
  after.components
    .filter(({ id, value }) => {
      const previous = before?.components.find((component) => component.id === id);
      return previous !== undefined && previous.value !== value;
    })
    .map(({ id }) => id);

const parseLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const message: unknown = JSON.parse(line);
    return isRecord(message) ? message : undefined;
  } catch {
    return undefined;
  }
};

export const createDesktopClient = ({
  transport,
  newActionId,
  startDraft = INITIAL_DRAFT,
  saveStart = () => {},
  locale = () => DEFAULT_LOCALE,
  voices = () => undefined,
  importRulebook: runImport,
}: {
  readonly transport: Transport;
  readonly newActionId: () => string;
  readonly startDraft?: StartDraft | undefined;
  readonly saveStart?: ((draft: StartDraft) => void) | undefined;
  readonly locale?: (() => string) | undefined;
  readonly voices?: (() => StartVoices | undefined) | undefined;
  readonly importRulebook?: ((request: ImportRequest) => Promise<ImportResult>) | undefined;
}) => {
  let state: DesktopState = { ...initialState, start: { open: startDraft.path !== null, draft: startDraft } };
  let resendOnSnapshot = false;
  const voiceSaves = new Map<unknown, SaveVoiceSettings>();
  const sheetEdits = new Map<unknown, string>();
  const gmSaves = new Set<unknown>();
  const oocPending = new Map<unknown, { readonly exchangeId: string; readonly index: number }>();
  let queuedEdits: (readonly [string, unknown])[] = [];
  const retried = new Set<unknown>();
  let staleSaves: SaveVoiceSettings[] = [];
  const listeners = new Set<(state: DesktopState) => void>();

  const update = (next: Partial<DesktopState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  };

  const connected = () => state.connection.status === 'connected';

  const disconnect = (error: string) => {
    voiceSaves.clear();
    sheetEdits.clear();
    gmSaves.clear();
    oocPending.clear();
    queuedEdits = [];
    retried.clear();
    staleSaves = [];
    update({ connection: { status: 'disconnected', attempts: state.connection.attempts, lastError: error } });
  };

  const send = (command: ClientCommand) => {
    if (!connected()) return;
    try {
      transport.send(JSON.stringify(command) + NEWLINE);
    } catch (error) {
      disconnect(error instanceof Error ? error.message : String(error));
    }
  };

  const refresh = () => {
    const campaignId = state.selected;
    if (campaignId === undefined) return;
    send({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
    for (const viewId of DESKTOP_VIEW_IDS) send({ version: PROTOCOL_VERSION, type: 'RequestView', campaignId, viewId });
  };

  const follow = () => {
    const campaignId = state.selected;
    if (campaignId !== undefined) send({ version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId });
    refresh();
  };

  const forSelected = (value: unknown): value is { campaignId: CampaignId; version: number } =>
    isRecord(value) && value.version === PROTOCOL_VERSION && value.campaignId === state.selected;

  const settleVoice = (actionId: unknown, message?: string, code?: unknown) => {
    const save = voiceSaves.get(actionId);
    if (save !== undefined && code === STALE_REVISION && !retried.has(actionId)) {
      retried.add(actionId);
      staleSaves = [...staleSaves, save];
      return refresh();
    }
    voiceSaves.delete(actionId);
    retried.delete(actionId);
    if (message !== undefined)
      update({ rejected: [...state.rejected, { actionId: String(actionId), input: VOICE_SAVE_INPUT, message }] });
    refresh();
  };

  const settleEdit = (actionId: unknown, fieldId: string, message?: string) => {
    sheetEdits.delete(actionId);
    const { [fieldId]: _cleared, ...sheetErrors } = state.sheetErrors;
    if (message === undefined) update({ sheetErrors });
    else {
      queuedEdits = [];
      update({ sheetErrors: { ...sheetErrors, [fieldId]: message }, sheetEditing: true });
    }
    if (message === undefined) refresh();
  };

  const settleGm = (actionId: unknown, message?: string) => {
    gmSaves.delete(actionId);
    if (message !== undefined)
      update({ rejected: [...state.rejected, { actionId: String(actionId), input: GM_SAVE_INPUT, message }] });
    refresh();
  };

  const saveGmCommand = (fieldsOf: (snapshot: CampaignSnapshot) => object): Result<ClientCommand> => {
    const { snapshot } = state;
    if (snapshot === undefined) return failure('Rejected', 'no campaign selected yet');
    const parsed = parseCommand({
      version: PROTOCOL_VERSION,
      campaignId: snapshot.campaignId,
      actionId: newActionId(),
      ...fieldsOf(snapshot),
    });
    if (!parsed.ok) return parsed;
    if ('actionId' in parsed.value) gmSaves.add(parsed.value.actionId);
    send(parsed.value);
    return parsed;
  };

  const settle = (actionId: unknown, message?: string, code?: unknown) => {
    if (voiceSaves.has(actionId)) return settleVoice(actionId, message, code);
    if (gmSaves.has(actionId)) return settleGm(actionId, message);
    const edited = sheetEdits.get(actionId);
    if (edited !== undefined) return settleEdit(actionId, edited, message);
    const action = state.outbox.find((queued) => queued.actionId === actionId);
    if (action === undefined) return;
    update({
      outbox: state.outbox.filter((queued) => queued !== action),
      streaming: undefined,
      rejected:
        message === undefined
          ? state.rejected
          : [...state.rejected, { actionId: action.actionId, input: action.input, message }],
    });
    if (message === undefined) refresh();
  };

  const inFlight = (turnId: string) => {
    const owner = state.snapshot?.turns.find(({ id }) => id === turnId)?.actionId;
    return state.outbox.some(
      ({ campaignId, actionId }) => campaignId === state.selected && (owner === undefined || owner === actionId),
    );
  };

  const onReady = (message: Record<string, unknown>) => {
    if (message.version !== PROTOCOL_VERSION)
      return disconnect(`unsupported engine protocol ${String(message.version)}`);
    const { pid, gm } = message as Ready;
    update({ connection: { status: 'connected', attempts: 0, engine: { pid, gm } } });
    resendOnSnapshot = true;
    send(LIST_CAMPAIGNS);
    if (state.start.open) {
      send(OPTIONS_REQUEST);
      planSummary();
    }
    follow();
  };

  const planSummary = () => {
    if (stepOf(state.start.draft) === 'summary') send(planCommand(state.start.draft, DESKTOP_CLIENT));
  };

  const requestOptions = () => {
    if (state.start.options === undefined) send(OPTIONS_REQUEST);
  };

  const onPlanned = (command: unknown, result: Result<unknown>) => {
    const options = result.ok ? (result.value as CampaignPlan).options : state.start.options;
    const current =
      stepOf(state.start.draft) === 'summary' && sameCommand(command, planCommand(state.start.draft, DESKTOP_CLIENT));
    update({ start: { ...state.start, options, ...(current ? { plan: result as Result<CampaignPlan> } : {}) } });
  };

  const importWith = async (request: ImportRequest) => {
    const result = await (runImport?.(request) ?? Promise.resolve<ImportResult>(IMPORT_UNAVAILABLE)).catch(
      (error): ImportResult => ({ status: 'failed', lines: [error instanceof Error ? error.message : String(error)] }),
    );
    if (result.status === 'cancelled') return update({ start: { ...state.start, import: undefined } });
    update({ start: { ...state.start, import: { status: result.status, lines: result.lines } } });
    if (result.status === 'installed') send(OPTIONS_REQUEST);
    return result;
  };

  const startAction = (action: StartAction) => {
    const { draft, plan } = state.start;
    if (action.kind === 'start') {
      if (plan?.ok) send(createCommand(draft, DESKTOP_CLIENT, locale()));
      return;
    }
    const next = nextDraft(draft, action);
    const replan =
      plan?.ok !== true || !sameCommand(planCommand(next, DESKTOP_CLIENT), planCommand(draft, DESKTOP_CLIENT));
    update({
      start: {
        ...state.start,
        open: true,
        draft: next,
        plan: replan ? undefined : plan,
        created: undefined,
        import: undefined,
      },
    });
    saveStart(next);
    requestOptions();
    if (replan) planSummary();
  };

  const onCreated = (result: Result<unknown>) => {
    if (!result.ok) return update({ start: { ...state.start, plan: result } });
    saveStart(INITIAL_DRAFT);
    const name = isRecord(result.value) ? String(result.value.name) : DEFAULT_ADVENTURE_NAME;
    update({ start: { open: false, draft: INITIAL_DRAFT, options: state.start.options, created: name } });
    send(LIST_CAMPAIGNS);
  };

  const select = (campaignId: CampaignId) => {
    const { snapshot, panels, streaming, stalled, ...rest } = state;
    queuedEdits = [];
    state = {
      ...rest,
      selected: campaignId,
      views: {},
      rolls: [],
      rolling: false,
      rollsCollapsed: false,
      rollBadgeFresh: false,
      sheetChanged: [],
      sheetErrors: {},
      sheetEditing: false,
      ooc: initialState.ooc,
      memory: initialState.memory,
    };
    update({});
    follow();
  };

  const onChanged = (command: unknown, result: Result<unknown>) => {
    if (!isRecord(command)) return;
    if (!result.ok) return update({ home: { ...state.home, error: result.error.message } });
    if (command.type === 'OpenCampaign' && isRecord(result.value) && typeof result.value.id === 'string')
      select(result.value.id);
    const undo = command.type === 'ArchiveCampaign' ? (textOrNull(command.name) ?? undefined) : undefined;
    update({ home: { ...state.home, error: undefined, undo } });
    send(LIST_CAMPAIGNS);
  };

  const renameCampaign = (name: string, newName: string) =>
    send({ version: PROTOCOL_VERSION, type: 'RenameCampaign', name, newName });

  const sendNamed = (type: 'OpenCampaign' | 'ArchiveCampaign' | 'UnarchiveCampaign', name: string) =>
    send({ version: PROTOCOL_VERSION, type, name });

  const onSnapshot = (snapshot: CampaignSnapshot) => {
    const outbox = state.outbox.map((action) =>
      action.campaignId === snapshot.campaignId && action.expectedRevision < snapshot.revision
        ? Object.freeze({ ...action, expectedRevision: snapshot.revision })
        : action,
    );
    update({ snapshot, outbox });
    sendQueuedEdit();
    const stale = staleSaves;
    staleSaves = [];
    for (const save of stale) {
      const retry = Object.freeze({ ...save, expectedRevision: snapshot.revision });
      voiceSaves.set(retry.actionId, retry);
      send(retry);
    }
    if (!resendOnSnapshot) return;
    resendOnSnapshot = false;
    for (const action of outbox) send(action);
  };

  const receive = (line: string) => {
    const message = parseLine(line);
    if (message === undefined) return;
    if (message.type === READY) return onReady(message);
    if (!connected()) return;
    if (message.type === CAMPAIGNS && Array.isArray(message.campaigns))
      return update({ campaigns: summariesFrom(message.campaigns), archived: summariesFrom(message.archived) });
    if (message.type === SNAPSHOT && forSelected(message.snapshot))
      return onSnapshot(message.snapshot as CampaignSnapshot);
    if (message.type === PANELS && forSelected(message.panels))
      return update({ panels: message.panels as CampaignPanels });
    if (message.type === VIEW) {
      if (message.campaignId !== state.selected) return;
      const view = parseViewDescriptor(message.view);
      if (!view.ok) return;
      const sheetChanged =
        view.value.viewId === SHEET_VIEW ? changedIds(state.views[SHEET_VIEW], view.value) : state.sheetChanged;
      return update({ views: { ...state.views, [view.value.viewId]: view.value }, sheetChanged });
    }
    if (message.type === NARRATION && typeof message.turnId === 'string' && typeof message.text === 'string') {
      const { turnId, text } = message;
      if (!inFlight(turnId)) return;
      const heard = state.streaming?.turnId === turnId ? `${state.streaming.text}${SEGMENT_JOIN}` : '';
      return update({ streaming: { turnId, text: `${heard}${text}` } });
    }
    if (message.type === NARRATION_FAILED && isRecord(message.failure)) {
      const action = state.outbox.find((queued) => queued.actionId === message.actionId);
      const { kind, detail } = message.failure;
      if (action === undefined || !GM_FAILURE_KINDS.includes(kind as GmFailureKind)) return;
      const failure: GmFailure =
        typeof detail === 'string' ? { kind: kind as GmFailureKind, detail } : { kind: kind as GmFailureKind };
      update({ stalled: { action, failure } });
      return;
    }
    if (message.type === VISUALIZATION_EVENT) {
      const roll = parseVisualization(message);
      if (roll === undefined) return;
      const rolls = [roll, ...state.rolls.filter(({ resultId }) => resultId !== roll.resultId)].slice(0, ROLL_HISTORY);
      const linked = state.snapshot?.turns.some(({ actionId }) => actionId === roll.actionId) === true;
      return update({
        rolls,
        rolling: roll.replayed !== true,
        ...(linked ? {} : { rollsCollapsed: false, rollBadgeFresh: false }),
      });
    }
    if (message.type === PLANNED && isResult(message.result)) return onPlanned(message.command, message.result);
    if (message.type === CREATED && isResult(message.result)) return onCreated(message.result);
    if (message.type === CHANGED && isResult(message.result)) return onChanged(message.command, message.result);
    if (message.type === OOC_RESULT) return onOocResult(message);
    if (message.type === STORY_RESULT) return onStoryResult(message);
    if (message.type === ACCEPTED) return settle(message.actionId);
    if (message.type === REJECTED) {
      const error = isRecord(message.error) ? String(message.error.message) : String(message.error);
      return settle(message.actionId, error, isRecord(message.error) ? message.error.code : undefined);
    }
    if (
      message.type === EVENT_COMMITTED &&
      isRecord(message.event) &&
      message.event.campaignId === state.selected &&
      typeof message.revision === 'number' &&
      message.revision > (state.snapshot?.revision ?? NO_REVISION)
    )
      refresh();
  };

  const editSheet = (fieldId: string, value: unknown): Result<EditSheetField> => {
    const { snapshot } = state;
    const actorId = snapshot?.characters[0]?.id;
    if (snapshot === undefined || actorId === undefined) return failure('Rejected', 'no character to edit yet');
    const parsed = parseCommand({
      version: PROTOCOL_VERSION,
      type: 'EditSheetField',
      campaignId: snapshot.campaignId,
      actionId: newActionId(),
      expectedRevision: snapshot.revision,
      actorId,
      fieldId,
      value,
    });
    if (!parsed.ok) return parsed;
    const edit = parsed.value as EditSheetField;
    sheetEdits.set(edit.actionId, fieldId);
    send(edit);
    return { ok: true, value: edit };
  };

  const sendQueuedEdit = () => {
    const next = queuedEdits[0];
    if (next === undefined || sheetEdits.size > 0) return;
    queuedEdits = queuedEdits.slice(1);
    editSheet(...next);
  };

  transport.onLine(receive);
  transport.onClose(disconnect);
  transport.connect();

  const changeExchange = (
    exchangeId: string,
    change: (exchange: OocExchange) => OocExchange,
    undoable: string | undefined = state.ooc.undoable,
  ) =>
    update({
      ooc: {
        ...state.ooc,
        undoable,
        exchanges: state.ooc.exchanges.map((exchange) => (exchange.id === exchangeId ? change(exchange) : exchange)),
      },
    });

  const setProposal = (exchange: OocExchange, index: number, next: Partial<OocProposalState>): OocExchange => ({
    ...exchange,
    proposals: exchange.proposals.map((entry, position) => (position === index ? { ...entry, ...next } : entry)),
  });

  const onOocResult = (message: Record<string, unknown>) => {
    const { command, actionId, result } = message;
    if (!isResult(result)) return;
    const failed = result.ok ? undefined : result.error.message;
    if (command === 'SubmitOocMessage') {
      const reply = result.ok && isRecord(result.value) ? result.value : undefined;
      const proposals = Array.isArray(reply?.proposals) ? (reply.proposals as OocProposal[]) : [];
      return changeExchange(String(actionId), (exchange) => ({
        ...exchange,
        asking: false,
        ...(typeof reply?.reply === 'string' ? { reply: reply.reply } : {}),
        ...(failed === undefined ? {} : { error: failed }),
        proposals: proposals.map((proposal) => ({ proposal, status: 'open' as const })),
      }));
    }
    if (command === 'UndoOocChange') {
      update({ ooc: { ...state.ooc, undoable: undefined } });
      return refresh();
    }
    const pending = oocPending.get(actionId);
    oocPending.delete(actionId);
    if (pending === undefined) return;
    const summary = result.ok && isRecord(result.value) ? String(result.value.summary) : undefined;
    changeExchange(
      pending.exchangeId,
      (exchange) =>
        setProposal(
          exchange,
          pending.index,
          failed === undefined ? { status: 'applied' } : { status: 'open', error: failed },
        ),
      summary ?? state.ooc.undoable,
    );
    if (failed === undefined) refresh();
  };

  const askMemory = () => {
    const { snapshot } = state;
    if (snapshot === undefined) return;
    send({ version: PROTOCOL_VERSION, type: 'GetStoryMemory', campaignId: snapshot.campaignId });
  };

  const onStoryResult = ({ command, result }: Record<string, unknown>) => {
    if (!isResult(result)) return;
    if (command === 'GetStoryMemory')
      return update({
        memory: result.ok
          ? { open: state.memory.open, view: result.value as StoryMemoryView }
          : { open: state.memory.open, unavailable: true },
      });
    if (!result.ok)
      return update({
        memory: {
          ...state.memory,
          error: result.error.message,
        },
      });
    update({ memory: { open: state.memory.open, ...(state.memory.view ? { view: state.memory.view } : {}) } });
    askMemory();
    refresh();
  };

  const correctFact = (index: number, value: string) => {
    const { snapshot, memory } = state;
    const fact = memory.view === undefined ? undefined : storyFacts(memory.view.memory)[index];
    const actorId = snapshot?.characters[0]?.id;
    if (snapshot === undefined || memory.view === undefined || fact === undefined || actorId === undefined) return;
    update({ memory: { open: memory.open, view: memory.view } });
    send({
      version: PROTOCOL_VERSION,
      type: 'CorrectStoryFact',
      campaignId: snapshot.campaignId,
      actionId: newActionId(),
      expectedRevision: memory.view.revision,
      actorId,
      entityId: fact.entityId,
      kind: fact.kind,
      key: fact.key,
      value,
    });
  };

  const talkToGm = (input: string): Result<SubmitOocMessage> => {
    const { snapshot } = state;
    const text = (parseOocInput(input) ?? input).trim();
    if (snapshot === undefined) return failure('Rejected', 'no campaign selected yet');
    const parsed = parseCommand({
      version: PROTOCOL_VERSION,
      type: 'SubmitOocMessage',
      campaignId: snapshot.campaignId,
      actionId: newActionId(),
      text,
    });
    if (!parsed.ok) return parsed;
    const message = parsed.value as SubmitOocMessage;
    update({
      ooc: {
        ...state.ooc,
        exchanges: [...state.ooc.exchanges, { id: message.actionId, text, asking: true, proposals: [] }],
      },
    });
    send(message);
    return { ok: true, value: message };
  };

  const confirmOoc = (exchangeId: string, index: number) => {
    const { snapshot } = state;
    const entry = state.ooc.exchanges.find(({ id }) => id === exchangeId)?.proposals[index];
    if (snapshot === undefined || entry?.status !== 'open') return;
    const actionId = newActionId();
    oocPending.set(actionId, { exchangeId, index });
    changeExchange(exchangeId, (exchange) => setProposal(exchange, index, { status: 'applying' }));
    send({
      version: PROTOCOL_VERSION,
      type: 'ConfirmOocProposal',
      campaignId: snapshot.campaignId,
      actionId,
      expectedRevision: snapshot.revision,
      proposal: entry.proposal as unknown as Record<string, unknown>,
    });
  };

  const submitAction = (
    input: string,
    rollOfferId?: string,
    reportedRoll?: readonly number[],
  ): Result<SubmitPlayerAction> => {
    const { snapshot } = state;
    const sceneId = snapshot?.currentScene?.id;
    const actorId = snapshot?.characters[0]?.id;
    if (snapshot === undefined || sceneId === undefined || actorId === undefined)
      return failure('Rejected', 'no scene or character to act in yet');
    const parsed = parseCommand({
      version: PROTOCOL_VERSION,
      type: 'SubmitPlayerAction',
      campaignId: snapshot.campaignId,
      actionId: newActionId(),
      expectedRevision: snapshot.revision,
      sceneId,
      actorId,
      input,
      ...(rollOfferId === undefined ? {} : { rollOfferId }),
      ...(reportedRoll === undefined ? {} : { reportedRoll }),
    });
    if (!parsed.ok) return parsed;
    const action = parsed.value as SubmitPlayerAction;
    update({ outbox: [...state.outbox, action], streaming: undefined, stalled: undefined });
    if (!resendOnSnapshot) send(action);
    return { ok: true, value: action };
  };

  const retryNarration = () => {
    const stalled = stalledTurnOf(state);
    if (stalled === undefined) return;
    update({ outbox: [...state.outbox, stalled.action], streaming: undefined, stalled: undefined });
    if (!resendOnSnapshot) send(stalled.action);
  };

  const rollNow = () => {
    const offer = state.snapshot?.rollOffer;
    return offer === undefined ? submitAction(PLAIN_ROLL) : submitAction(offer.label, offer.offerId);
  };

  return {
    state: () => state,
    subscribe: (listener: (state: DesktopState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select,
    goHome: () => {
      const { selected, snapshot, panels, streaming, ...rest } = state;
      queuedEdits = [];
      state = {
        ...rest,
        views: {},
        rolls: [],
        rolling: false,
        rollsCollapsed: false,
        rollBadgeFresh: false,
        sheetChanged: [],
        sheetErrors: {},
        sheetEditing: false,
        ooc: initialState.ooc,
        memory: initialState.memory,
      };
      update({});
      send(LIST_CAMPAIGNS);
    },
    settle: () => update({ rolling: false, sheetChanged: [] }),
    collapseRolls: () => update({ rollsCollapsed: true, rollBadgeFresh: true }),
    reopenRolls: () => update({ rollsCollapsed: false, rollBadgeFresh: false }),
    settleBadge: () => update({ rollBadgeFresh: false }),
    continueCampaign: (name: string) => {
      update({ home: { ...state.home, confirm: undefined, error: undefined } });
      sendNamed('OpenCampaign', name);
    },
    askHome: (kind: HomeConfirm['kind'], name: string, archived = false) =>
      update({
        home: { ...state.home, confirm: archived ? { kind, name, archived } : { kind, name }, error: undefined },
      }),
    cancelHome: () => update({ home: { ...state.home, confirm: undefined } }),
    confirmHome: () => {
      const { confirm } = state.home;
      if (confirm === undefined) return;
      update({ home: { ...state.home, confirm: undefined } });
      if (confirm.kind === 'rename') return;
      if (confirm.kind === 'archive') return sendNamed('ArchiveCampaign', confirm.name);
      send({
        version: PROTOCOL_VERSION,
        type: 'DeleteCampaign',
        name: confirm.name,
        confirm: confirm.name,
        ...(confirm.archived ? { archived: true } : {}),
      });
    },
    undoArchive: () => {
      const { undo } = state.home;
      if (undo === undefined) return;
      update({ home: { ...state.home, undo: undefined } });
      sendNamed('UnarchiveCampaign', undo);
    },
    unarchive: (name: string) => sendNamed('UnarchiveCampaign', name),
    rename: renameCampaign,
    search: (query: string) => update({ home: { ...state.home, query } }),
    acceptRoll: (): Result<SubmitPlayerAction> => {
      const offer = state.snapshot?.rollOffer;
      return offer === undefined
        ? failure('Rejected', 'no roll is offered right now')
        : submitAction(offer.label, offer.offerId);
    },
    reportRoll: (total: number): Result<SubmitPlayerAction> => {
      const offer = state.snapshot?.rollOffer;
      return offer?.expression === undefined
        ? failure('Rejected', 'no physical roll is offered right now')
        : submitAction(offer.label, offer.offerId, [total]);
    },
    retryNarration,
    submit: (input: string): Result<SubmitPlayerAction | SubmitOocMessage> => {
      if (state.ooc.active || parseOocInput(input) !== undefined) return talkToGm(input);
      const slash = resolveSlash(locale(), DESKTOP_SLASH_CLIENT, input);
      if (slash.kind === 'unknown')
        return failure('Rejected', slashText(locale(), 'slash.unknown', { name: slash.name }));
      return ROLL_PATTERN.test(input.trim()) ? rollNow() : submitAction(input);
    },
    toggleOoc: () => update({ ooc: { ...state.ooc, active: !state.ooc.active } }),
    toggleMemory: () => {
      const open = !state.memory.open;
      update({ memory: { open, ...(state.memory.view ? { view: state.memory.view } : {}) } });
      if (open) askMemory();
    },
    correctFact,
    confirmOoc,
    declineOoc: (exchangeId: string, index: number) =>
      changeExchange(exchangeId, (exchange) => setProposal(exchange, index, { status: 'declined' })),
    undoOoc: () => {
      const { snapshot } = state;
      if (snapshot === undefined || state.ooc.undoable === undefined) return;
      send({
        version: PROTOCOL_VERSION,
        type: 'UndoOocChange',
        campaignId: snapshot.campaignId,
        actionId: newActionId(),
        expectedRevision: snapshot.revision,
      });
    },
    startScreen: () => startScreen(state.start.draft, state.start.options, state.start.plan, locale(), voices(), true),
    openStart: () => {
      update({ start: { ...state.start, open: true, created: undefined } });
      requestOptions();
    },
    importRulebook: async () => {
      const ruleset = state.start.draft.choices.ruleset;
      if (!isRecord(ruleset) || typeof ruleset.id !== 'string')
        return update({ start: { ...state.start, import: { status: 'needsPack', lines: [] } } });
      await importWith({ kind: 'pick', packId: ruleset.id });
    },
    decideImport: (decision: 'activate' | 'decline') => importWith({ kind: 'decide', decision }),
    importOwnRules: async () => {
      const result = await importWith({ kind: 'pickOwn' });
      if (result?.status === 'ownFiles') startAction({ kind: 'set', field: OWN_RULES_FIELD, value: result.names });
    },
    importSettingFiles: async () => {
      const result = await importWith({ kind: 'pickSetting' });
      if (result?.status === 'settingFiles')
        startAction({ kind: 'set', field: SETTING_FILES_FIELD, value: result.names });
    },
    closeStart: () => update({ start: { ...state.start, open: false } }),
    startAction,
    editSheet,
    openSheetEdit: () => update({ sheetEditing: true }),
    cancelSheetEdit: () => update({ sheetEditing: false, sheetErrors: {} }),
    saveSheet: (values: Readonly<Record<string, SheetInput>>, locale: string = DEFAULT_PREFERENCES.locale) => {
      const fields = sheetGroupsOf(state.views[SHEET_VIEW]?.components ?? [], state, locale).flatMap(
        ({ fields }) => fields,
      );
      const checked = fields.flatMap((field) => {
        const raw = values[field.id];
        return field.editable && raw !== undefined ? [{ field, parsed: parseSheetValue(field, raw, locale) }] : [];
      });
      const sheetErrors = Object.fromEntries(
        checked.flatMap(({ field, parsed }) => (parsed.ok ? [] : [[field.id, parsed.error]])),
      );
      if (Object.keys(sheetErrors).length > 0) return update({ sheetErrors });
      update({ sheetEditing: false, sheetErrors: {} });
      queuedEdits = checked.flatMap(({ field, parsed }) =>
        parsed.ok && parsed.value !== field.value ? [[field.id, parsed.value] as const] : [],
      );
      sendQueuedEdit();
    },
    voicePending: () => voiceSaves.size > 0,
    saveVoice: (settings: SavedVoiceSettings): Result<SaveVoiceSettings> => {
      const { snapshot } = state;
      if (snapshot === undefined) return failure('Rejected', 'no campaign selected yet');
      const parsed = parseCommand({
        version: PROTOCOL_VERSION,
        type: 'SaveVoiceSettings',
        campaignId: snapshot.campaignId,
        actionId: newActionId(),
        expectedRevision: snapshot.revision,
        ...settings,
      });
      if (!parsed.ok) return parsed;
      const save = parsed.value as SaveVoiceSettings;
      voiceSaves.set(save.actionId, save);
      send(save);
      return { ok: true, value: save };
    },
    saveGm: (settings: GmSettings) =>
      saveGmCommand((snapshot) => ({ type: 'SaveGmSettings', expectedRevision: snapshot.revision, ...settings })),
    setStoryLanguage: (language: string) =>
      saveGmCommand((snapshot) => ({
        type: 'SetCampaignLanguage',
        expectedRevision: snapshot.revision,
        language,
      })),
    saveGmDefaults: (settings: GmSettings) => saveGmCommand(() => ({ type: 'SaveGmDefaults', ...settings })),
    retry: () => {
      if (state.connection.status !== 'disconnected') return;
      update({ connection: { status: 'reconnecting', attempts: state.connection.attempts + 1 } });
      transport.connect();
    },
  };
};
