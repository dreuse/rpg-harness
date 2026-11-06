import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { audioCacheKey } from '../../../packages/voice/src/audio-budget.ts';
import {
  AUDIO_CACHE_BYTES,
  AUDIO_CACHE_DIR,
  createFileAudioCache,
} from '../../../packages/voice/src/audio-cache-store.ts';
import {
  CHATTERBOX_CAPABILITIES,
  CHATTERBOX_DIR_ENV,
  CHATTERBOX_PROVIDER_ID,
  createChatterboxProvider,
} from '../../../packages/voice/src/chatterbox-engine.ts';
import { type ChatterboxInstaller, createChatterboxInstaller } from '../../../packages/voice/src/chatterbox-install.ts';
import { npcVoiceBlend } from '../../../packages/voice/src/cinematic.ts';
import {
  createF5Provider,
  F5_ATTRIBUTIONS,
  F5_CAPABILITIES,
  F5_DIR_ENV,
  F5_PROVIDER_ID,
} from '../../../packages/voice/src/f5-tts-engine.ts';
import { createF5Installer, type F5Installer } from '../../../packages/voice/src/f5-tts-install.ts';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from '../../../packages/voice/src/kokoro-js-engine.ts';
import {
  createKokoroModelManager,
  KOKORO_MODEL_OFFER,
  KOKORO_PT_BR_MODEL_FILES,
  type ModelConsent,
  type ModelManager,
  type ModelOffer,
} from '../../../packages/voice/src/kokoro-model.ts';
import { createKokoroOnnxEngine } from '../../../packages/voice/src/kokoro-onnx-engine.ts';
import {
  createKokoroProvider,
  KOKORO_CAPABILITIES,
  KOKORO_MIME_TYPE,
  KOKORO_ONNX_PROVIDER_ID,
  KOKORO_PROVIDER_ID,
  type KokoroCapabilities,
  type KokoroEngine,
  type KokoroProvider,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
  speaksLanguage,
} from '../../../packages/voice/src/kokoro-provider.ts';
import { noVoiceNotice, voicesFor } from '../../../packages/voice/src/language-voices.ts';
import { createMlxAudioProvider, MLX_AUDIO_DIR_ENV } from '../../../packages/voice/src/mlx-audio-engine.ts';
import { createMlxAudioInstaller, type MlxAudioInstaller } from '../../../packages/voice/src/mlx-audio-install.ts';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import { choosePtBrRoute, type PtBrRoute } from '../../../packages/voice/src/pt-br-route.ts';
import type { SpeechChunk } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance, Delivery } from '../../../packages/voice/src/voice.ts';
import { MAX_SPEECH_CHARS } from './voice-setup.ts';

export const VOICE_ROUTE_ENV = 'RPG_VOICE';
export const FAKE_VOICE_ROUTE = 'fake';
export const VOICE_MODELS_DIR = 'voice-models';
export const MLX_AUDIO_SUBDIR = 'mlx-audio';
export const CHATTERBOX_SUBDIR = 'chatterbox';
export const F5_SUBDIR = 'f5-tts';
export { AUDIO_CACHE_DIR, MAX_SPEECH_CHARS };
export const MAX_STYLE_CHARS = 200;
export const MAX_EMOTION_CHARS = 100;
export const MAX_PRONUNCIATIONS = 100;
export const MAX_PRONUNCIATION_CHARS = 200;
export const PREVIEW_CACHE_BYTES = AUDIO_CACHE_BYTES;
export const PREVIEW_LINES: Readonly<Record<string, string>> = {
  en: 'Welcome, traveller. Your story begins here.',
  pt: 'Bem-vindo, viajante. A sua história começa aqui.',
};

export type HostedProvider = {
  readonly id: string;
  readonly capabilities: KokoroCapabilities;
  readonly narrator: string;
  readonly model: ModelManager;
  readonly attributions?: readonly string[];
  readonly optIn?: boolean;
  readonly provider: Pick<KokoroProvider, 'synthesize' | 'dispose' | 'preload' | 'healthy'>;
};

export type VoiceProviderStatus = {
  readonly id: string;
  readonly languages: readonly string[];
  readonly voices: readonly string[];
  readonly narrator: string;
  readonly installed: boolean;
  readonly bytes: number;
  readonly offer: ModelOffer;
  readonly attributions?: readonly string[];
  readonly optIn?: boolean;
};

export type VoiceHostStatus = { readonly providers: readonly VoiceProviderStatus[]; readonly cacheBytes: number };
export type PreviewRequest = {
  readonly providerId: string;
  readonly voiceId: string;
  readonly language: string;
  readonly speed: number;
  readonly text?: string;
  readonly style?: string;
  readonly pronunciations?: Readonly<Record<string, string>>;
  readonly delivery?: Delivery;
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
  prepare(language: string, uiLocale?: string): string | undefined;
};

const PREVIEW_EVENT = 'voice-preview';
const PREVIEW_SPEAKER = 'narrator';
const NO_STYLE = '';
const NO_PRONUNCIATIONS: Readonly<Record<string, string>> = Object.freeze({});
const REQUEST_FIELDS = ['providerId', 'voiceId', 'language', 'speed', 'text', 'style', 'pronunciations', 'delivery'];
const DELIVERY_FIELDS = { emotion: 'string', intensity: 'number', pace: 'number' } as const;
const BYTES_PER_MIB = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPronunciations = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.keys(value).length <= MAX_PRONUNCIATIONS &&
  Object.entries(value).every(
    ([written, spoken]) =>
      written.length <= MAX_PRONUNCIATION_CHARS &&
      typeof spoken === 'string' &&
      spoken.length <= MAX_PRONUNCIATION_CHARS,
  );

const isDelivery = (value: unknown): value is Delivery =>
  isRecord(value) &&
  Object.entries(value).every(
    ([field, entry]) =>
      Object.hasOwn(DELIVERY_FIELDS, field) &&
      typeof entry === DELIVERY_FIELDS[field as keyof typeof DELIVERY_FIELDS] &&
      (typeof entry !== 'number' || Number.isFinite(entry)) &&
      (typeof entry !== 'string' || entry.length <= MAX_EMOTION_CHARS),
  );

export const isConsent = (value: unknown): value is ModelConsent =>
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
  cacheDir,
  now = performance.now.bind(performance),
  cacheLimit = PREVIEW_CACHE_BYTES,
}: {
  readonly providers: readonly HostedProvider[];
  readonly cacheDir: string;
  readonly now?: () => number;
  readonly cacheLimit?: number;
}): VoiceHost => {
  let cache = createFileAudioCache(cacheDir, cacheLimit);
  const route: PtBrRoute = providers.some(({ id }) => id === KOKORO_ONNX_PROVIDER_ID) ? 'onnx' : 'mlx';
  const downloads = new Map<string, Promise<void>>();
  const failedPreloads = new Set<string>();
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
    const text = 'text' in value ? value.text : typeof language === 'string' ? previewLine(language) : undefined;
    if (typeof voiceId !== 'string' || !hosted.capabilities.voices.includes(voiceId))
      throw new RangeError('preview voice is not offered by this provider');
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SPEECH_CHARS)
      throw new RangeError('preview text is invalid');
    if (typeof language !== 'string' || !speaksLanguage(hosted.capabilities, language))
      throw new RangeError('preview language is not spoken by this provider');
    if (typeof speed !== 'number' || !(speed >= MIN_PLAYBACK_SPEED && speed <= MAX_PLAYBACK_SPEED))
      throw new RangeError('preview speed is out of range');
    const { style = NO_STYLE, pronunciations = NO_PRONUNCIATIONS, delivery } = value;
    if (
      typeof style !== 'string' ||
      style.length > MAX_STYLE_CHARS ||
      !isPronunciations(pronunciations) ||
      (delivery !== undefined && !isDelivery(delivery))
    )
      throw new RangeError('preview voice profile is invalid');
    const utterance: CommittedUtterance = {
      text,
      speakerId: PREVIEW_SPEAKER,
      eventId: PREVIEW_EVENT,
      profile: { id: PREVIEW_SPEAKER, language, pace: speed, style, pronunciations, fallbacks: [] },
      ...(delivery === undefined ? {} : { delivery }),
    };
    return { hosted, voiceId, utterance };
  };
  return {
    check: async () => ({
      providers: await Promise.all(
        providers.map(async ({ id, capabilities, narrator, model, attributions, optIn }) => ({
          id,
          languages: capabilities.languages,
          voices: capabilities.voices,
          narrator,
          ...(await model.status()),
          offer: model.offer,
          ...(attributions === undefined ? {} : { attributions }),
          ...(optIn === true ? { optIn } : {}),
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
      const key = audioCacheKey(hosted.id, voiceId, utterance, {
        modelVersion: hosted.model.offer.source,
        outputFormat: KOKORO_MIME_TYPE,
      });
      const cached = cache.get(key);
      if (cached !== undefined)
        return { chunks: cached.map(({ audio }) => audio), synthesisMs: now() - started, cacheHit: true };
      const collect = async (target: HostedProvider, voice: string) => {
        const collected: SpeechChunk[] = [];
        for await (const chunk of target.provider.synthesize(utterance, voice, new AbortController().signal))
          collected.push(chunk);
        return collected;
      };
      try {
        const chunks = await collect(hosted, voiceId);
        const synthesisMs = now() - started;
        cache.set(key, chunks);
        return { chunks: chunks.map(({ audio }) => audio), synthesisMs, cacheHit: false };
      } catch (cause) {
        const fallback =
          hosted.optIn === true
            ? providers.find(
                (candidate) =>
                  candidate.optIn !== true &&
                  candidate.provider.healthy() &&
                  speaksLanguage(candidate.capabilities, utterance.profile.language),
              )
            : undefined;
        if (fallback === undefined) throw cause;
        const chunks = await collect(fallback, fallback.narrator);
        return { chunks: chunks.map(({ audio }) => audio), synthesisMs: now() - started, cacheHit: false };
      }
    },
    clearCache: () => {
      rmSync(cacheDir, { recursive: true, force: true });
      cache = createFileAudioCache(cacheDir, cacheLimit);
    },
    prepare: (language, uiLocale) => {
      const hosted = providers.find(({ id }) => id === voicesFor(language, route)?.providerId);
      if (hosted !== undefined && hosted.provider.healthy())
        hosted.provider
          .preload()
          .then(() => failedPreloads.delete(hosted.id))
          .catch(() => failedPreloads.add(hosted.id));
      return noVoiceNotice(
        language,
        providers
          .filter(({ id }) => !failedPreloads.has(id))
          .map(({ id, provider }) => ({ id, healthy: () => provider.healthy() })),
        route,
        uiLocale,
      );
    },
  };
};

const BRAZILIAN_NARRATOR = voicesFor('pt-BR', 'mlx')?.narrator ?? '';

const serviceModel = (installer: ChatterboxInstaller | F5Installer | MlxAudioInstaller): ModelManager => ({
  offer: installer.offer,
  status: async () => {
    const { installed } = await installer.status();
    return { installed, bytes: installed ? installer.offer.bytes : 0 };
  },
  download: (consent, signal) => installer.install(consent, signal),
  remove: () => installer.remove(),
});

export const mlxAudioProviders = (
  dir: string,
  installer: MlxAudioInstaller = createMlxAudioInstaller({ dir }),
): HostedProvider[] => [
  {
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    narrator: BRAZILIAN_NARRATOR,
    model: serviceModel(installer),
    provider: createMlxAudioProvider({ dir, voiceBlend: npcVoiceBlend(MLX_KOKORO_CAPABILITIES.voices) }),
  },
];

export const chatterboxProviders = (
  dir: string,
  installer: ChatterboxInstaller = createChatterboxInstaller({ dir }),
): HostedProvider[] => [
  {
    id: CHATTERBOX_PROVIDER_ID,
    capabilities: CHATTERBOX_CAPABILITIES,
    narrator: CHATTERBOX_CAPABILITIES.voices[0] ?? '',
    model: serviceModel(installer),
    optIn: true,
    provider: createChatterboxProvider({ dir }),
  },
];

export const f5Providers = (dir: string, installer: F5Installer = createF5Installer({ dir })): HostedProvider[] => [
  {
    id: F5_PROVIDER_ID,
    capabilities: F5_CAPABILITIES,
    narrator: F5_CAPABILITIES.voices[0] ?? '',
    model: serviceModel(installer),
    attributions: F5_ATTRIBUTIONS,
    optIn: true,
    provider: createF5Provider({ dir }),
  },
];

const kokoroNarrator = () => voicesFor('en', 'mlx')?.narrator ?? KOKORO_CAPABILITIES.voices[0] ?? '';

export const kokoroProviders = (dir: string): HostedProvider[] => [
  {
    id: KOKORO_PROVIDER_ID,
    capabilities: KOKORO_CAPABILITIES,
    narrator: kokoroNarrator(),
    model: createKokoroModelManager({ dir }),
    provider: createKokoroProvider({ engine: createKokoroJsEngine(dir) }),
  },
];

export const onnxProviders = (dir: string): HostedProvider[] => [
  {
    id: KOKORO_ONNX_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    narrator: BRAZILIAN_NARRATOR,
    model: createKokoroModelManager({ dir, files: KOKORO_PT_BR_MODEL_FILES }),
    provider: createKokoroProvider({
      id: KOKORO_ONNX_PROVIDER_ID,
      capabilities: MLX_KOKORO_CAPABILITIES,
      engine: createKokoroOnnxEngine(dir),
    }),
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
  {
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    narrator: BRAZILIAN_NARRATOR,
    model: fakeModel(schedule),
    provider: createKokoroProvider({
      id: MLX_KOKORO_PROVIDER_ID,
      capabilities: MLX_KOKORO_CAPABILITIES,
      engine: fakeEngine(),
    }),
  },
];

export const voiceProviders = (
  env: NodeJS.ProcessEnv,
  dataDir: string,
  mlxSupported: boolean = choosePtBrRoute(process.platform, process.arch, env) === 'mlx',
): HostedProvider[] => [
  ...kokoroProviders(env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR)),
  ...(mlxSupported
    ? mlxAudioProviders(env[MLX_AUDIO_DIR_ENV] || join(dataDir, MLX_AUDIO_SUBDIR))
    : onnxProviders(env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR))),
  ...(mlxSupported ? chatterboxProviders(env[CHATTERBOX_DIR_ENV] || join(dataDir, CHATTERBOX_SUBDIR)) : []),
  ...f5Providers(env[F5_DIR_ENV] || join(dataDir, F5_SUBDIR)),
];

export const voiceHostFromEnv = (env: NodeJS.ProcessEnv, dataDir: string): VoiceHost =>
  createVoiceHost({
    cacheDir: join(dataDir, AUDIO_CACHE_DIR),
    providers: env[VOICE_ROUTE_ENV] === FAKE_VOICE_ROUTE ? fakeVoiceProviders() : voiceProviders(env, dataDir),
  });
