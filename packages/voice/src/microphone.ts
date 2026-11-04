import { resolveVoiceMode, type VoiceSettings } from './voice.ts';

export interface MicrophoneDevice {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export type MicrophonePermission = 'granted' | 'denied';

export interface MicrophoneStream {
  readonly chunks: AsyncIterable<Uint8Array>;
  close(): void;
}

export interface MicrophoneSource {
  requestPermission(): Promise<MicrophonePermission>;
  listDevices(): Promise<readonly MicrophoneDevice[]>;
  open(deviceId: string): Promise<MicrophoneStream>;
  onDeviceChange(listener: () => Promise<void>): () => void;
}

export type TypedFallbackReason = 'no-consent' | 'permission-denied' | 'no-device' | 'device-error' | 'stopped';

export type MicrophoneState =
  | { readonly kind: 'typed-input-only'; readonly reason: TypedFallbackReason }
  | {
      readonly kind: 'capturing';
      readonly device: MicrophoneDevice;
      readonly devices: readonly MicrophoneDevice[];
    };

export interface MicrophoneController {
  start(): Promise<MicrophoneState>;
  select(deviceId: string): Promise<MicrophoneState>;
  state(): MicrophoneState;
  stream(): MicrophoneStream | undefined;
  stop(): void;
}

const GRANTED: MicrophonePermission = 'granted';
const UNKNOWN_DEVICE = 'unknown microphone device';

const typedOnly = (reason: TypedFallbackReason): MicrophoneState => ({ kind: 'typed-input-only', reason });

const microphoneConsented = (settings: VoiceSettings): boolean => {
  const mode = resolveVoiceMode(settings);
  return mode.kind === 'voice' && mode.microphone !== 'off';
};

const askPermission = async (source: MicrophoneSource): Promise<boolean> => {
  try {
    return (await source.requestPermission()) === GRANTED;
  } catch {
    return false;
  }
};

const closeQuietly = (stream: MicrophoneStream | undefined): void => {
  try {
    stream?.close();
  } catch {
    return;
  }
};

const preferredDevice = (devices: readonly MicrophoneDevice[]): MicrophoneDevice | undefined =>
  devices.find((device) => device.isDefault) ?? devices[0];

export const createMicrophoneController = (
  source: MicrophoneSource,
  settings: VoiceSettings,
  onState: (state: MicrophoneState) => void = () => {},
): MicrophoneController => {
  let current: MicrophoneState = typedOnly('stopped');
  let active: MicrophoneStream | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;

  const isStale = (token: number): boolean => token !== generation;

  const publish = (next: MicrophoneState): MicrophoneState => {
    current = next;
    onState(next);
    return next;
  };

  const release = (): void => {
    const stream = active;
    active = undefined;
    closeQuietly(stream);
  };

  const selectedId = (): string | undefined => (current.kind === 'capturing' ? current.device.id : undefined);

  const findSelected = (devices: readonly MicrophoneDevice[]): MicrophoneDevice | undefined => {
    const id = selectedId();
    return devices.find((device) => device.id === id);
  };

  const capture = async (
    token: number,
    device: MicrophoneDevice,
    devices: readonly MicrophoneDevice[],
  ): Promise<MicrophoneState> => {
    let opened: MicrophoneStream;
    try {
      opened = await source.open(device.id);
    } catch {
      if (isStale(token) || findSelected(devices)) return current;
      release();
      return publish(typedOnly('device-error'));
    }
    if (isStale(token)) {
      closeQuietly(opened);
      return current;
    }
    release();
    active = opened;
    return publish({ kind: 'capturing', device, devices });
  };

  const listDevices = async (): Promise<readonly MicrophoneDevice[]> => {
    try {
      return await source.listDevices();
    } catch {
      return [];
    }
  };

  const refresh = async (token: number): Promise<void> => {
    const devices = await listDevices();
    if (isStale(token)) return;
    const kept = findSelected(devices);
    if (kept) {
      publish({ kind: 'capturing', device: kept, devices });
      return;
    }
    const fallback = preferredDevice(devices);
    if (!fallback) {
      release();
      publish(typedOnly('no-device'));
      return;
    }
    await capture(token, fallback, devices);
  };

  const onDeviceChange = (): Promise<void> => refresh(++generation);

  return {
    async start() {
      const token = ++generation;
      if (!microphoneConsented(settings)) return publish(typedOnly('no-consent'));
      const granted = await askPermission(source);
      if (isStale(token)) return current;
      if (!granted) return publish(typedOnly('permission-denied'));
      unsubscribe ??= source.onDeviceChange(onDeviceChange);
      await refresh(token);
      return current;
    },
    async select(deviceId) {
      if (!unsubscribe) return current;
      const token = ++generation;
      const devices = await listDevices();
      if (isStale(token)) return current;
      const device = devices.find((candidate) => candidate.id === deviceId);
      if (!device) throw new RangeError(`${UNKNOWN_DEVICE}: ${deviceId}`);
      return capture(token, device, devices);
    },
    state: () => current,
    stream: () => active,
    stop() {
      generation += 1;
      unsubscribe?.();
      unsubscribe = undefined;
      release();
      publish(typedOnly('stopped'));
    },
  };
};
