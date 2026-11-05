import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { INITIAL_DRAFT, START_DRAFT_FILE } from '../../../packages/client-protocol/src/guided-start.ts';
import { type ClientEvent, EVENT_COMMITTED, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { API_KEY_ENV, type DaemonOptions } from '../../cli/src/desktop-daemon.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE } from './accessibility.ts';
import { type Daemon, daemonTransport, ENGINE_CRASHED, PREFERENCES_FILE, startMain, WINDOW_SECURITY } from './main.ts';
import { CHANNELS, PREFERENCES_QUERY, START_QUERY } from './preload.ts';

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
  const ipcMain = {
    on: (channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void) => {
      handlers.set(channel, listener);
    },
  };
  const ipc = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: webContents }, ...args);
  const foreign = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
  return {
    BrowserWindow,
    ipcMain,
    fs,
    ipc,
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

const start = (electron: ReturnType<typeof fakeElectron>, daemon = fakeDaemon()) => {
  const options: DaemonOptions[] = [];
  const main = startMain({
    ...electron,
    env: { [API_KEY_ENV]: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: CONSUMER_TOKEN },
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
  assert.deepEqual(options[0]?.env, { [API_KEY_ENV]: API_KEY });
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

test('UI08 main persists only valid preferences from its window', () => {
  const electron = fakeElectron();
  start(electron);
  electron.foreign(CHANNELS.preferences, SENT_PREFERENCES);
  electron.ipc(CHANNELS.preferences, { fontScale: 'big' });
  assert.deepEqual(electron.written, {});
  electron.ipc(CHANNELS.preferences, SENT_PREFERENCES);
  assert.deepEqual(electron.made, [DATA_DIR]);
  assert.deepEqual(JSON.parse(electron.written[join(DATA_DIR, PREFERENCES_FILE)] ?? ''), SENT_PREFERENCES);
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
