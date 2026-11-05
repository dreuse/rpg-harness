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
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    sent,
    emit: (channel: string, ...args: unknown[]) => listeners.get(channel)?.(EVENT, ...args),
    ipcRenderer: {
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args]);
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
