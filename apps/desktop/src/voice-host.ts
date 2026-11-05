import { join } from 'node:path';
import { audioCacheKey, createAudioCache } from '../../../packages/voice/src/audio-budget.ts';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from '../../../packages/voice/src/kokoro-js-engine.ts';
import {
  createKokoroModelManager,
  KOKORO_MODEL_OFFER,
  type ModelConsent,
  type ModelManager,
  type ModelOffer,
} from '../../../packages/voice/src/kokoro-model.ts';
import {
  createKokoroProvider,
  KOKORO_CAPABILITIES,
  KOKORO_PROVIDER_ID,
  type KokoroCapabilities,
  type KokoroEngine,
  type KokoroProvider,
  speaksLanguage,
} from '../../../packages/voice/src/kokoro-provider.ts';
import { voicesFor } from '../../../packages/voice/src/language-voices.ts';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import type { SpeechChunk } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance } from '../../../packages/voice/src/voice.ts';

export const VOICE_ROUTE_ENV = 'RPG_VOICE';
export const FAKE_VOICE_ROUTE = 'fake';
export const VOICE_MODELS_DIR = 'voice-models';
export const PREVIEW_CACHE_BYTES = 8 * 1024 * 1024;
export const PREVIEW_LINES: Readonly<Record<string, string>> = {
  en: 'Welcome, traveller. Your story begins here.',
  pt: 'Bem-vindo, viajante. A sua história começa aqui.',
};

export type HostedProvider = {
  readonly id: string;
  readonly capabilities: KokoroCapabilities;
  readonly narrator: string;
  readonly model: ModelManager;
  readonly provider: Pick<KokoroProvider, 'synthesize' | 'dispose'>;
};

export type VoiceProviderStatus = {
  readonly id: string;
  readonly languages: readonly string[];
  readonly voices: readonly string[];
  readonly narrator: string;
  readonly installed: boolean;
  readonly bytes: number;
  readonly offer: ModelOffer;
};

export type VoiceHostStatus = { readonly providers: readonly VoiceProviderStatus[]; readonly cacheBytes: number };
export type PreviewRequest = {
  readonly providerId: string;
  readonly voiceId: string;
  readonly language: string;
  readonly speed: number;
};
export type PreviewAudio = {
  readonly chunks: readonly Uint8Array[];
  readonly synthesisMs: number;
  readonly cacheHit: boolean;
};

export type VoiceHost = {
  check(): Promise<VoiceHostStatus>;
  download(providerId: unknown, consent: unknown, onProgress: (bytes: number) => void): Promise<void>;
  remove(providerId: unknown): Promise<void>;
  preview(request: unknown): Promise<PreviewAudio>;
  clearCache(): void;
};

const PREVIEW_EVENT = 'voice-preview';
const PREVIEW_SPEAKER = 'narrator';
const NO_STYLE = '';
const REQUEST_FIELDS = ['providerId', 'voiceId', 'language', 'speed'];
const BYTES_PER_MIB = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isConsent = (value: unknown): value is ModelConsent =>
  isRecord(value) &&
  value.accepted === true &&
  typeof value.source === 'string' &&
  typeof value.bytes === 'number' &&
  typeof value.sizeMiB === 'number';

const shownMiB = (bytes: number) => Math.round(bytes / BYTES_PER_MIB);

const whenShownChanges = (total: number, onProgress: (bytes: number) => void) => {
  let shown = 0;
  return (bytes: number) => {
    if (shownMiB(bytes) === shown && bytes < total) return;
    shown = shownMiB(bytes);
    onProgress(bytes);
  };
};

const previewLine = (language: string) => {
  try {
    return PREVIEW_LINES[new Intl.Locale(language).language];
  } catch {
    return undefined;
  }
};

export const createVoiceHost = ({
  providers,
  now = performance.now.bind(performance),
  cacheLimit = PREVIEW_CACHE_BYTES,
}: {
  readonly providers: readonly HostedProvider[];
  readonly now?: () => number;
  readonly cacheLimit?: number;
}): VoiceHost => {
  let cache = createAudioCache(cacheLimit);
  const downloads = new Map<string, Promise<void>>();
  const find = (id: unknown) => {
    const hosted = providers.find((candidate) => candidate.id === id);
    if (hosted === undefined) throw new RangeError('unknown voice provider');
    return hosted;
  };
  const request = (value: unknown) => {
    if (!isRecord(value) || Object.keys(value).some((key) => !REQUEST_FIELDS.includes(key)))
      throw new RangeError('preview request is invalid');
    const { providerId, voiceId, language, speed } = value;
    const hosted = find(providerId);
    const text = typeof language === 'string' ? previewLine(language) : undefined;
    if (typeof voiceId !== 'string' || !hosted.capabilities.voices.includes(voiceId))
      throw new RangeError('preview voice is not offered by this provider');
    if (typeof language !== 'string' || text === undefined || !speaksLanguage(hosted.capabilities, language))
      throw new RangeError('preview language is not spoken by this provider');
    if (typeof speed !== 'number' || !(speed >= MIN_PLAYBACK_SPEED && speed <= MAX_PLAYBACK_SPEED))
      throw new RangeError('preview speed is out of range');
    const utterance: CommittedUtterance = {
      text,
      speakerId: PREVIEW_SPEAKER,
      eventId: PREVIEW_EVENT,
      profile: { id: PREVIEW_SPEAKER, language, pace: speed, style: NO_STYLE, pronunciations: {}, fallbacks: [] },
      delivery: { pace: speed },
    };
    return { hosted, voiceId, utterance };
  };
  return {
    check: async () => ({
      providers: await Promise.all(
        providers.map(async ({ id, capabilities, narrator, model }) => ({
          id,
          languages: capabilities.languages,
          voices: capabilities.voices,
          narrator,
          ...(await model.status()),
          offer: model.offer,
        })),
      ),
      cacheBytes: cache.bytes,
    }),
    download: async (providerId, consent, onProgress) => {
      const { id, model } = find(providerId);
      if (!isConsent(consent)) throw new RangeError('download consent is invalid');
      const running = downloads.get(id);
      if (running !== undefined) return running;
      const download = model
        .download(consent, undefined, whenShownChanges(model.offer.bytes, onProgress))
        .finally(() => downloads.delete(id));
      downloads.set(id, download);
      return download;
    },
    remove: async (providerId) => {
      const { model, provider } = find(providerId);
      await provider.dispose();
      await model.remove();
    },
    preview: async (value) => {
      const { hosted, voiceId, utterance } = request(value);
      const started = now();
      const key = audioCacheKey(hosted.id, voiceId, utterance);
      const cached = cache.get(key);
      if (cached !== undefined)
        return { chunks: cached.map(({ audio }) => audio), synthesisMs: now() - started, cacheHit: true };
      const chunks: SpeechChunk[] = [];
      for await (const chunk of hosted.provider.synthesize(utterance, voiceId, new AbortController().signal))
        chunks.push(chunk);
      const synthesisMs = now() - started;
      cache.set(key, chunks);
      return { chunks: chunks.map(({ audio }) => audio), synthesisMs, cacheHit: false };
    },
    clearCache: () => {
      cache = createAudioCache(cacheLimit);
    },
  };
};

const kokoroNarrator = () => voicesFor('en')?.narrator ?? KOKORO_CAPABILITIES.voices[0] ?? '';

export const kokoroProviders = (dir: string): HostedProvider[] => [
  {
    id: KOKORO_PROVIDER_ID,
    capabilities: KOKORO_CAPABILITIES,
    narrator: kokoroNarrator(),
    model: createKokoroModelManager({ dir }),
    provider: createKokoroProvider({ engine: createKokoroJsEngine(dir) }),
  },
];

const SAMPLE_RATE = 24_000;
const SILENT_SAMPLES = 2_400;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const FAKE_DOWNLOAD_STEPS = 60;
const FAKE_DOWNLOAD_STEP_MS = 200;

const silentWav = () => {
  const dataBytes = SILENT_SAMPLES * BYTES_PER_SAMPLE;
  const view = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes));
  const text = (offset: number, value: string) => {
    for (const [index, character] of [...value].entries()) view.setUint8(offset + index, character.charCodeAt(0));
  };
  text(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(view.buffer);
};

const fakeEngine = (): KokoroEngine => ({
  ready: () => true,
  load: async () => {},
  synthesize: async () => silentWav(),
  unload: async () => {},
});

const fakeModel = (schedule: (run: () => void, ms: number) => void): ModelManager => {
  let installed = false;
  const offer = KOKORO_MODEL_OFFER;
  const wait = () => new Promise<void>((resolve) => schedule(resolve, FAKE_DOWNLOAD_STEP_MS));
  return {
    offer,
    status: async () => ({ installed, bytes: installed ? offer.bytes : 0 }),
    download: async (_consent, _signal, onProgress) => {
      for (let step = 1; step <= FAKE_DOWNLOAD_STEPS; step += 1) {
        await wait();
        onProgress?.(Math.round((offer.bytes * step) / FAKE_DOWNLOAD_STEPS));
      }
      installed = true;
    },
    remove: async () => {
      installed = false;
    },
  };
};

export const fakeVoiceProviders = (schedule: (run: () => void, ms: number) => void = setTimeout): HostedProvider[] => [
  {
    id: KOKORO_PROVIDER_ID,
    capabilities: KOKORO_CAPABILITIES,
    narrator: kokoroNarrator(),
    model: fakeModel(schedule),
    provider: createKokoroProvider({ engine: fakeEngine() }),
  },
];

export const voiceHostFromEnv = (env: NodeJS.ProcessEnv, dataDir: string): VoiceHost =>
  createVoiceHost({
    providers:
      env[VOICE_ROUTE_ENV] === FAKE_VOICE_ROUTE
        ? fakeVoiceProviders()
        : kokoroProviders(env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR)),
  });
