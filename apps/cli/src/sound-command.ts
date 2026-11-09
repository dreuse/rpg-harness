import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSoundManager } from '../../../packages/voice/src/sound-downloader.ts';
import { loadBundledManifest, type SoundEntry } from '../../../packages/voice/src/sound-manifest.ts';
import {
  parseRateLimited,
  parseUnavailable,
  retryMinutes,
  stripUnavailableCode,
} from '../../../packages/voice/src/sound-rate-limit.ts';
import {
  isVolume,
  SOUND_CHANNELS,
  type SoundChannel,
  type SoundSettings,
  toSoundSettings,
} from '../../../packages/voice/src/sound-settings.ts';
import { DEFAULT_LOCALE, say } from './messages.ts';
import { SOUND_SETTINGS_FILE, SOUNDS_DIR } from './sound-files.ts';

export interface SoundRequest {
  readonly enabled: Partial<Record<SoundChannel, boolean>>;
  readonly volume: Partial<Record<SoundChannel, number>>;
  readonly download: boolean;
  readonly accept: boolean;
}

export interface SoundCommandDeps {
  readonly sounds?: readonly SoundEntry[];
  readonly fetch?: typeof fetch;
  readonly locale?: string;
}

type SoundOptionValues = Readonly<Record<string, string | boolean | undefined>>;

const TEXT = 'utf8';
const PERCENT = 100;
const INVALID_VOLUME = 'Volume must be a number from 0 to 1.';
const YES_NEEDS_DOWNLOAD = '--yes needs --download.';

export const readSoundSettings = (dataDir: string): SoundSettings => {
  try {
    return toSoundSettings(JSON.parse(readFileSync(join(dataDir, SOUND_SETTINGS_FILE), TEXT)));
  } catch {
    return toSoundSettings(undefined);
  }
};

export const writeSoundSettings = (dataDir: string, settings: SoundSettings): void => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, SOUND_SETTINGS_FILE), JSON.stringify(settings));
};

export const soundRequestOf = (values: SoundOptionValues): SoundRequest | string => {
  const enabled: Partial<Record<SoundChannel, boolean>> = {};
  const volume: Partial<Record<SoundChannel, number>> = {};
  for (const channel of SOUND_CHANNELS) {
    const flag = values[channel];
    if (typeof flag === 'boolean') enabled[channel] = flag;
    const raw = values[`${channel}-volume`];
    if (typeof raw !== 'string') continue;
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
    if (!isVolume(parsed)) return INVALID_VOLUME;
    volume[channel] = parsed;
  }
  const download = values.download === true;
  const accept = values.yes === true;
  if (accept && !download) return YES_NEEDS_DOWNLOAD;
  return { enabled, volume, download, accept };
};

const statusLines = (settings: SoundSettings, installed: boolean, locale: string): string[] => [
  ...SOUND_CHANNELS.map((channel) =>
    say(locale, 'sound.status', {
      channel: say(locale, `sound.channel.${channel}`),
      state: say(locale, `sound.${settings[channel].enabled ? 'on' : 'off'}.${channel}`),
      percent: Math.round(settings[channel].volume * PERCENT),
    }),
  ),
  say(locale, 'sound.installed', { answer: say(locale, installed ? 'sound.installedYes' : 'sound.installedNo') }),
];

const downloadFailure = (error: unknown, locale: string): string => {
  const message = error instanceof Error ? error.message : String(error);
  const seconds = parseRateLimited(message);
  if (seconds !== undefined) return say(locale, 'sound.busy', { minutes: retryMinutes(seconds) });
  const reason = stripUnavailableCode(message);
  return say(locale, parseUnavailable(message) ? 'sound.unavailable.download' : 'sound.failed', { reason });
};

export async function* soundCommand(
  dataDir: string,
  request: SoundRequest,
  { sounds = loadBundledManifest(), fetch: fetchFile, locale = DEFAULT_LOCALE }: SoundCommandDeps = {},
): AsyncGenerator<string> {
  const current = readSoundSettings(dataDir);
  const next = Object.fromEntries(
    SOUND_CHANNELS.map((channel) => [
      channel,
      {
        enabled: request.enabled[channel] ?? current[channel].enabled,
        volume: request.volume[channel] ?? current[channel].volume,
      },
    ]),
  ) as SoundSettings;
  writeSoundSettings(dataDir, next);
  const manager = createSoundManager({
    dir: join(dataDir, SOUNDS_DIR),
    sounds,
    ...(fetchFile === undefined ? {} : { fetch: fetchFile }),
  });
  if (request.download && !request.accept) {
    const { sizeMiB, source } = manager.offer;
    yield say(locale, 'sound.offer', { size: sizeMiB, source });
  }
  let failure: string | undefined;
  if (request.download && request.accept) {
    try {
      await manager.download({ ...manager.offer, accepted: true });
      yield say(locale, 'sound.downloaded');
    } catch (error) {
      failure = downloadFailure(error, locale);
    }
  }
  for (const line of statusLines(next, (await manager.status()).installed, locale)) yield line;
  if (failure !== undefined) throw new Error(failure);
}
