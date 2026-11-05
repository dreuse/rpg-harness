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
  EVENT_COMMITTED,
  failure,
  PROTOCOL_VERSION,
  parseCommand,
  type Result,
  type SavedVoiceSettings,
  type SaveVoiceSettings,
  type StartOptions,
  type SubmitPlayerAction,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import { parseViewDescriptor } from '../../../packages/client-protocol/src/view-registry.ts';
import type { Ready } from '../../../packages/client-protocol/src/wire.ts';
import type { CampaignId } from '../../../packages/domain/src/campaign.ts';
import { componentLabel, DEFAULT_PREFERENCES, translate, type UiPreferences } from './accessibility.ts';

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
};

export type Transport = {
  connect(): void;
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error: string) => void): void;
};

export const REGIONS = ['campaigns', 'status', 'conversation', 'sheet', 'panels'] as const;
export type Region = (typeof REGIONS)[number];
export type Layout = { readonly name: 'compact' | 'medium' | 'wide'; readonly columns: readonly (readonly Region[])[] };

export const layoutFor = (width: number): Layout => {
  if (!(width > COMPACT_MAX_WIDTH))
    return { name: 'compact', columns: [['status', 'conversation', 'sheet', 'panels', 'campaigns']] };
  if (width <= MEDIUM_MAX_WIDTH)
    return {
      name: 'medium',
      columns: [
        ['status', 'conversation'],
        ['sheet', 'panels', 'campaigns'],
      ],
    };
  return { name: 'wide', columns: [['campaigns'], ['status', 'conversation'], ['sheet', 'panels']] };
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

export const viewModel = (
  state: DesktopState,
  width: number,
  preferences: UiPreferences = DEFAULT_PREFERENCES,
  now = Date.now(),
) => {
  const committed = state.snapshot?.turns ?? [];
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
    playing: state.selected !== undefined,
    home: homeOf(state, preferences.locale, now),
    conversation: [
      ...committed.map(({ actionId, input, narration }) => ({ actionId, input, narration, pending: false })),
      ...pending.map(({ actionId, input }) => ({ actionId, input, narration: '', pending: true })),
    ],
    sheet: state.views[SHEET_VIEW],
    sheetLabels: (state.views[SHEET_VIEW]?.components ?? []).map((component) => ({
      id: component.id,
      label: componentLabel(component, preferences.locale),
    })),
    fontScale: preferences.fontScale,
    animate: !preferences.reducedMotion,
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

  const settle = (actionId: unknown, message?: string, code?: unknown) => {
    if (voiceSaves.has(actionId)) return settleVoice(actionId, message, code);
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
    state = { ...rest, selected: campaignId, views: {} };
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
      if (view.ok) update({ views: { ...state.views, [view.value.viewId]: view.value } });
      return;
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
