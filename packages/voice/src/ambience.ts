import type { PlaybackEvent } from './playback.ts';

export const MIN_CHANNEL_VOLUME = 0;
export const MAX_CHANNEL_VOLUME = 1;
export const DEFAULT_CHANNEL_VOLUME = 1;
export const DUCK_FACTOR = 0.3;

export type AudioChannel = 'narration' | 'dialogue' | 'ambience' | 'effects';
type BackgroundChannel = Extract<AudioChannel, 'ambience' | 'effects'>;

export interface AmbientSink {
  setVolume(layerId: string, volume: number): void;
  start(layerId: string): void;
  stop(layerId: string): void;
}

export interface AmbienceState {
  readonly silenced: boolean;
  readonly ducked: boolean;
  readonly effectsEnabled: boolean;
  readonly volumes: Readonly<Record<AudioChannel, number>>;
  readonly active: readonly string[];
}

export interface AmbienceMixerDeps {
  readonly sink: AmbientSink;
  readonly onChange: (state: AmbienceState) => void;
}

export interface AmbienceMixer {
  selectAmbience(layerId: string): void;
  deselectAmbience(layerId: string): void;
  enableEffects(enabled: boolean): void;
  effect(effectId: string): void;
  setVolume(channel: AudioChannel, volume: number): void;
  volume(channel: AudioChannel): number;
  setSilence(silenced: boolean): void;
  onPlaybackEvent(event: PlaybackEvent): void;
  state(): AmbienceState;
}

const assertVolume = (volume: number): void => {
  if (!Number.isFinite(volume) || volume < MIN_CHANNEL_VOLUME || volume > MAX_CHANNEL_VOLUME) {
    throw new RangeError(`volume must be a finite number in [${MIN_CHANNEL_VOLUME}, ${MAX_CHANNEL_VOLUME}]`);
  }
};

export const createAmbienceMixer = (deps: AmbienceMixerDeps): AmbienceMixer => {
  const volumes: Record<AudioChannel, number> = {
    narration: DEFAULT_CHANNEL_VOLUME,
    dialogue: DEFAULT_CHANNEL_VOLUME,
    ambience: DEFAULT_CHANNEL_VOLUME,
    effects: DEFAULT_CHANNEL_VOLUME,
  };
  const active = new Map<string, BackgroundChannel>();
  let silenced = false;
  let ducked = false;
  let effectsEnabled = false;

  const state = (): AmbienceState => ({
    silenced,
    ducked,
    effectsEnabled,
    volumes: { ...volumes },
    active: [...active.keys()],
  });

  const effectiveVolume = (channel: BackgroundChannel): number =>
    ducked ? Math.min(volumes[channel], volumes.narration, volumes.dialogue) * DUCK_FACTOR : volumes[channel];

  const applyVolumes = (): void => {
    for (const [layerId, channel] of active) deps.sink.setVolume(layerId, effectiveVolume(channel));
  };

  const start = (layerId: string, channel: BackgroundChannel): void => {
    if (silenced) return;
    active.set(layerId, channel);
    deps.sink.setVolume(layerId, effectiveVolume(channel));
    deps.sink.start(layerId);
    deps.onChange(state());
  };

  const stopWhere = (matches: (layerId: string, channel: BackgroundChannel) => boolean): void => {
    for (const [layerId, channel] of active) {
      if (!matches(layerId, channel)) continue;
      active.delete(layerId);
      deps.sink.stop(layerId);
    }
  };

  const setDucked = (next: boolean): void => {
    if (ducked === next) return;
    ducked = next;
    applyVolumes();
    deps.onChange(state());
  };

  return {
    selectAmbience: (layerId) => start(layerId, 'ambience'),
    deselectAmbience(layerId) {
      stopWhere((id) => id === layerId);
      deps.onChange(state());
    },
    enableEffects(enabled) {
      effectsEnabled = enabled;
      if (!enabled) stopWhere((_, channel) => channel === 'effects');
      deps.onChange(state());
    },
    effect(effectId) {
      if (effectsEnabled) start(effectId, 'effects');
    },
    setVolume(channel, volume) {
      assertVolume(volume);
      volumes[channel] = volume;
      applyVolumes();
      deps.onChange(state());
    },
    volume: (channel) => volumes[channel],
    setSilence(next) {
      silenced = next;
      if (next) {
        effectsEnabled = false;
        stopWhere(() => true);
      }
      deps.onChange(state());
    },
    onPlaybackEvent(event) {
      setDucked(event.kind === 'subtitle' && event.state === 'start');
    },
    state,
  };
};
