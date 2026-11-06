import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { INITIAL_DRAFT, START_DRAFT_FILE } from '../../../packages/client-protocol/src/guided-start.ts';
import { DEFAULT_LOCALE, LANGUAGE_ENV } from '../../../packages/client-protocol/src/locale.ts';
import { type ClientEvent, EVENT_COMMITTED, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import {
  API_KEY_ENV,
  CONSUMER_CREDENTIAL_PREFIX,
  DAEMON_ENTRY,
  type DaemonOptions,
  ELECTRON_RUN_AS_NODE_ENV,
  startDaemon,
} from '../../cli/src/desktop-daemon.ts';
import { hermeticGmEnv } from '../../cli/src/gm-test-env.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE } from './accessibility.ts';
import {
  type Daemon,
  daemonTransport,
  ENGINE_CRASHED,
  type Fork,
  PREFERENCES_FILE,
  startMain,
  type UtilityProcessLike,
  utilityEngine,
  WINDOW_SECURITY,
} from './main.ts';
import { CHANNELS, PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import type { SoundHost } from './sound-host.ts';
import type { VoiceHost } from './voice-host.ts';

const DATA_DIR = '/data';
const PRELOAD = '/app/preload.js';
const PAGE = 'rpg://app/apps/desktop/src/index.html';
const CAMPAIGN = 'c1';
const READY = { type: 'Ready', version: PROTOCOL_VERSION, pid: 7, node: 'v24', sqlite: true, gm: 'fake' };
const STOPPED = 'The engine is not running.';
const API_KEY = 'sk-test';
const CONSUMER_TOKEN = 'token';
const SENT_PREFERENCES = { ...DEFAULT_PREFERENCES, fontScale: MAX_FONT_SCALE };
const VIEW = { campaignId: CAMPAIGN, viewId: 'sheet', components: [] };
const command = (type: string, extra: object = {}) =>
  JSON.stringify({ version: PROTOCOL_VERSION, type, campaignId: CAMPAIGN, ...extra });

type Listener = (event: ClientEvent) => void;

const fakeDaemon = (
  results: Record<string, unknown> = {},
): Daemon & { stopped: () => boolean; listeners: Listener[]; unsubscribed: () => number } => {
  let stopped = false;
  let unsubscribed = 0;
  const listeners: Listener[] = [];
  return {
    listeners,
    unsubscribed: () => unsubscribed,
    subscribe: async (_input, listener) => {
      listeners.push(listener);
      return {
        reply: { id: 0, type: 'Result', result: { ok: true, value: {} } },
        unsubscribe: async () => {
          unsubscribed += 1;
          return { id: 0, type: 'Unsubscribed' };
        },
      };
    },
    ready: async () => READY as Awaited<ReturnType<Daemon['ready']>>,
    command: async (input) => {
      const { type } = input as { type: string };
      if (!Object.hasOwn(results, type)) throw new Error(STOPPED);
      return { id: 0, type: 'Result', result: results[type] as { ok: true; value: unknown } };
    },
    stop: async () => {
      stopped = true;
      return 0;
    },
    stopped: () => stopped,
  };
};

const VOICE_SETTINGS = { expectedRevision: 1, microphone: 'off', spokenOutput: 'off', locale: 'en', speed: 1 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

const collect = (daemon: Daemon) => {
  const transport = daemonTransport(daemon);
  const lines: unknown[] = [];
  const closes: string[] = [];
  transport.onLine((line) => lines.push(JSON.parse(line)));
  transport.onClose((error) => closes.push(error));
  return { transport, lines, closes };
};

test('UI08 daemon transport maps engine replies to renderer lines', async () => {
  const snapshot = { campaignId: CAMPAIGN };
  const { transport, lines, closes } = collect(
    fakeDaemon({
      ListCampaigns: { ok: true, value: { campaigns: [] } },
      GetCampaignSnapshot: { ok: true, value: snapshot },
      GetCampaignPanels: { ok: true, value: snapshot },
      RequestView: { ok: true, value: VIEW },
      SubmitPlayerAction: { ok: false, error: { code: 'Rejected', message: 'no' } },
      SaveVoiceSettings: { ok: true, value: { revision: 2 } },
    }),
  );
  transport.connect();
  transport.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ListCampaigns' }));
  transport.send(command('GetCampaignSnapshot'));
  transport.send(command('GetCampaignPanels'));
  transport.send(command('RequestView', { viewId: 'sheet' }));
  transport.send(command('SubmitPlayerAction', { actionId: 'a1' }));
  transport.send(command('SaveVoiceSettings', { actionId: 'v1', ...VOICE_SETTINGS }));
  transport.send('not json');
  await flush();
  assert.deepEqual(lines, [
    READY,
    { type: 'Campaigns', campaigns: [] },
    { type: 'Snapshot', snapshot },
    { type: 'Panels', panels: snapshot },
    { type: 'View', campaignId: CAMPAIGN, view: VIEW },
    { type: 'Rejected', actionId: 'a1', error: { code: 'Rejected', message: 'no' } },
    { type: 'Accepted', actionId: 'v1' },
  ]);
  assert.deepEqual(closes, []);
});

test('rpg-42a.101 daemon transport reports a failed narration before the action settles', async () => {
  const failure = { kind: 'limit' as const, detail: '3:30pm' };
  const daemon = {
    ...fakeDaemon(),
    command: async () => ({
      id: 0,
      type: 'Result' as const,
      result: { ok: true as const, value: {} },
      narrationFailed: failure,
    }),
  };
  const { transport, lines } = collect(daemon);
  transport.send(command('SubmitPlayerAction', { actionId: 'a1' }));
  await flush();
  assert.deepEqual(lines, [
    { type: 'NarrationFailed', actionId: 'a1', failure },
    { type: 'Accepted', actionId: 'a1' },
  ]);
});

test('rpg-cm63.22 daemon transport relays streamed narration lines before the action settles', async () => {
  const daemon = {
    ...fakeDaemon(),
    command: async (_input: unknown, onNarration?: (narration: { turnId: string; text: string }) => void) => {
      onNarration?.({ turnId: 't1', text: 'First.' });
      onNarration?.({ turnId: 't1', text: 'Second.' });
      return { id: 0, type: 'Result' as const, result: { ok: true as const, value: {} } };
    },
  };
  const { transport, lines } = collect(daemon);
  transport.send(command('SubmitPlayerAction', { actionId: 'a1' }));
  await flush();
  assert.deepEqual(lines, [
    { type: 'Narration', turnId: 't1', text: 'First.' },
    { type: 'Narration', turnId: 't1', text: 'Second.' },
    { type: 'Accepted', actionId: 'a1' },
  ]);
});

test('rpg-42a.91 daemon transport relays out-of-character results without narration', async () => {
  const reply = { ok: true as const, value: { reply: 'Sure.', proposals: [] } };
  const applied = { ok: true as const, value: { revision: 3, summary: 'Done' } };
  const wired = collect({
    ...fakeDaemon({ SubmitOocMessage: reply, ConfirmOocProposal: applied, UndoOocChange: applied }),
    command: async (input: unknown, onNarration?: unknown) => {
      assert.equal(onNarration, undefined);
      const { type } = input as { type: string };
      return { id: 0, type: 'Result' as const, result: type === 'SubmitOocMessage' ? reply : applied };
    },
  });
  wired.transport.send(command('SubmitOocMessage', { actionId: 'o1', text: 'hi' }));
  wired.transport.send(command('ConfirmOocProposal', { actionId: 'o2', expectedRevision: 1, proposal: {} }));
  wired.transport.send(command('UndoOocChange', { actionId: 'o3', expectedRevision: 2 }));
  await flush();
  assert.deepEqual(wired.lines, [
    { type: 'OocResult', command: 'SubmitOocMessage', actionId: 'o1', result: reply },
    { type: 'OocResult', command: 'ConfirmOocProposal', actionId: 'o2', result: applied },
    { type: 'OocResult', command: 'UndoOocChange', actionId: 'o3', result: applied },
  ]);
});

test('rpg-42a.21 daemon transport settles sheet edits as Accepted or Rejected', async () => {
  const edit = (results: Record<string, unknown>) => {
    const wired = collect(fakeDaemon(results));
    wired.transport.connect();
    wired.transport.send(command('EditSheetField', { actionId: 'e1', fieldId: 'might', value: 8 }));
    return wired.lines;
  };
  const accepted = edit({ EditSheetField: { ok: true, value: { revision: 2 } } });
  const rejected = edit({ EditSheetField: { ok: false, error: { code: 'Rejected', message: 'too high' } } });
  await flush();
  assert.deepEqual(accepted, [READY, { type: 'Accepted', actionId: 'e1' }]);
  assert.deepEqual(rejected, [
    READY,
    { type: 'Rejected', actionId: 'e1', error: { code: 'Rejected', message: 'too high' } },
  ]);
});

test('rpg-42a.13 daemon transport relays home lifecycle results, including rejections', async () => {
  const opened = { version: PROTOCOL_VERSION, type: 'OpenCampaign', name: 'Harbor' };
  const archived = { version: PROTOCOL_VERSION, type: 'ArchiveCampaign', name: 'Harbor' };
  const rejected = { ok: false, error: { code: 'Rejected', message: 'open' } };
  const { transport, lines } = collect(
    fakeDaemon({ OpenCampaign: { ok: true, value: { id: CAMPAIGN } }, ArchiveCampaign: rejected }),
  );
  transport.send(JSON.stringify(opened));
  transport.send(JSON.stringify(archived));
  await flush();
  assert.deepEqual(lines, [
    { type: 'Changed', command: opened, result: { ok: true, value: { id: CAMPAIGN } } },
    { type: 'Changed', command: archived, result: rejected },
  ]);
});

test('rpg-42a.66 daemon transport relays rename results', async () => {
  const renamed = { version: PROTOCOL_VERSION, type: 'RenameCampaign', name: 'Harbor', newName: 'Beacon' };
  const result = { ok: true, value: { id: CAMPAIGN } };
  const { transport, lines } = collect(fakeDaemon({ RenameCampaign: result }));
  transport.send(JSON.stringify(renamed));
  await flush();
  assert.deepEqual(lines, [{ type: 'Changed', command: renamed, result }]);
});

test('rpg-42a.7 daemon transport relays SubscribeEvents and keeps one subscription', async () => {
  const daemon = fakeDaemon();
  const { transport, lines, closes } = collect(daemon);
  const event = { version: PROTOCOL_VERSION, type: EVENT_COMMITTED, revision: 2, event: { campaignId: CAMPAIGN } };
  transport.send(command('SubscribeEvents'));
  await flush();
  daemon.listeners[0]?.(event as unknown as ClientEvent);
  assert.deepEqual(lines, [event]);
  transport.send(command('SubscribeEvents'));
  await flush();
  assert.equal(daemon.listeners.length, 2);
  assert.equal(daemon.unsubscribed(), 1);
  assert.deepEqual(closes, []);
});

test('UI08 daemon transport reports a failed engine call as closed', async () => {
  const { transport, lines, closes } = collect(fakeDaemon());
  transport.send(command('GetCampaignSnapshot'));
  await flush();
  assert.deepEqual(lines, []);
  assert.deepEqual(closes, [STOPPED]);
});

const fakeElectron = (files: Record<string, string> = {}) => {
  const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>();
  const pushed: unknown[][] = [];
  const written: Record<string, string> = {};
  const made: string[] = [];
  const windows: { options: unknown; url: string }[] = [];
  const windowEvents = new Map<string, () => void>();
  const contentEvents = new Map<string, (event: { preventDefault(): void }) => void>();
  let openHandler = (): unknown => undefined;
  let destroyed = false;
  const webContents = {
    send: (channel: string, ...args: unknown[]) => {
      pushed.push([channel, ...args]);
    },
    on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
      contentEvents.set(name, listener);
    },
    setWindowOpenHandler: (handler: () => unknown) => {
      openHandler = handler;
    },
  };
  class BrowserWindow {
    readonly webContents = webContents;
    readonly options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    loadURL(url: string) {
      windows.push({ options: this.options, url });
    }
    on(name: string, listener: () => void) {
      windowEvents.set(name, listener);
    }
    isDestroyed() {
      return destroyed;
    }
  }
  const destroy = () => {
    destroyed = true;
    windowEvents.get('closed')?.();
  };
  const navigate = () => {
    let prevented = false;
    contentEvents.get('will-navigate')?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  const fs = {
    readFileSync: (path: string) => {
      if (!Object.hasOwn(files, path)) throw new Error('missing');
      return files[path] as string;
    },
    writeFileSync: (path: string, data: string) => {
      written[path] = data;
    },
    mkdirSync: (path: string) => {
      made.push(path);
    },
  };
  const invokers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>();
  const ipcMain = {
    on: (channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void) => {
      handlers.set(channel, listener);
    },
    handle: (channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => unknown) => {
      invokers.set(channel, listener);
    },
  };
  const invoke = async (channel: string, sender: unknown, ...args: unknown[]) =>
    invokers.get(channel)?.({ sender }, ...args);
  const ipc = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: webContents }, ...args);
  const foreign = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
  return {
    BrowserWindow,
    ipcMain,
    fs,
    ipc,
    invoke: (channel: string, ...args: unknown[]) => invoke(channel, webContents, ...args),
    invokeForeign: (channel: string, ...args: unknown[]) => invoke(channel, {}, ...args),
    channels: () => [...invokers.keys()],
    foreign,
    pushed,
    written,
    made,
    windows,
    destroy,
    navigate,
    open: () => openHandler(),
  };
};

const HERMETIC_LOCALE = { [LANGUAGE_ENV]: DEFAULT_LOCALE };

const start = (
  electron: ReturnType<typeof fakeElectron>,
  daemon = fakeDaemon(),
  voice?: VoiceHost,
  locale: Readonly<Record<string, string>> = HERMETIC_LOCALE,
  sound?: SoundHost,
  showOpenDialog?: () => Promise<readonly string[]>,
) => {
  const options: DaemonOptions[] = [];
  const main = startMain({
    ...electron,
    ...(voice === undefined ? {} : { voice }),
    ...(sound === undefined ? {} : { sound }),
    ...(showOpenDialog === undefined ? {} : { showOpenDialog }),
    env: { [API_KEY_ENV]: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: CONSUMER_TOKEN, ...locale },
    dataDir: DATA_DIR,
    preload: PRELOAD,
    page: PAGE,
    startDaemon: (given) => {
      options.push(given);
      return daemon;
    },
  });
  return { main, options };
};

test('UI08 main opens a sandboxed window with a scrubbed engine env', () => {
  const electron = fakeElectron();
  const { options } = start(electron);
  const [window] = electron.windows;
  assert.ok(window);
  assert.deepEqual((window.options as { webPreferences: unknown }).webPreferences, {
    preload: PRELOAD,
    ...WINDOW_SECURITY,
  });
  assert.deepEqual(WINDOW_SECURITY, { contextIsolation: true, nodeIntegration: false, sandbox: true });
  assert.equal(window.url.split('?')[0], PAGE);
  assert.deepEqual(options[0]?.env, { [API_KEY_ENV]: API_KEY, ...HERMETIC_LOCALE });
});

test('UI08 main relays ipc lines from its own window only', async () => {
  const electron = fakeElectron();
  const daemon = fakeDaemon({ ListCampaigns: { ok: true, value: { campaigns: [] } } });
  const { options, main } = start(electron, daemon);
  const list = JSON.stringify({ version: PROTOCOL_VERSION, type: 'ListCampaigns' });
  electron.foreign(CHANNELS.connect);
  electron.foreign(CHANNELS.send, list);
  electron.ipc(CHANNELS.send, { not: 'a line' });
  await flush();
  assert.deepEqual(electron.pushed, []);
  electron.ipc(CHANNELS.connect);
  electron.ipc(CHANNELS.send, list);
  await flush();
  options[0]?.onCrash?.(READY.pid);
  assert.deepEqual(electron.pushed, [
    [CHANNELS.line, JSON.stringify(READY)],
    [CHANNELS.line, JSON.stringify({ type: 'Campaigns', campaigns: [] })],
    [CHANNELS.close, ENGINE_CRASHED],
  ]);
  await main.stop();
  assert.equal(daemon.stopped(), true);
});

const preferencesOf = (electron: ReturnType<typeof fakeElectron>) =>
  new URL(electron.windows[0]?.url ?? PAGE).searchParams.get(PREFERENCES_QUERY);

test('rpg-42a.7 main blocks navigation and new windows', () => {
  const electron = fakeElectron();
  start(electron);
  assert.equal(electron.navigate(), true);
  assert.deepEqual(electron.open(), { action: 'deny' });
});

test('rpg-42a.7 main stops the engine on close and never pushes to a destroyed window', async () => {
  const electron = fakeElectron();
  const daemon = fakeDaemon();
  const { options } = start(electron, daemon);
  electron.destroy();
  options[0]?.onCrash?.(READY.pid);
  assert.deepEqual(electron.pushed, []);
  await flush();
  assert.equal(daemon.stopped(), true);
});

test('UI08 main loads saved preferences and falls back on bad files', () => {
  const path = join(DATA_DIR, PREFERENCES_FILE);
  const saved = fakeElectron({ [path]: JSON.stringify(SENT_PREFERENCES) });
  start(saved);
  assert.equal(preferencesOf(saved), JSON.stringify(SENT_PREFERENCES));
  for (const files of [{}, { [path]: '{broken' }, { [path]: '{"fontScale":"big"}' }]) {
    const electron = fakeElectron(files);
    start(electron);
    assert.equal(preferencesOf(electron), JSON.stringify(DEFAULT_PREFERENCES));
  }
});

test('rpg-42a.39 main follows the system locale until the player saves a language', () => {
  const brazil = fakeElectron();
  start(brazil, fakeDaemon(), undefined, { [LANGUAGE_ENV]: 'pt-BR' });
  assert.equal(JSON.parse(preferencesOf(brazil) ?? '').locale, 'pt-BR');
  const posix = fakeElectron();
  start(posix, fakeDaemon(), undefined, { LANG: 'pt_BR.UTF-8' });
  assert.equal(JSON.parse(preferencesOf(posix) ?? '').locale, 'pt-BR');
  const saved = fakeElectron({ [join(DATA_DIR, PREFERENCES_FILE)]: JSON.stringify({ language: 'es' }) });
  start(saved, fakeDaemon(), undefined, { [LANGUAGE_ENV]: 'pt-BR' });
  assert.equal(JSON.parse(preferencesOf(saved) ?? '').locale, 'es');
});

test('rpg-42a.117 the engine runs in the saved language, not the system locale', () => {
  const saved = fakeElectron({ [join(DATA_DIR, PREFERENCES_FILE)]: JSON.stringify({ language: 'es' }) });
  const { options } = start(saved, fakeDaemon(), undefined, { [LANGUAGE_ENV]: 'pt-BR' });
  assert.equal(options[0]?.env?.[LANGUAGE_ENV], 'es');
  const system = fakeElectron();
  assert.equal(
    start(system, fakeDaemon(), undefined, { [LANGUAGE_ENV]: 'pt-BR' }).options[0]?.env?.[LANGUAGE_ENV],
    'pt-BR',
  );
});

test('UI08 main persists only valid preferences from its window', () => {
  const electron = fakeElectron();
  start(electron);
  electron.foreign(CHANNELS.preferences, SENT_PREFERENCES);
  electron.ipc(CHANNELS.preferences, { fontScale: 'big' });
  assert.deepEqual(electron.written, {});
  electron.ipc(CHANNELS.preferences, SENT_PREFERENCES);
  assert.deepEqual(electron.made, [DATA_DIR]);
  const { locale: _systemLocale, ...unchosen } = SENT_PREFERENCES;
  assert.deepEqual(JSON.parse(electron.written[join(DATA_DIR, PREFERENCES_FILE)] ?? ''), unchosen);
  electron.ipc(CHANNELS.preferences, { ...SENT_PREFERENCES, locale: 'es' });
  assert.equal(JSON.parse(electron.written[join(DATA_DIR, PREFERENCES_FILE)] ?? '').language, 'es');
});

test('rpg-42a.148 a language change reaches the running engine once, not on every preference save', () => {
  const languages: string[] = [];
  const daemon = {
    ...fakeDaemon(),
    language: async (locale: string) => {
      languages.push(locale);
      return { id: 0, type: 'Localized' as const };
    },
  };
  const electron = fakeElectron();
  start(electron, daemon);
  electron.ipc(CHANNELS.preferences, SENT_PREFERENCES);
  assert.deepEqual(languages, []);
  electron.ipc(CHANNELS.preferences, { ...SENT_PREFERENCES, locale: 'es' });
  electron.ipc(CHANNELS.preferences, { ...SENT_PREFERENCES, locale: 'es', fontScale: 1 });
  assert.deepEqual(languages, ['es']);
});

const PARENT_PORT_SHIM = `data:text/javascript,${encodeURIComponent(
  "process.parentPort = { postMessage: (m) => process.send(m), on: (_e, l) => process.on('message', (data) => l({ data })) };",
)}`;

const childUtilityProcess: Fork = (modulePath, args, options) => {
  const child = fork(modulePath, args, { ...options, execArgv: ['--import', PARENT_PORT_SHIM] });
  return {
    get pid() {
      return child.pid;
    },
    postMessage: (message) => child.send(message as object),
    on: (event: string, listener: (...args: unknown[]) => void) => child.on(event, listener),
    kill: () => child.kill(),
  } as UtilityProcessLike;
};

test('rpg-42a.6 the utilityProcess engine channel forks the engine without consumer keys or run-as-node', async (t) => {
  const forked: Parameters<Fork>[] = [];
  const daemon = startDaemon({
    env: { ...hermeticGmEnv(), CLAUDE_CODE_OAUTH_TOKEN: CONSUMER_TOKEN },
    spawnEngine: utilityEngine((...args) => {
      forked.push(args);
      return childUtilityProcess(...args);
    }),
  });
  t.after(() => daemon.stop());
  assert.equal((await daemon.ready()).type, 'Ready');
  assert.equal((await daemon.request('Ping')).type, 'Pong');
  assert.equal(await daemon.stop(), 0);
  const [modulePath, , options] = forked[0] ?? [];
  assert.equal(modulePath, DAEMON_ENTRY);
  assert.deepEqual(
    Object.keys(options?.env ?? {}).filter(
      (key) => key.startsWith(CONSUMER_CREDENTIAL_PREFIX) || key === ELECTRON_RUN_AS_NODE_ENV,
    ),
    [],
  );
});

const SAVED_DRAFT = { path: 'guide', step: 2, name: '', intent: '', choices: { genre: 'fantasy' } };

test('rpg-42a.14 main keeps guided start progress in the app data dir and restores it on reopen', () => {
  const path = join(DATA_DIR, START_DRAFT_FILE);
  const electron = fakeElectron();
  start(electron);
  assert.equal(new URL(electron.windows[0]?.url ?? PAGE).searchParams.get(START_QUERY), JSON.stringify(INITIAL_DRAFT));
  electron.foreign(CHANNELS.start, SAVED_DRAFT);
  electron.ipc(CHANNELS.start, { ...SAVED_DRAFT, path: 'shell' });
  assert.deepEqual(electron.written, {});
  electron.ipc(CHANNELS.start, SAVED_DRAFT);
  assert.deepEqual(JSON.parse(electron.written[path] ?? ''), SAVED_DRAFT);
  for (const [file, expected] of [
    [JSON.stringify(SAVED_DRAFT), SAVED_DRAFT],
    ['{broken', INITIAL_DRAFT],
    [JSON.stringify({ ...SAVED_DRAFT, step: 99 }), INITIAL_DRAFT],
  ] as const) {
    const reopened = fakeElectron({ [path]: file });
    start(reopened);
    const restored = new URL(reopened.windows[0]?.url ?? PAGE).searchParams.get(START_QUERY);
    assert.deepEqual(JSON.parse(restored ?? ''), expected);
  }
});

test('rpg-cm63.7 main serves voice setup to its own window and forwards download progress', async () => {
  const electron = fakeElectron();
  const calls: unknown[][] = [];
  const voice: VoiceHost = {
    prepare: () => undefined,
    check: async () => {
      calls.push(['check']);
      return { providers: [], cacheBytes: 0 };
    },
    download: async (providerId, consent, onProgress) => {
      calls.push(['download', providerId, consent]);
      onProgress(5);
    },
    remove: async (providerId) => {
      calls.push(['remove', providerId]);
    },
    preview: async (request) => {
      calls.push(['preview', request]);
      return { chunks: [], synthesisMs: 0, cacheHit: false };
    },
    clearCache: () => {
      calls.push(['clear']);
    },
  };
  start(electron, fakeDaemon(), voice);
  assert.deepEqual(
    electron.channels().sort(),
    [
      CHANNELS.voiceCheck,
      CHANNELS.voiceClear,
      CHANNELS.voiceDiagnostics,
      CHANNELS.voiceDownload,
      CHANNELS.voicePlayback,
      CHANNELS.voicePreview,
      CHANNELS.voiceRemove,
    ].sort(),
  );
  await assert.rejects(electron.invokeForeign(CHANNELS.voiceCheck));
  await assert.rejects(electron.invokeForeign(CHANNELS.voiceDownload, 'kokoro', {}));
  assert.deepEqual(calls, []);
  assert.deepEqual(await electron.invoke(CHANNELS.voiceCheck), { providers: [], cacheBytes: 0 });
  await electron.invoke(CHANNELS.voiceDownload, 'kokoro', { accepted: true });
  await electron.invoke(CHANNELS.voiceRemove, 'kokoro');
  await electron.invoke(CHANNELS.voicePreview, { providerId: 'kokoro' });
  await electron.invoke(CHANNELS.voiceClear);
  assert.deepEqual(calls, [
    ['check'],
    ['download', 'kokoro', { accepted: true }],
    ['remove', 'kokoro'],
    ['preview', { providerId: 'kokoro' }],
    ['clear'],
  ]);
  assert.deepEqual(electron.pushed, [[CHANNELS.voiceProgress, 5]]);
});

test('rpg-cm63.33 main serves sound downloads and files to its own window only', async () => {
  const electron = fakeElectron();
  const calls: unknown[][] = [];
  const offer = { source: 'https://sounds.example', bytes: 1, sizeMiB: 0 };
  const bytes = new Uint8Array([1]);
  const sound: SoundHost = {
    status: async () => ({ installed: false, bytes: 0, offer }),
    download: async (consent, onProgress) => {
      calls.push(['download', consent]);
      onProgress(3);
    },
    file: async (kind, key) => {
      calls.push(['file', kind, key]);
      return bytes;
    },
  };
  start(electron, fakeDaemon(), undefined, HERMETIC_LOCALE, sound);
  assert.deepEqual(
    electron.channels().sort(),
    [
      CHANNELS.soundDownload,
      CHANNELS.soundFile,
      CHANNELS.soundStatus,
      CHANNELS.voiceDiagnostics,
      CHANNELS.voicePlayback,
    ].sort(),
  );
  await assert.rejects(electron.invokeForeign(CHANNELS.soundStatus));
  await assert.rejects(electron.invokeForeign(CHANNELS.soundDownload, { accepted: true }));
  await assert.rejects(electron.invokeForeign(CHANNELS.soundFile, 'music', 'calm'));
  assert.deepEqual(calls, []);
  assert.deepEqual(await electron.invoke(CHANNELS.soundStatus), { installed: false, bytes: 0, offer });
  await electron.invoke(CHANNELS.soundDownload, { accepted: true });
  assert.equal(await electron.invoke(CHANNELS.soundFile, 'music', 'calm'), bytes);
  assert.deepEqual(calls, [
    ['download', { accepted: true }],
    ['file', 'music', 'calm'],
  ]);
  assert.deepEqual(electron.pushed, [[CHANNELS.soundProgress, 3]]);
});

test('rpg-cm63.17 main forwards only valid playback commands from its own window to the engine', async () => {
  const electron = fakeElectron();
  const forwarded: unknown[] = [];
  const daemon = {
    ...fakeDaemon(),
    playback: async (input: unknown) => {
      forwarded.push(input);
      return { id: 0, type: 'Played' as const };
    },
  };
  start(electron, daemon);
  await assert.rejects(electron.invokeForeign(CHANNELS.voicePlayback, 'pause'));
  assert.equal(await electron.invoke(CHANNELS.voicePlayback, 'pause'), true);
  assert.equal(await electron.invoke(CHANNELS.voicePlayback, 'format-disk'), false);
  assert.equal(await electron.invoke(CHANNELS.voicePlayback, { command: 'stop' }), false);
  assert.deepEqual(forwarded, ['pause']);
});

test('rpg-cm63.40 main relays engine playback events to its window on the sound channel', () => {
  const electron = fakeElectron();
  const { options } = start(electron);
  options[0]?.onSpeaking?.(true);
  options[0]?.onSpeaking?.(false);
  assert.deepEqual(electron.pushed, [
    [CHANNELS.soundSpeaking, true],
    [CHANNELS.soundSpeaking, false],
  ]);
});

test('rpg-cm63.22 main answers a diagnostics request from its own window with the engine speech summary', async () => {
  const electron = fakeElectron();
  const summary = { samples: 2, cacheHitRate: 0, errors: {}, stages: {}, peakQueueDepth: 3 };
  const daemon = { ...fakeDaemon(), diagnostics: async () => ({ id: 0, type: 'Diagnosed' as const, summary }) };
  start(electron, daemon);
  await assert.rejects(electron.invokeForeign(CHANNELS.voiceDiagnostics));
  assert.deepEqual(await electron.invoke(CHANNELS.voiceDiagnostics), summary);
});

test('rpg-cm63.22 main answers a diagnostics request with nothing when the engine has no summary', async () => {
  const electron = fakeElectron();
  start(electron, fakeDaemon());
  assert.equal(await electron.invoke(CHANNELS.voiceDiagnostics), undefined);
});

const showOption = (windows: readonly { options: unknown }[]) =>
  (windows[0]?.options as { show?: boolean } | undefined)?.show;

test('rpg-42a.63 main creates a hidden window only when asked', () => {
  const shown = fakeElectron();
  start(shown);
  assert.equal(showOption(shown.windows), undefined);
  const hidden = fakeElectron();
  startMain({
    ...hidden,
    hidden: true,
    env: HERMETIC_LOCALE,
    dataDir: DATA_DIR,
    preload: PRELOAD,
    page: PAGE,
    startDaemon: () => fakeDaemon(),
  });
  assert.equal(showOption(hidden.windows), false);
});

test('rpg-42a.68 main serves the import channel to its own window only, through an injected dialog', async () => {
  const electron = fakeElectron();
  let dialogs = 0;
  start(electron, fakeDaemon(), undefined, HERMETIC_LOCALE, undefined, async () => {
    dialogs += 1;
    return [];
  });
  assert.ok(electron.channels().includes(CHANNELS.importRulebook));
  await assert.rejects(electron.invokeForeign(CHANNELS.importRulebook, { kind: 'pick', packId: 'd20-lite' }));
  assert.equal(dialogs, 0);
  assert.deepEqual(await electron.invoke(CHANNELS.importRulebook, { kind: 'pick', packId: 'd20-lite' }), {
    status: 'cancelled',
  });
  assert.equal(dialogs, 1);
});

test('rpg-42a.68 main registers no import channel without a dialog', () => {
  const electron = fakeElectron();
  start(electron);
  assert.equal(electron.channels().includes(CHANNELS.importRulebook), false);
});
