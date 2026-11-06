import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  loadStartDraft,
  parseStartDraft,
  START_DRAFT_FILE,
} from '../../../packages/client-protocol/src/guided-start.ts';
import { LANGUAGE_ENV, localeOf } from '../../../packages/client-protocol/src/locale.ts';
import { type ClientCommand, failure } from '../../../packages/client-protocol/src/protocol.ts';
import { NARRATION, NARRATION_FAILED } from '../../../packages/client-protocol/src/wire.ts';
import { isPlaybackCommand } from '../../../packages/voice/src/playback-controls.ts';
import {
  DAEMON_ENTRY,
  type DaemonOptions,
  type EngineMessage,
  engineEnv,
  type SpawnEngine,
  startDaemon as startEngine,
} from '../../cli/src/desktop-daemon.ts';
import { loadPreferences, parsePreferences, persistedPreferences, SUPPORTED_LOCALES } from './accessibility.ts';
import { createImportHost } from './import-host.ts';
import { CHANNELS, PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import type { Transport } from './renderer.ts';
import type { SoundHost } from './sound-host.ts';
import type { VoiceHost } from './voice-host.ts';

export const PREFERENCES_FILE = 'desktop-preferences.json';
export const ENGINE_CRASHED = 'Engine crashed.';
export const WINDOW_WIDTH = 1280;
export const WINDOW_HEIGHT = 800;
export const WINDOW_SECURITY = { contextIsolation: true, nodeIntegration: false, sandbox: true } as const;
export const DENY_WINDOW = { action: 'deny' } as const;
export const SMOKE_ENV = 'RPG_DESKTOP_SMOKE';
export const SMOKE_STATUS = 'rpg-desktop-smoke-status: ';

const TEXT = 'utf8';

export type Daemon = Pick<ReturnType<typeof startEngine>, 'ready' | 'command' | 'subscribe' | 'stop'> &
  Partial<Pick<ReturnType<typeof startEngine>, 'playback' | 'diagnostics' | 'language'>>;
export type WebContentsLike = {
  send(channel: string, ...args: unknown[]): void;
  on(name: 'will-navigate', listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: () => typeof DENY_WINDOW): void;
};
export type WindowOptions = {
  readonly width: number;
  readonly height: number;
  readonly show?: false;
  readonly webPreferences: typeof WINDOW_SECURITY & { readonly preload: string };
};
export type BrowserWindowLike = {
  readonly webContents: WebContentsLike;
  loadURL(url: string): unknown;
  on(name: 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
};
export type IpcMainLike = {
  on(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => void): void;
  handle?(channel: string, listener: (event: { readonly sender: unknown }, ...args: unknown[]) => unknown): void;
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
  readonly voice?: VoiceHost;
  readonly sound?: SoundHost;
  readonly showOpenDialog?: () => Promise<readonly string[]>;
  readonly hidden?: boolean;
};
export const FOREIGN_SENDER = 'ipc sender is not the app window';

export type UtilityProcessLike = {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: EngineMessage) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
};
export type Fork = (
  modulePath: string,
  args: string[],
  options: { readonly env: NodeJS.ProcessEnv },
) => UtilityProcessLike;

export const utilityEngine =
  (fork: Fork): SpawnEngine =>
  (env, on) => {
    const engine = fork(DAEMON_ENTRY, [], { env: engineEnv(env) });
    engine.on('message', on.message);
    engine.on('exit', (code) => on.exit(code, null));
    return { pid: () => engine.pid, send: (message) => engine.postMessage(message), kill: () => engine.kill() };
  };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const parseCommandLine = (line: string): ClientCommand | undefined => {
  try {
    return JSON.parse(line) as ClientCommand;
  } catch {
    return undefined;
  }
};

const HOME_CHANGES: ReadonlySet<string> = new Set([
  'OpenCampaign',
  'ArchiveCampaign',
  'UnarchiveCampaign',
  'RenameCampaign',
  'DeleteCampaign',
]);

const ACTIONS: ReadonlySet<string> = new Set([
  'SubmitPlayerAction',
  'SaveVoiceSettings',
  'SaveGmSettings',
  'SaveGmDefaults',
  'SetCampaignLanguage',
  'EditSheetField',
]);

const STORY_COMMANDS: ReadonlySet<string> = new Set(['GetStoryMemory', 'CorrectStoryFact']);

const OOC_COMMANDS: ReadonlySet<string> = new Set(['SubmitOocMessage', 'ConfirmOocProposal', 'UndoOocChange']);

export const daemonTransport = (daemon: Pick<Daemon, 'ready' | 'command' | 'subscribe'>): Transport => {
  let onLine = (_line: string) => {};
  let onClose = (_error: string) => {};
  let unsubscribe = async () => {};
  const emit = (message: object) => onLine(JSON.stringify(message));
  const close = (error: unknown) => onClose(messageOf(error));
  const follow = async (command: ClientCommand) => {
    const previous = unsubscribe;
    const subscription = await daemon.subscribe(command, emit);
    unsubscribe = async () => {
      await subscription.unsubscribe();
    };
    await previous().catch(() => {});
  };
  const reply = async (command: ClientCommand) => {
    if (command.type === 'SubscribeEvents') return follow(command);
    const { result, message, narrationFailed } = await daemon.command(
      command,
      command.type === 'SubmitPlayerAction' ? ({ turnId, text }) => emit({ type: NARRATION, turnId, text }) : undefined,
    );
    if (ACTIONS.has(command.type) && 'actionId' in command) {
      const { actionId } = command;
      if (narrationFailed !== undefined) emit({ type: NARRATION_FAILED, actionId, failure: narrationFailed });
      return emit(
        result?.ok ? { type: 'Accepted', actionId } : { type: 'Rejected', actionId, error: result?.error ?? message },
      );
    }
    if (OOC_COMMANDS.has(command.type) && 'actionId' in command)
      return emit({
        type: 'OocResult',
        command: command.type,
        actionId: command.actionId,
        result: result ?? failure('Rejected', String(message)),
      });
    if (STORY_COMMANDS.has(command.type))
      return emit({
        type: 'StoryResult',
        command: command.type,
        result: result ?? failure('Rejected', String(message)),
      });
    if (command.type === 'PlanCampaign' || command.type === 'CreateCampaign')
      return emit({
        type: command.type === 'PlanCampaign' ? 'Planned' : 'Created',
        command,
        result: result ?? failure('Rejected', String(message)),
      });
    if (HOME_CHANGES.has(command.type))
      return emit({ type: 'Changed', command, result: result ?? failure('Rejected', String(message)) });
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
  voice,
  sound,
  showOpenDialog,
  hidden = false,
}: MainOptions) => {
  const preferencesPath = join(dataDir, PREFERENCES_FILE);
  const systemLocale = localeOf(env, SUPPORTED_LOCALES);
  const startPath = join(dataDir, START_DRAFT_FILE);
  const preferences = loadPreferences(() => fs.readFileSync(preferencesPath, TEXT), systemLocale);
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    ...(hidden ? { show: false as const } : {}),
    webPreferences: { preload, ...WINDOW_SECURITY },
  });
  const push = (channel: string, value: string | number | boolean) => {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  };
  let engineLocale = preferences.locale;
  const daemon = startDaemon({
    env: { ...engineEnv(env), [LANGUAGE_ENV]: preferences.locale },
    onCrash: () => push(CHANNELS.close, ENGINE_CRASHED),
    onSpeaking: (active) => push(CHANNELS.soundSpeaking, active),
  });
  window.on('closed', () => {
    daemon.stop();
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => DENY_WINDOW);
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
  const save = (path: string, value: unknown) => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path, JSON.stringify(value));
    } catch {
      return;
    }
  };
  ipcMain.on(
    CHANNELS.preferences,
    fromWindow((input) => {
      const parsed = parsePreferences(input);
      if (!parsed.ok) return;
      save(preferencesPath, persistedPreferences(parsed.value, systemLocale));
      if (parsed.value.locale === engineLocale) return;
      engineLocale = parsed.value.locale;
      daemon.language?.(engineLocale)?.catch(() => undefined);
    }),
  );
  ipcMain.on(
    CHANNELS.start,
    fromWindow((input) => {
      const draft = parseStartDraft(input);
      if (isDeepStrictEqual(draft, input)) save(startPath, draft);
    }),
  );
  const invokedFromWindow =
    (handler: (...args: unknown[]) => unknown) =>
    async ({ sender }: { readonly sender: unknown }, ...args: unknown[]) => {
      if (sender !== window.webContents) throw new Error(FOREIGN_SENDER);
      return handler(...args);
    };
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) =>
    ipcMain.handle?.(channel, invokedFromWindow(handler));
  handle(CHANNELS.voiceDiagnostics, async () => (await daemon.diagnostics?.())?.summary);
  handle(CHANNELS.voicePlayback, async (command) => {
    if (!isPlaybackCommand(command)) return false;
    return (await daemon.playback?.(command))?.type === 'Played';
  });
  if (voice !== undefined) {
    handle(CHANNELS.voiceCheck, () => voice.check());
    handle(CHANNELS.voiceDownload, (providerId, consent) =>
      voice.download(providerId, consent, (bytes) => push(CHANNELS.voiceProgress, bytes)),
    );
    handle(CHANNELS.voiceRemove, (providerId) => voice.remove(providerId));
    handle(CHANNELS.voicePreview, (request) => voice.preview(request));
    handle(CHANNELS.voiceClear, () => voice.clearCache());
  }
  if (showOpenDialog !== undefined) {
    const imports = createImportHost({ dataDir, showOpenDialog });
    handle(CHANNELS.importRulebook, (request) => imports.run(request));
  }
  if (sound !== undefined) {
    handle(CHANNELS.soundStatus, () => sound.status());
    handle(CHANNELS.soundDownload, (consent) =>
      sound.download(consent, (bytes) => push(CHANNELS.soundProgress, bytes)),
    );
    handle(CHANNELS.soundFile, (kind, key) => sound.file(kind, key));
  }
  const url = new URL(page);
  url.searchParams.set(PREFERENCES_QUERY, JSON.stringify(preferences));
  url.searchParams.set(START_QUERY, JSON.stringify(loadStartDraft(() => fs.readFileSync(startPath, TEXT))));
  window.loadURL(url.href);
  return { window, stop: () => daemon.stop() };
};
