import { type AmbienceState, type AmbientSink, createAmbienceMixer } from './ambience.ts';
import type { PlaybackEvent } from './playback.ts';
import type { SoundKind } from './sound-manifest.ts';
import { type SceneSoundInput, type SoundTableExtension, selectSounds } from './sound-selection.ts';
import { DEFAULT_SOUND_SETTINGS, SOUND_CHANNELS, type SoundSettings } from './sound-settings.ts';

export const CROSSFADE_MS = 2000;
export const FADE_TICK_MS = 50;

export interface SoundClock {
  now(): number;
  every(fn: () => void, ms: number): () => void;
}

export interface SoundControllerDeps {
  readonly sink: AmbientSink;
  readonly clock: SoundClock;
  readonly available?: (kind: SoundKind, key: string) => boolean;
  readonly table?: SoundTableExtension;
}

export interface SoundControllerState {
  readonly layers: AmbienceState['active'];
  readonly silenced: boolean;
}

export interface SoundController {
  setScene(scene: SceneSoundInput): void;
  apply(settings: SoundSettings): void;
  speaking(active: boolean): void;
  effect(key: string): void;
  setSilence(silenced: boolean): void;
  state(): SoundControllerState;
  dispose(): void;
}

interface Fade {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
}

const SLOTS = ['ambience', 'music'] as const;
type Slot = (typeof SLOTS)[number];

const FULL = 1;
const SILENT = 0;
const SPEECH_FIELDS = { kind: 'subtitle', utteranceEventId: '', speakerId: '', text: '' } as const;
const SPEECH_EVENTS: Readonly<Record<'start' | 'end', PlaybackEvent>> = {
  start: { ...SPEECH_FIELDS, state: 'start' },
  end: { ...SPEECH_FIELDS, state: 'end' },
};

export const systemClock: SoundClock = {
  now: () => Date.now(),
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

export const layerId = (kind: SoundKind, key: string): string => `${kind}:${key}`;

export const createSoundController = ({
  sink,
  clock,
  available = () => true,
  table = {},
}: SoundControllerDeps): SoundController => {
  const base = new Map<string, number>();
  const gain = new Map<string, number>();
  const fades = new Map<string, Fade>();
  const current: Partial<Record<Slot, string | undefined>> = {};
  let settings = DEFAULT_SOUND_SETTINGS;
  let scene: SceneSoundInput | undefined;
  let silenced = false;
  let cancelTick: (() => void) | undefined;

  const forward = (id: string): void => sink.setVolume(id, (base.get(id) ?? SILENT) * (gain.get(id) ?? FULL));

  const mixer = createAmbienceMixer({
    sink: {
      setVolume: (id, volume) => {
        base.set(id, volume);
        forward(id);
      },
      start: (id) => sink.start(id),
      stop: (id) => {
        base.delete(id);
        gain.delete(id);
        fades.delete(id);
        sink.stop(id);
      },
    },
    onChange: () => undefined,
  });

  const stopTick = (): void => {
    cancelTick?.();
    cancelTick = undefined;
  };

  const tick = (): void => {
    for (const [id, { from, to, startedAt }] of fades) {
      const progress = Math.min(FULL, (clock.now() - startedAt) / CROSSFADE_MS);
      gain.set(id, from + (to - from) * progress);
      forward(id);
      if (progress < FULL) continue;
      fades.delete(id);
      if (to === SILENT) mixer.deselectAmbience(id);
    }
    if (fades.size === 0) stopTick();
  };

  const fade = (id: string, to: number): void => {
    fades.set(id, { from: gain.get(id) ?? FULL, to, startedAt: clock.now() });
    cancelTick ??= clock.every(tick, FADE_TICK_MS);
  };

  const wanted = (slot: Slot): string | undefined => {
    if (silenced || scene === undefined || !settings[slot].enabled) return undefined;
    const key = selectSounds(scene, table)[slot];
    return key !== undefined && available(slot, key) ? layerId(slot, key) : undefined;
  };

  const startLayer = (slot: Slot, id: string): void => {
    if (mixer.state().active.includes(id)) return;
    gain.set(id, SILENT);
    if (slot === 'music') mixer.selectMusic(id);
    else mixer.selectAmbience(id);
  };

  const refresh = (): void => {
    for (const slot of SLOTS) {
      const next = wanted(slot);
      const previous = current[slot];
      if (next === previous) continue;
      if (previous !== undefined) fade(previous, SILENT);
      if (next !== undefined) {
        startLayer(slot, next);
        fade(next, FULL);
      }
      current[slot] = next;
    }
  };

  return {
    setScene(next) {
      scene = next;
      refresh();
    },
    apply(next) {
      settings = next;
      for (const channel of SOUND_CHANNELS) mixer.setVolume(channel, next[channel].volume);
      mixer.enableEffects(!silenced && next.effects.enabled);
      refresh();
    },
    speaking: (active) => mixer.onPlaybackEvent(SPEECH_EVENTS[active ? 'start' : 'end']),
    effect(key) {
      if (silenced || !settings.effects.enabled || !available('effect', key)) return;
      mixer.effect(layerId('effect', key));
    },
    setSilence(next) {
      silenced = next;
      mixer.setSilence(next);
      mixer.enableEffects(!next && settings.effects.enabled);
      for (const slot of SLOTS) delete current[slot];
      if (next) stopTick();
      else refresh();
    },
    state: () => ({ layers: mixer.state().active, silenced }),
    dispose() {
      stopTick();
      for (const id of mixer.state().active) mixer.deselectAmbience(id);
      for (const slot of SLOTS) delete current[slot];
    },
  };
};
