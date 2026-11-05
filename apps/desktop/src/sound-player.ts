import type { AmbientSink } from '../../../packages/voice/src/ambience.ts';
import type { ModelConsent } from '../../../packages/voice/src/kokoro-model.ts';
import {
  createSoundController,
  type SoundClock,
  type SoundController,
} from '../../../packages/voice/src/sound-controller.ts';
import { type SceneSoundInput, sceneSoundOf } from '../../../packages/voice/src/sound-selection.ts';
import { type SoundSettings, soundEnabled } from '../../../packages/voice/src/sound-settings.ts';
import type { SoundHostStatus } from './sound-host.ts';

export type SoundBridge = {
  status(): Promise<SoundHostStatus>;
  download(consent: ModelConsent): Promise<void>;
  file(kind: string, key: string): Promise<Uint8Array | undefined>;
  onProgress(listener: (bytes: number) => void): void;
  onSpeaking(listener: (active: boolean) => void): void;
};

type GainLike = { readonly gain: { value: number }; connect(target: unknown): unknown; disconnect(): void };
type SourceLike = {
  buffer: unknown;
  loop: boolean;
  connect(target: unknown): unknown;
  start(): void;
  stop(): void;
  disconnect(): void;
};
export type SoundAudioContext = {
  readonly destination: unknown;
  resume(): Promise<void>;
  close?(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<unknown>;
  createGain(): GainLike;
  createBufferSource(): SourceLike;
};

export type WebAudioSink = AmbientSink & { dispose(): void };
export type DesktopSound = {
  update(settings: SoundSettings, scene: SceneSoundInput | undefined): void;
  speaking(active: boolean): void;
  refresh(): Promise<void>;
  dispose(): void;
};

type Layer = { gain?: GainLike; source?: SourceLike };

const LAYER_SEPARATOR = ':';
const ONE_SHOT_KIND = 'effect';
const SILENT = 0;

const browserClock: SoundClock = {
  now: () => Date.now(),
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

export const createWebAudioSink = ({
  context,
  load,
}: {
  readonly context: () => SoundAudioContext;
  readonly load: (kind: string, key: string) => Promise<Uint8Array | undefined>;
}): WebAudioSink => {
  const volumes = new Map<string, number>();
  const layers = new Map<string, Layer>();
  let audio: SoundAudioContext | undefined;

  const play = async (id: string, layer: Layer): Promise<void> => {
    audio ??= context();
    await audio.resume();
    const split = id.indexOf(LAYER_SEPARATOR);
    const kind = id.slice(0, split);
    const file = await load(kind, id.slice(split + 1));
    if (file === undefined || layers.get(id) !== layer) return;
    const buffer = await audio.decodeAudioData(file.slice().buffer);
    if (layers.get(id) !== layer) return;
    const gain = audio.createGain();
    gain.gain.value = volumes.get(id) ?? SILENT;
    gain.connect(audio.destination);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = kind !== ONE_SHOT_KIND;
    source.connect(gain);
    source.start();
    layer.gain = gain;
    layer.source = source;
  };

  const stop = (id: string): void => {
    const layer = layers.get(id);
    layers.delete(id);
    volumes.delete(id);
    layer?.source?.stop();
    layer?.source?.disconnect();
    layer?.gain?.disconnect();
  };

  return {
    setVolume: (id, volume) => {
      volumes.set(id, volume);
      const gain = layers.get(id)?.gain;
      if (gain !== undefined) gain.gain.value = volume;
    },
    start: (id) => {
      if (layers.has(id)) return;
      const layer: Layer = {};
      layers.set(id, layer);
      play(id, layer).catch(() => undefined);
    },
    stop,
    dispose: () => {
      for (const id of [...layers.keys()]) stop(id);
      audio?.close?.().catch(() => undefined);
      audio = undefined;
    },
  };
};

export const sceneSoundInput = sceneSoundOf;

export const createDesktopSound = ({
  bridge,
  context = () => new AudioContext(),
  clock = browserClock,
}: {
  readonly bridge: Pick<SoundBridge, 'status' | 'file'> & Partial<Pick<SoundBridge, 'onSpeaking'>>;
  readonly context?: () => SoundAudioContext;
  readonly clock?: SoundClock;
}): DesktopSound => {
  let running: { readonly controller: SoundController; readonly sink: WebAudioSink } | undefined;
  let installed = false;
  let silenced = false;
  let talking = false;
  let narrating = false;
  let settings: SoundSettings | undefined;
  let scene: SceneSoundInput | undefined;

  const sync = (): void => {
    if (running === undefined || settings === undefined) return;
    const { controller } = running;
    controller.apply(settings);
    if (scene !== undefined) controller.setScene(scene);
    if (silenced === (scene === undefined)) return;
    silenced = scene === undefined;
    controller.setSilence(silenced);
  };

  const checkInstalled = (started: NonNullable<typeof running>): Promise<void> =>
    bridge
      .status()
      .then(({ installed: present }) => present)
      .catch(() => false)
      .then((present) => {
        if (running !== started) return;
        installed = present;
        sync();
      });

  const start = (): void => {
    const sink = createWebAudioSink({
      context,
      load: (kind, key) => bridge.file(kind, key).catch(() => undefined),
    });
    const controller = createSoundController({ sink, clock, available: () => installed });
    const started = { controller, sink };
    running = started;
    silenced = false;
    controller.speaking(talking || narrating);
    void checkInstalled(started);
  };

  const stop = (): void => {
    running?.controller.dispose();
    running?.sink.dispose();
    running = undefined;
  };

  bridge.onSpeaking?.((active) => {
    narrating = active;
    running?.controller.speaking(talking || narrating);
  });

  return {
    update: (nextSettings, nextScene) => {
      settings = nextSettings;
      scene = nextScene;
      if (!soundEnabled(nextSettings)) return stop();
      if (running === undefined) start();
      sync();
    },
    speaking: (active) => {
      talking = active;
      running?.controller.speaking(talking || narrating);
    },
    refresh: async () => {
      if (running !== undefined) await checkInstalled(running);
    },
    dispose: stop,
  };
};
