import { join } from 'node:path';
import type { ClientCommand } from '../../../packages/client-protocol/src/protocol.ts';
import { type DaemonOptions, daemonEnv, startDaemon as startEngine } from '../../cli/src/desktop-daemon.ts';
import { loadPreferences, parsePreferences } from './accessibility.ts';
import { CHANNELS, PREFERENCES_QUERY } from './preload.ts';
import type { Transport } from './renderer.ts';

export const PREFERENCES_FILE = 'desktop-preferences.json';
export const ENGINE_CRASHED = 'Engine crashed.';
export const WINDOW_WIDTH = 1280;
export const WINDOW_HEIGHT = 800;
export const WINDOW_SECURITY = { contextIsolation: true, nodeIntegration: false, sandbox: true } as const;

const TEXT = 'utf8';

export type Daemon = Pick<ReturnType<typeof startEngine>, 'ready' | 'command' | 'stop'>;
export type WebContentsLike = { send(channel: string, ...args: unknown[]): void };
export type WindowOptions = {
  readonly width: number;
  readonly height: number;
  readonly webPreferences: typeof WINDOW_SECURITY & { readonly preload: string };
};
export type BrowserWindowLike = {
  readonly webContents: WebContentsLike;
  loadFile(page: string, options: { readonly query: Record<string, string> }): unknown;
};
export type IpcMainLike = {
  on(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void): void;
};
export type PreferencesFs = {
  readFileSync(path: string, encoding: typeof TEXT): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { readonly recursive: true }): unknown;
};
export type MainOptions = {
  readonly BrowserWindow: new (options: WindowOptions) => BrowserWindowLike;
  readonly ipcMain: IpcMainLike;
  readonly fs: PreferencesFs;
  readonly env: NodeJS.ProcessEnv;
  readonly dataDir: string;
  readonly preload: string;
  readonly page: string;
  readonly startDaemon?: (options: DaemonOptions) => Daemon;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const parseCommandLine = (line: string): ClientCommand | undefined => {
  try {
    return JSON.parse(line) as ClientCommand;
  } catch {
    return undefined;
  }
};

export const daemonTransport = (daemon: Pick<Daemon, 'ready' | 'command'>): Transport => {
  let onLine = (_line: string) => {};
  let onClose = (_error: string) => {};
  const emit = (message: object) => onLine(JSON.stringify(message));
  const close = (error: unknown) => onClose(messageOf(error));
  const reply = async (command: ClientCommand) => {
    const { result, message } = await daemon.command(command);
    if (command.type === 'SubmitPlayerAction') {
      const { actionId } = command;
      return emit(
        result?.ok ? { type: 'Accepted', actionId } : { type: 'Rejected', actionId, error: result?.error ?? message },
      );
    }
    if (!result?.ok) return;
    if (command.type === 'ListCampaigns') return emit({ type: 'Campaigns', ...(result.value as object) });
    if (command.type === 'GetCampaignSnapshot') return emit({ type: 'Snapshot', snapshot: result.value });
    if (command.type === 'GetCampaignPanels') return emit({ type: 'Panels', panels: result.value });
    if (command.type === 'RequestView')
      return emit({ type: 'View', campaignId: command.campaignId, view: result.value });
  };
  return {
    connect: () => {
      daemon.ready().then(emit, close);
    },
    send: (line) => {
      const command = parseCommandLine(line);
      if (command !== undefined) reply(command).catch(close);
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onClose: (listener) => {
      onClose = listener;
    },
  };
};

export const startMain = ({
  BrowserWindow,
  ipcMain,
  fs,
  env,
  dataDir,
  preload,
  page,
  startDaemon = startEngine,
}: MainOptions) => {
  const preferencesPath = join(dataDir, PREFERENCES_FILE);
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    webPreferences: { preload, ...WINDOW_SECURITY },
  });
  const push = (channel: string, value: string) => window.webContents.send(channel, value);
  const daemon = startDaemon({ env: daemonEnv(env), onCrash: () => push(CHANNELS.close, ENGINE_CRASHED) });
  const transport = daemonTransport(daemon);
  transport.onLine((line) => push(CHANNELS.line, line));
  transport.onClose((error) => push(CHANNELS.close, error));
  const fromWindow =
    (handler: (...args: unknown[]) => void) =>
    ({ sender }: { readonly sender: unknown }, ...args: unknown[]) => {
      if (sender === window.webContents) handler(...args);
    };
  ipcMain.on(
    CHANNELS.connect,
    fromWindow(() => transport.connect()),
  );
  ipcMain.on(
    CHANNELS.send,
    fromWindow((line) => {
      if (typeof line === 'string') transport.send(line);
    }),
  );
  ipcMain.on(
    CHANNELS.preferences,
    fromWindow((input) => {
      const parsed = parsePreferences(input);
      if (!parsed.ok) return;
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(preferencesPath, JSON.stringify(parsed.value));
      } catch {
        return;
      }
    }),
  );
  const preferences = loadPreferences(() => fs.readFileSync(preferencesPath, TEXT));
  window.loadFile(page, { query: { [PREFERENCES_QUERY]: JSON.stringify(preferences) } });
  return { window, stop: () => daemon.stop() };
};
