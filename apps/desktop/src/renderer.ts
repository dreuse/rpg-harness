import {
  createCommand,
  DEFAULT_ADVENTURE_NAME,
  INITIAL_DRAFT,
  nextDraft,
  planCommand,
  type StartAction,
  type StartDraft,
  startScreen,
  stepOf,
} from '../../../packages/client-protocol/src/guided-start.ts';
import { hasSearch, homeCards, relativeTime } from '../../../packages/client-protocol/src/home.ts';
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
  type SubmitPlayerAction,
  type ViewComponent,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import { parseViewDescriptor } from '../../../packages/client-protocol/src/view-registry.ts';
import { VISUALIZATION_EVENT, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import type { Ready } from '../../../packages/client-protocol/src/wire.ts';
import type { CampaignId } from '../../../packages/domain/src/campaign.ts';
import { componentValue, DEFAULT_PREFERENCES, translate, type UiPreferences } from './accessibility.ts';
import { effectiveMotion, parseVisualization, ROLL_HISTORY, rollPlan } from './dice.ts';

export const COMPACT_MAX_WIDTH = 720;
export const MEDIUM_MAX_WIDTH = 1200;
export const DESKTOP_VIEW_IDS = ['sheet'] as const;

const SHEET_VIEW = 'sheet';
const READY = 'Ready';
const NEWLINE = '\n';
const CAMPAIGNS = 'Campaigns';
const SNAPSHOT = 'Snapshot';
const PANELS = 'Panels';
const VIEW = 'View';
const ACCEPTED = 'Accepted';
const REJECTED = 'Rejected';
const PLANNED = 'Planned';
const CREATED = 'Created';
const CHANGED = 'Changed';
const DESKTOP_CLIENT = 'desktop';
const OPTIONS_REQUEST = planCommand(INITIAL_DRAFT);
const NO_REVISION = -1;
const VOICE_SAVE_INPUT = 'voice settings';
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
export type RejectedAction = { readonly actionId: string; readonly input: string; readonly message: string };
export type StartState = {
  readonly open: boolean;
  readonly draft: StartDraft;
  readonly options?: StartOptions | undefined;
  readonly plan?: Result<CampaignPlan> | undefined;
  readonly created?: string | undefined;
};
export type HomeConfirm = { readonly kind: 'archive' | 'delete'; readonly name: string; readonly archived?: boolean };
export type HomeState = {
  readonly query: string;
  readonly confirm?: HomeConfirm | undefined;
  readonly undo?: string | undefined;
  readonly error?: string | undefined;
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
  readonly rejected: readonly RejectedAction[];
  readonly start: StartState;
  readonly rolls: readonly VisualizationEvent[];
  readonly rolling: boolean;
  readonly sheetChanged: readonly string[];
  readonly sheetErrors: Readonly<Record<string, string>>;
  readonly sheetEditing: boolean;
};

export type Transport = {
  connect(): void;
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error: string) => void): void;
};

export const REGIONS = ['campaigns', 'status', 'conversation', 'sheet', 'panels'] as const;
export type Region = (typeof REGIONS)[number];
export const PLAY_REGIONS = ['conversation', 'sheet', 'panels'] as const satisfies readonly Region[];
export type Layout = { readonly name: 'compact' | 'medium' | 'wide'; readonly columns: readonly (readonly Region[])[] };
export { OPENING_ACTION_ID } from '../../../packages/domain/src/campaign.ts';

const SIDE_BY_SIDE: Layout['columns'] = [['conversation'], ['sheet', 'panels']];

export const layoutFor = (width: number): Layout => {
  if (!(width > COMPACT_MAX_WIDTH)) return { name: 'compact', columns: [PLAY_REGIONS] };
  return { name: width <= MEDIUM_MAX_WIDTH ? 'medium' : 'wide', columns: SIDE_BY_SIDE };
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
  sheetChanged: [],
  sheetErrors: {},
  sheetEditing: false,
};

const statusLabel = ({ status, attempts }: Connection, locale: string) =>
  translate(locale, `status.${status}`, { attempts });

const homeOf = ({ campaigns, archived, selected, home }: DesktopState, locale: string, now: number) => {
  const timed = (list: readonly CampaignSummary[], query?: string) =>
    homeCards(list, query).map((card) => ({
      ...card,
      selected: list.find(({ name }) => name === card.name)?.id === selected,
      when: relativeTime(card.lastPlayedAt, now, locale),
    }));
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

export type SheetGroup = { readonly id: string; readonly fields: SheetField[] };

const sheetGroupsOf = (
  components: readonly ViewComponent[],
  { sheetChanged, sheetErrors }: DesktopState,
  locale: string,
) =>
  components.reduce<SheetGroup[]>((groups, component) => {
    const id = component.group ?? UNGROUPED;
    const error = sheetErrors[component.id];
    const field: SheetField = {
      id: component.id,
      name: component.label,
      text: componentValue(component, locale),
      value: component.value,
      editable: component.editable === true,
      ...(component.explanation === undefined ? {} : { explanation: component.explanation }),
      changed: sheetChanged.includes(component.id),
      ...(error === undefined ? {} : { error }),
      ...(component.min === undefined ? {} : { min: component.min }),
      ...(component.max === undefined ? {} : { max: component.max }),
    };
    const last = groups.at(-1);
    if (last?.id === id) last.fields.push(field);
    else groups.push({ id, fields: [field] });
    return groups;
  }, []);

export const viewModel = (
  state: DesktopState,
  width: number,
  preferences: UiPreferences = DEFAULT_PREFERENCES,
  now = Date.now(),
) => {
  const committed = state.snapshot?.turns ?? [];
  const motion = effectiveMotion(preferences.motion, preferences.reducedMotion);
  const pending = state.outbox.filter(
    ({ campaignId, actionId }) =>
      campaignId === state.selected && !committed.some((turn) => turn.actionId === actionId),
  );
  return {
    layout: layoutFor(width),
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
    character: state.snapshot?.characters[0]?.name,
    playing: state.selected !== undefined,
    home: homeOf(state, preferences.locale, now),
    conversation: [
      ...committed.map(({ actionId, input, narration }) => ({ actionId, input, narration, pending: false })),
      ...pending.map(({ actionId, input }) => ({ actionId, input, narration: '', pending: true })),
    ],
    sheet: state.views[SHEET_VIEW],
    sheetGroups: sheetGroupsOf(state.views[SHEET_VIEW]?.components ?? [], state, preferences.locale),
    sheetEditing: state.sheetEditing,
    rolls: state.rolls.map((roll, index) => rollPlan(roll, index === 0 && state.rolling ? motion : 'off')),
    fontScale: preferences.fontScale,
    animate: motion === 'full',
    motion: preferences.motion,
    panels: state.panels,
    rejected: state.rejected,
    start: state.start.open ? startScreen(state.start.draft, state.start.options, state.start.plan) : undefined,
    created: state.start.created,
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
}: {
  readonly transport: Transport;
  readonly newActionId: () => string;
  readonly startDraft?: StartDraft | undefined;
  readonly saveStart?: ((draft: StartDraft) => void) | undefined;
}) => {
  let state: DesktopState = { ...initialState, start: { open: startDraft.path !== null, draft: startDraft } };
  let resendOnSnapshot = false;
  const voiceSaves = new Map<unknown, SaveVoiceSettings>();
  const sheetEdits = new Map<unknown, string>();
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

  const settle = (actionId: unknown, message?: string, code?: unknown) => {
    if (voiceSaves.has(actionId)) return settleVoice(actionId, message, code);
    const edited = sheetEdits.get(actionId);
    if (edited !== undefined) return settleEdit(actionId, edited, message);
    const action = state.outbox.find((queued) => queued.actionId === actionId);
    if (action === undefined) return;
    update({
      outbox: state.outbox.filter((queued) => queued !== action),
      rejected:
        message === undefined
          ? state.rejected
          : [...state.rejected, { actionId: action.actionId, input: action.input, message }],
    });
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

  const onCreated = (result: Result<unknown>) => {
    if (!result.ok) return update({ start: { ...state.start, plan: result } });
    saveStart(INITIAL_DRAFT);
    const name = isRecord(result.value) ? String(result.value.name) : DEFAULT_ADVENTURE_NAME;
    update({ start: { open: false, draft: INITIAL_DRAFT, options: state.start.options, created: name } });
    send(LIST_CAMPAIGNS);
  };

  const select = (campaignId: CampaignId) => {
    const { snapshot, panels, ...rest } = state;
    queuedEdits = [];
    state = {
      ...rest,
      selected: campaignId,
      views: {},
      rolls: [],
      rolling: false,
      sheetChanged: [],
      sheetErrors: {},
      sheetEditing: false,
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
    if (message.type === VISUALIZATION_EVENT) {
      const roll = parseVisualization(message);
      if (roll === undefined) return;
      const rolls = [roll, ...state.rolls.filter(({ resultId }) => resultId !== roll.resultId)].slice(0, ROLL_HISTORY);
      return update({ rolls, rolling: roll.replayed !== true });
    }
    if (message.type === PLANNED && isResult(message.result)) return onPlanned(message.command, message.result);
    if (message.type === CREATED && isResult(message.result)) return onCreated(message.result);
    if (message.type === CHANGED && isResult(message.result)) return onChanged(message.command, message.result);
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

  return {
    state: () => state,
    subscribe: (listener: (state: DesktopState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select,
    goHome: () => {
      const { selected, snapshot, panels, ...rest } = state;
      queuedEdits = [];
      state = { ...rest, views: {}, rolls: [], rolling: false, sheetChanged: [], sheetErrors: {}, sheetEditing: false };
      update({});
      send(LIST_CAMPAIGNS);
    },
    settle: () => update({ rolling: false, sheetChanged: [] }),
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
    search: (query: string) => update({ home: { ...state.home, query } }),
    submit: (input: string): Result<SubmitPlayerAction> => {
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
      });
      if (!parsed.ok) return parsed;
      const action = parsed.value as SubmitPlayerAction;
      update({ outbox: [...state.outbox, action] });
      if (!resendOnSnapshot) send(action);
      return { ok: true, value: action };
    },
    startScreen: () => startScreen(state.start.draft, state.start.options, state.start.plan),
    openStart: () => {
      update({ start: { ...state.start, open: true, created: undefined } });
      requestOptions();
    },
    closeStart: () => update({ start: { ...state.start, open: false } }),
    startAction: (action: StartAction) => {
      const { draft, plan } = state.start;
      if (action.kind === 'start') {
        if (plan?.ok) send(createCommand(draft, DESKTOP_CLIENT));
        return;
      }
      const next = nextDraft(draft, action);
      const replan =
        plan?.ok !== true || !sameCommand(planCommand(next, DESKTOP_CLIENT), planCommand(draft, DESKTOP_CLIENT));
      update({
        start: { ...state.start, open: true, draft: next, plan: replan ? undefined : plan, created: undefined },
      });
      saveStart(next);
      requestOptions();
      if (replan) planSummary();
    },
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
    retry: () => {
      if (state.connection.status !== 'disconnected') return;
      update({ connection: { status: 'reconnecting', attempts: state.connection.attempts + 1 } });
      transport.connect();
    },
  };
};
