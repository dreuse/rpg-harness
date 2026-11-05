import type { StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import type { UiPreferences } from './accessibility.ts';
import type { Transport } from './renderer.ts';
import type { VoiceBridge } from './voice-setup.ts';

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
  voiceCheck: 'rpg:voice:check',
  voiceDownload: 'rpg:voice:download',
  voiceProgress: 'rpg:voice:progress',
  voiceRemove: 'rpg:voice:remove',
  voicePreview: 'rpg:voice:preview',
  voiceClear: 'rpg:voice:clear',
  voicePlayback: 'rpg:voice:playback',
  voiceDiagnostics: 'rpg:voice:diagnostics',
} as const;

export type Bridge = Transport & {
  savePreferences(preferences: UiPreferences): void;
  saveStart(draft: StartDraft): void;
  voice: VoiceBridge;
};
export type IpcRendererLike = {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
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
    voice: {
      check: () => ipcRenderer.invoke(CHANNELS.voiceCheck) as never,
      download: (providerId, consent) => ipcRenderer.invoke(CHANNELS.voiceDownload, providerId, consent) as never,
      remove: (providerId) => ipcRenderer.invoke(CHANNELS.voiceRemove, providerId) as never,
      preview: (request) => ipcRenderer.invoke(CHANNELS.voicePreview, request) as never,
      clearCache: () => ipcRenderer.invoke(CHANNELS.voiceClear) as never,
      diagnostics: () => ipcRenderer.invoke(CHANNELS.voiceDiagnostics) as never,
      playback: (command) => ipcRenderer.invoke(CHANNELS.voicePlayback, command) as never,
      onProgress: (listener) => ipcRenderer.on(CHANNELS.voiceProgress, (_event, bytes) => listener(Number(bytes))),
    },
  });
