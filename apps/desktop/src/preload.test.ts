import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_DRAFT } from '../../../packages/client-protocol/src/guided-start.ts';
import { DEFAULT_PREFERENCES } from './accessibility.ts';
import { BRIDGE_KEY, type Bridge, CHANNELS, exposeBridge } from './preload.ts';

const LINE = '{"type":"Ready"}';
const ERROR = 'Engine crashed.';
const EVENT = { sender: 'secret' };

const fakeIpc = () => {
  const sent: unknown[][] = [];
  const invoked: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    sent,
    invoked,
    emit: (channel: string, ...args: unknown[]) => listeners.get(channel)?.(EVENT, ...args),
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args]);
      },
      invoke: async (channel: string, ...args: unknown[]) => {
        invoked.push([channel, ...args]);
        return channel;
      },
      on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      },
    },
  };
};

const expose = () => {
  const ipc = fakeIpc();
  const exposed = new Map<string, Bridge>();
  exposeBridge({
    contextBridge: { exposeInMainWorld: (key, api) => exposed.set(key, api) },
    ipcRenderer: ipc.ipcRenderer,
  });
  const bridge = exposed.get(BRIDGE_KEY);
  assert.ok(bridge);
  return { ...ipc, bridge, keys: [...exposed.keys()] };
};

test('UI08 preload exposes only the narrow transport bridge', () => {
  const { bridge, keys } = expose();
  assert.deepEqual(keys, [BRIDGE_KEY]);
  assert.deepEqual(Object.keys(bridge).sort(), [
    'connect',
    'onClose',
    'onLine',
    'savePreferences',
    'saveStart',
    'send',
    'voice',
  ]);
  assert.deepEqual(Object.keys(bridge.voice).sort(), [
    'check',
    'clearCache',
    'download',
    'onProgress',
    'preview',
    'remove',
  ]);
});

test('UI08 preload forwards lines without leaking the ipc event', () => {
  const { bridge, sent, emit } = expose();
  const lines: unknown[][] = [];
  const closes: unknown[][] = [];
  bridge.onLine((...args) => lines.push(args));
  bridge.onClose((...args) => closes.push(args));
  bridge.connect();
  bridge.send(LINE);
  bridge.savePreferences(DEFAULT_PREFERENCES);
  bridge.saveStart(INITIAL_DRAFT);
  emit(CHANNELS.line, LINE);
  emit(CHANNELS.close, ERROR);
  assert.deepEqual(sent, [
    [CHANNELS.connect],
    [CHANNELS.send, LINE],
    [CHANNELS.preferences, DEFAULT_PREFERENCES],
    [CHANNELS.start, INITIAL_DRAFT],
  ]);
  assert.deepEqual(lines, [[LINE]]);
  assert.deepEqual(closes, [[ERROR]]);
});

test('rpg-cm63.7 preload voice bridge invokes narrow channels and forwards only progress bytes', async () => {
  const { bridge, invoked, emit } = expose();
  const consent = { accepted: true, source: 'https://models.example', bytes: 1, sizeMiB: 0 } as const;
  const request = { providerId: 'kokoro', voiceId: 'af_heart', language: 'en', speed: 1 };
  const progress: unknown[][] = [];
  bridge.voice.onProgress((...args) => progress.push(args));
  assert.equal(await bridge.voice.check(), CHANNELS.voiceCheck);
  await bridge.voice.download('kokoro', consent);
  await bridge.voice.remove('kokoro');
  await bridge.voice.preview(request);
  await bridge.voice.clearCache();
  emit(CHANNELS.voiceProgress, 7);
  assert.deepEqual(invoked, [
    [CHANNELS.voiceCheck],
    [CHANNELS.voiceDownload, 'kokoro', consent],
    [CHANNELS.voiceRemove, 'kokoro'],
    [CHANNELS.voicePreview, request],
    [CHANNELS.voiceClear],
  ]);
  assert.deepEqual(progress, [[7]]);
});
