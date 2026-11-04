import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMicrophoneController,
  type MicrophoneDevice,
  type MicrophonePermission,
  type MicrophoneSource,
  type MicrophoneState,
  type MicrophoneStream,
} from './microphone.ts';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from './voice.ts';

const BUILT_IN: MicrophoneDevice = { id: 'built-in', label: 'Built-in Microphone', isDefault: true };
const HEADSET: MicrophoneDevice = { id: 'headset', label: 'USB Headset', isDefault: false };
const DOCK: MicrophoneDevice = { id: 'dock', label: 'Dock Microphone', isDefault: false };
const CHUNK = new Uint8Array([1, 2, 3]);
const UNKNOWN_DEVICE_ID = 'missing';
const DEVICE_BUSY = 'device busy';
const STOPPED: MicrophoneState = { kind: 'typed-input-only', reason: 'stopped' };

const CONSENTED: VoiceSettings = {
  microphone: 'push-to-talk',
  spokenOutput: 'off',
  consent: { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: ['local-stt'] },
};

interface FakeSource extends MicrophoneSource {
  devices: MicrophoneDevice[];
  readonly opened: string[];
  readonly closed: string[];
  permissionRequests: number;
  readonly failingIds: Set<string>;
  closeThrows: boolean;
  subscribed(): boolean;
  fireDeviceChange(): Promise<void>;
  changeDevices(next: MicrophoneDevice[]): Promise<void>;
}

const fakeSource = (
  devices: MicrophoneDevice[],
  permission: () => Promise<MicrophonePermission> = async () => 'granted',
): FakeSource => {
  let listener: (() => Promise<void>) | undefined;
  const source: FakeSource = {
    devices,
    opened: [],
    closed: [],
    permissionRequests: 0,
    failingIds: new Set(),
    closeThrows: false,
    subscribed: () => listener !== undefined,
    fireDeviceChange: async () => listener?.(),
    async requestPermission() {
      source.permissionRequests += 1;
      return permission();
    },
    async listDevices() {
      return source.devices;
    },
    async open(deviceId: string): Promise<MicrophoneStream> {
      if (source.failingIds.has(deviceId)) throw new Error(DEVICE_BUSY);
      source.opened.push(deviceId);
      return {
        chunks: (async function* () {
          yield CHUNK;
        })(),
        close: () => {
          source.closed.push(deviceId);
          if (source.closeThrows) throw new Error(DEVICE_BUSY);
        },
      };
    },
    onDeviceChange(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async changeDevices(next) {
      source.devices = next;
      await listener?.();
    },
  };
  return source;
};

const firstChunk = async (stream: MicrophoneStream | undefined): Promise<Uint8Array | undefined> => {
  if (!stream) return undefined;
  for await (const chunk of stream.chunks) return chunk;
  return undefined;
};

test('A02: request consent, capture mic input, display state and handle device changes', async () => {
  const source = fakeSource([BUILT_IN, HEADSET]);
  const seen: MicrophoneState[] = [];
  const mic = createMicrophoneController(source, CONSENTED, (state) => seen.push(state));

  const started = await mic.start();
  assert.equal(source.permissionRequests, 1);
  assert.deepEqual(started, { kind: 'capturing', device: BUILT_IN, devices: [BUILT_IN, HEADSET] });
  assert.deepEqual(await firstChunk(mic.stream()), CHUNK);

  const switched = await mic.select(HEADSET.id);
  assert.equal(switched.kind === 'capturing' && switched.device.id, HEADSET.id);
  assert.deepEqual(source.closed, [BUILT_IN.id]);

  await source.changeDevices([BUILT_IN, HEADSET, DOCK]);
  assert.deepEqual(mic.state(), { kind: 'capturing', device: HEADSET, devices: [BUILT_IN, HEADSET, DOCK] });

  await source.changeDevices([BUILT_IN, DOCK]);
  assert.deepEqual(mic.state(), { kind: 'capturing', device: BUILT_IN, devices: [BUILT_IN, DOCK] });
  assert.deepEqual(source.opened, [BUILT_IN.id, HEADSET.id, BUILT_IN.id]);
  assert.deepEqual(seen.at(-1), mic.state());

  mic.stop();
  assert.deepEqual(mic.state(), { kind: 'typed-input-only', reason: 'stopped' });
  assert.equal(mic.stream(), undefined);
});

test('A02: permission denial falls back to typing without crash', async () => {
  const denied = fakeSource([BUILT_IN], async () => 'denied');
  const deniedMic = createMicrophoneController(denied, CONSENTED);
  assert.deepEqual(await deniedMic.start(), { kind: 'typed-input-only', reason: 'permission-denied' });
  assert.deepEqual(denied.opened, []);

  const throwing = fakeSource([BUILT_IN], async () => {
    throw new Error('NotAllowedError');
  });
  const throwingMic = createMicrophoneController(throwing, CONSENTED);
  assert.deepEqual(await throwingMic.start(), { kind: 'typed-input-only', reason: 'permission-denied' });
  assert.equal(throwingMic.stream(), undefined);
});

test('A02: no consent means no permission request and no capture', async () => {
  const source = fakeSource([BUILT_IN]);
  const offMic = createMicrophoneController(source, DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(await offMic.start(), { kind: 'typed-input-only', reason: 'no-consent' });

  const micOff = createMicrophoneController(source, { ...CONSENTED, microphone: 'off', spokenOutput: 'narrator' });
  assert.deepEqual(await micOff.start(), { kind: 'typed-input-only', reason: 'no-consent' });
  assert.equal(source.permissionRequests, 0);
  assert.deepEqual(source.opened, []);
});

test('A02: removing every device falls back to typed input without throwing', async () => {
  const source = fakeSource([HEADSET]);
  const mic = createMicrophoneController(source, CONSENTED);
  assert.equal((await mic.start()).kind, 'capturing');

  await source.changeDevices([]);
  assert.deepEqual(mic.state(), { kind: 'typed-input-only', reason: 'no-device' });
  assert.deepEqual(source.closed, [HEADSET.id]);

  await source.changeDevices([DOCK]);
  assert.deepEqual(mic.state(), { kind: 'capturing', device: DOCK, devices: [DOCK] });
});

test('A02: failing to open a device falls back to typed input', async () => {
  const source = fakeSource([BUILT_IN]);
  source.failingIds.add(BUILT_IN.id);
  const mic = createMicrophoneController(source, CONSENTED);
  assert.deepEqual(await mic.start(), { kind: 'typed-input-only', reason: 'device-error' });
});

test('A02: unknown device id is rejected and capture continues', async () => {
  const source = fakeSource([BUILT_IN]);
  const mic = createMicrophoneController(source, CONSENTED);
  await mic.start();
  await assert.rejects(mic.select(UNKNOWN_DEVICE_ID), RangeError);
  assert.deepEqual(mic.state(), { kind: 'capturing', device: BUILT_IN, devices: [BUILT_IN] });
  assert.deepEqual(source.opened, [BUILT_IN.id]);
});

test('A02: selecting a device before consent and permission does not capture', async () => {
  const source = fakeSource([BUILT_IN]);
  const mic = createMicrophoneController(source, DEFAULT_VOICE_SETTINGS);
  await mic.start();
  assert.deepEqual(await mic.select(BUILT_IN.id), { kind: 'typed-input-only', reason: 'no-consent' });
  assert.deepEqual(source.opened, []);
});

test('A02: stop during a pending permission request opens nothing', async () => {
  let grant: (permission: MicrophonePermission) => void = () => {};
  const source = fakeSource([BUILT_IN], () => new Promise((resolve) => (grant = resolve)));
  const mic = createMicrophoneController(source, CONSENTED);
  const starting = mic.start();
  mic.stop();
  grant('granted');
  assert.deepEqual(await starting, STOPPED);
  assert.deepEqual(mic.state(), STOPPED);
  assert.deepEqual(source.opened, []);
  assert.equal(source.subscribed(), false);
});

test('A02: overlapping device-change refreshes close every opened stream', async () => {
  const source = fakeSource([]);
  const mic = createMicrophoneController(source, CONSENTED);
  await mic.start();
  source.devices = [BUILT_IN];
  await Promise.all([source.fireDeviceChange(), source.fireDeviceChange()]);
  assert.deepEqual(mic.state(), { kind: 'capturing', device: BUILT_IN, devices: [BUILT_IN] });
  mic.stop();
  assert.equal(source.opened.length, source.closed.length);
});

test('A02: select overlapping a device-change refresh closes every opened stream', async () => {
  const source = fakeSource([BUILT_IN, HEADSET]);
  const mic = createMicrophoneController(source, CONSENTED);
  await mic.start();
  source.devices = [HEADSET];
  await Promise.all([mic.select(HEADSET.id), source.fireDeviceChange()]);
  assert.equal(mic.state().kind, 'capturing');
  mic.stop();
  assert.equal(source.opened.length, source.closed.length);
});

test('A02: failing to open a selected device keeps the working stream', async () => {
  const source = fakeSource([BUILT_IN, HEADSET]);
  const mic = createMicrophoneController(source, CONSENTED);
  await mic.start();
  const working = mic.stream();
  source.failingIds.add(HEADSET.id);
  assert.deepEqual(await mic.select(HEADSET.id), { kind: 'capturing', device: BUILT_IN, devices: [BUILT_IN, HEADSET] });
  assert.equal(mic.stream(), working);
  assert.deepEqual(source.closed, []);
});

test('A02: stop clears the stream and publishes state when close throws', async () => {
  const source = fakeSource([BUILT_IN]);
  const seen: MicrophoneState[] = [];
  const mic = createMicrophoneController(source, CONSENTED, (state) => seen.push(state));
  await mic.start();
  source.closeThrows = true;
  assert.doesNotThrow(() => mic.stop());
  assert.equal(mic.stream(), undefined);
  assert.deepEqual(seen.at(-1), STOPPED);
});
