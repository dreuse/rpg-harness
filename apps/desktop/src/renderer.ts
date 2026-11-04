import {
  type CampaignPanels,
  type CampaignSnapshot,
  type ClientCommand,
  EVENT_COMMITTED,
  failure,
  PROTOCOL_VERSION,
  parseCommand,
  type Result,
  type SubmitPlayerAction,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import { parseViewDescriptor } from '../../../packages/client-protocol/src/view-registry.ts';
import type { Campaign, CampaignId } from '../../../packages/domain/src/campaign.ts';
import type { Ready } from '../../cli/src/desktop-daemon.ts';
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
const NO_REVISION = -1;
const LIST_CAMPAIGNS: ClientCommand = { version: PROTOCOL_VERSION, type: 'ListCampaigns' };

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
export type Connection = {
  readonly status: ConnectionStatus;
  readonly attempts: number;
  readonly lastError?: string;
  readonly engine?: Pick<Ready, 'pid' | 'gm'>;
};
export type RejectedAction = { readonly actionId: string; readonly input: string; readonly message: string };
export type DesktopState = {
  readonly connection: Connection;
  readonly campaigns: readonly Campaign[];
  readonly selected?: CampaignId;
  readonly snapshot?: CampaignSnapshot;
  readonly panels?: CampaignPanels;
  readonly views: Readonly<Record<string, ViewDescriptor>>;
  readonly outbox: readonly SubmitPlayerAction[];
  readonly rejected: readonly RejectedAction[];
};

export type Transport = {
  connect(): void;
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error: string) => void): void;
};

export type Region = 'campaigns' | 'status' | 'conversation' | 'sheet' | 'panels';
export type Layout = { readonly name: 'compact' | 'medium' | 'wide'; readonly columns: readonly (readonly Region[])[] };

export const layoutFor = (width: number): Layout => {
  if (!(width > COMPACT_MAX_WIDTH))
    return { name: 'compact', columns: [['status', 'conversation', 'sheet', 'panels']] };
  if (width <= MEDIUM_MAX_WIDTH)
    return {
      name: 'medium',
      columns: [
        ['status', 'conversation'],
        ['sheet', 'panels'],
      ],
    };
  return { name: 'wide', columns: [['campaigns'], ['status', 'conversation'], ['sheet', 'panels']] };
};

export const initialState: DesktopState = {
  connection: { status: 'connecting', attempts: 0 },
  campaigns: [],
  views: {},
  outbox: [],
  rejected: [],
};

const statusLabel = ({ status, attempts, lastError, engine }: Connection, locale: string) =>
  translate(locale, `status.${status}`, { pid: engine?.pid, gm: engine?.gm, error: lastError, attempts });

export const viewModel = (state: DesktopState, width: number, preferences: UiPreferences = DEFAULT_PREFERENCES) => {
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
    campaigns: state.campaigns.map(({ id, name }) => ({ id, name, selected: id === state.selected })),
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
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCampaign = (value: unknown): value is Campaign =>
  isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';

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
}: {
  readonly transport: Transport;
  readonly newActionId: () => string;
}) => {
  let state = initialState;
  let resendOnSnapshot = false;
  const listeners = new Set<(state: DesktopState) => void>();

  const update = (next: Partial<DesktopState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener(state);
  };

  const connected = () => state.connection.status === 'connected';

  const disconnect = (error: string) =>
    update({ connection: { status: 'disconnected', attempts: state.connection.attempts, lastError: error } });

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

  const forSelected = (value: unknown): value is { campaignId: CampaignId; version: number } =>
    isRecord(value) && value.version === PROTOCOL_VERSION && value.campaignId === state.selected;

  const settle = (actionId: unknown, message?: string) => {
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
    refresh();
  };

  const onSnapshot = (snapshot: CampaignSnapshot) => {
    const outbox = state.outbox.map((action) =>
      action.campaignId === snapshot.campaignId && action.expectedRevision < snapshot.revision
        ? Object.freeze({ ...action, expectedRevision: snapshot.revision })
        : action,
    );
    update({ snapshot, outbox });
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
      return update({ campaigns: message.campaigns.filter(isCampaign) });
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
    if (message.type === ACCEPTED) return settle(message.actionId);
    if (message.type === REJECTED) {
      const error = isRecord(message.error) ? String(message.error.message) : String(message.error);
      return settle(message.actionId, error);
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
    select: (campaignId: CampaignId) => {
      const { snapshot, panels, ...rest } = state;
      state = { ...rest, selected: campaignId, views: {} };
      update({});
      refresh();
    },
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
    retry: () => {
      if (state.connection.status !== 'disconnected') return;
      update({ connection: { status: 'reconnecting', attempts: state.connection.attempts + 1 } });
      transport.connect();
    },
  };
};
