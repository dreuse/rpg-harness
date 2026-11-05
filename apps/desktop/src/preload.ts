import type { StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import type { UiPreferences } from './accessibility.ts';
import type { Transport } from './renderer.ts';

export const BRIDGE_KEY = 'rpg';
export const PREFERENCES_QUERY = 'preferences';
export const START_QUERY = 'start';
export const CHANNELS = {
  connect: 'rpg:connect',
  send: 'rpg:send',
  line: 'rpg:line',
  close: 'rpg:close',
  preferences: 'rpg:preferences',
  start: 'rpg:start',
} as const;

export type Bridge = Transport & {
  savePreferences(preferences: UiPreferences): void;
  saveStart(draft: StartDraft): void;
};
export type IpcRendererLike = {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
export type ContextBridgeLike = { exposeInMainWorld(key: string, api: Bridge): void };

export const exposeBridge = ({
  contextBridge,
  ipcRenderer,
}: {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
}) =>
  contextBridge.exposeInMainWorld(BRIDGE_KEY, {
    connect: () => ipcRenderer.send(CHANNELS.connect),
    send: (line) => ipcRenderer.send(CHANNELS.send, String(line)),
    onLine: (listener) => ipcRenderer.on(CHANNELS.line, (_event, line) => listener(String(line))),
    onClose: (listener) => ipcRenderer.on(CHANNELS.close, (_event, error) => listener(String(error))),
    savePreferences: (preferences) => ipcRenderer.send(CHANNELS.preferences, preferences),
    saveStart: (draft) => ipcRenderer.send(CHANNELS.start, draft),
  });
