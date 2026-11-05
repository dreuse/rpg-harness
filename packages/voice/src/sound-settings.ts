import { MAX_CHANNEL_VOLUME, MIN_CHANNEL_VOLUME } from './ambience.ts';

export const SOUND_CHANNELS = ['ambience', 'effects', 'music'] as const;
export type SoundChannel = (typeof SOUND_CHANNELS)[number];

export interface ChannelSetting {
  readonly enabled: boolean;
  readonly volume: number;
}

export type SoundSettings = Readonly<Record<SoundChannel, ChannelSetting>>;

export const DEFAULT_SOUND_VOLUME = 0.5;
export const SOUND_VOLUME_STEP = 0.05;

const DEFAULT_CHANNEL: ChannelSetting = Object.freeze({ enabled: false, volume: DEFAULT_SOUND_VOLUME });

export const DEFAULT_SOUND_SETTINGS: SoundSettings = Object.freeze({
  ambience: DEFAULT_CHANNEL,
  effects: DEFAULT_CHANNEL,
  music: DEFAULT_CHANNEL,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isVolume = (value: unknown): value is number =>
  typeof value === 'number' && value >= MIN_CHANNEL_VOLUME && value <= MAX_CHANNEL_VOLUME;

const toChannel = (value: unknown, fallback: ChannelSetting): ChannelSetting =>
  isRecord(value) && typeof value.enabled === 'boolean' && isVolume(value.volume)
    ? { enabled: value.enabled, volume: value.volume }
    : fallback;

export const toSoundSettings = (value: unknown): SoundSettings => {
  const saved = isRecord(value) ? value : {};
  return {
    ambience: toChannel(saved.ambience, DEFAULT_CHANNEL),
    effects: toChannel(saved.effects, DEFAULT_CHANNEL),
    music: toChannel(saved.music, DEFAULT_CHANNEL),
  };
};

export const soundEnabled = (settings: SoundSettings): boolean =>
  SOUND_CHANNELS.some((channel) => settings[channel].enabled);
