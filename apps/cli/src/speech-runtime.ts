import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOCALE } from '../../../packages/client-protocol/src/locale.ts';
import type { AudioCache } from '../../../packages/voice/src/audio-budget.ts';
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
import { CHATTERBOX_OFFER } from '../../../packages/voice/src/chatterbox-install.ts';
import { npcVoiceBlend } from '../../../packages/voice/src/cinematic.ts';
import { duckingSink } from '../../../packages/voice/src/ducking-sink.ts';
import {
  createF5Provider,
  F5_CAPABILITIES,
  F5_DIR_ENV,
  F5_PROVIDER_ID,
} from '../../../packages/voice/src/f5-tts-engine.ts';
import { F5_OFFER } from '../../../packages/voice/src/f5-tts-install.ts';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from '../../../packages/voice/src/kokoro-js-engine.ts';
import { KOKORO_MODEL_SOURCE } from '../../../packages/voice/src/kokoro-model.ts';
import { createKokoroOnnxEngine, KOKORO_ONNX_PROVIDER_ID } from '../../../packages/voice/src/kokoro-onnx-engine.ts';
import {
  createKokoroProvider,
  KOKORO_MIME_TYPE,
  KOKORO_PROVIDER_ID,
  type KokoroCapabilities,
  type KokoroProvider,
  speaksLanguage,
} from '../../../packages/voice/src/kokoro-provider.ts';
import { noVoiceNotice, synthesisFailureNotice, voicesFor } from '../../../packages/voice/src/language-voices.ts';
import {
  createMlxAudioProvider,
  MLX_AUDIO_DIR_ENV,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
} from '../../../packages/voice/src/mlx-audio-engine.ts';
import { MLX_AUDIO_OFFER } from '../../../packages/voice/src/mlx-audio-install.ts';
import type { PlaybackSink } from '../../../packages/voice/src/playback.ts';
import { createProcessSink } from '../../../packages/voice/src/process-sink.ts';
import { choosePtBrRoute, type PtBrRoute } from '../../../packages/voice/src/pt-br-route.ts';
import { createStreamingSpeech, type StreamingSpeech } from '../../../packages/voice/src/streaming-speech.ts';
import type { SpeechChunk, TtsProvider } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance, VoiceProfile } from '../../../packages/voice/src/voice.ts';
import {
  createVoiceDiagnostics,
  streamingMetricsSink,
  type VoiceDiagnostics,
} from '../../../packages/voice/src/voice-diagnostics.ts';

export const VOICE_MODELS_DIR = 'voice-models';
export const MLX_AUDIO_SUBDIR = 'mlx-audio';
export const PREFERENCES_FILE = 'desktop-preferences.json';
const OPT_IN_CAPABILITIES: Readonly<Record<string, KokoroCapabilities>> = {
  [CHATTERBOX_PROVIDER_ID]: CHATTERBOX_CAPABILITIES,
  [F5_PROVIDER_ID]: F5_CAPABILITIES,
};
export const CHATTERBOX_SUBDIR = 'chatterbox';
export const F5_SUBDIR = 'f5-tts';
const MODEL_VERSIONS: Readonly<Record<string, string>> = {
  [KOKORO_PROVIDER_ID]: KOKORO_MODEL_SOURCE,
  [MLX_KOKORO_PROVIDER_ID]: MLX_AUDIO_OFFER.source,
  [CHATTERBOX_PROVIDER_ID]: CHATTERBOX_OFFER.source,
  [F5_PROVIDER_ID]: F5_OFFER.source,
};

export interface SpeechRuntime {
  readonly speech: StreamingSpeech;
  readonly providers: readonly TtsProvider[];
  readonly diagnostics: VoiceDiagnostics;
  readonly route: PtBrRoute;
  takeFailureNotice(locale?: string): string | undefined;
  dispose(): void;
}

export interface SpeechRuntimeOptions {
  readonly providers: readonly TtsProvider[];
  readonly sink: PlaybackSink & { dispose?(): void };
  readonly now?: () => number;
  readonly route?: PtBrRoute;
  readonly cache?: AudioCache;
}

const attempt = <T>(work: () => T): T | undefined => {
  try {
    return work();
  } catch {
    return undefined;
  }
};

export const createSpeechRuntime = ({
  providers,
  sink,
  now = performance.now.bind(performance),
  route = choosePtBrRoute(),
  cache,
}: SpeechRuntimeOptions): SpeechRuntime => {
  const diagnostics = createVoiceDiagnostics();
  async function* synthesize(utterance: CommittedUtterance, signal: AbortSignal): AsyncGenerator<SpeechChunk> {
    for (const { providerId, voiceId } of utterance.profile.fallbacks) {
      const provider = providers.find(({ id }) => id === providerId);
      if (provider === undefined || provider.healthy?.() === false) continue;
      const modelVersion = MODEL_VERSIONS[providerId];
      const key =
        cache === undefined || modelVersion === undefined
          ? undefined
          : audioCacheKey(providerId, voiceId, utterance, { modelVersion, outputFormat: KOKORO_MIME_TYPE });
      const cached = key === undefined ? undefined : attempt(() => cache?.get(key));
      if (cached !== undefined) {
        yield* cached.map((chunk) => ({ ...chunk, utteranceEventId: utterance.eventId }));
        return;
      }
      const chunks: SpeechChunk[] = [];
      for await (const chunk of provider.synthesize(utterance, voiceId, signal)) {
        chunks.push(chunk);
        yield chunk;
      }
      if (chunks.length === 0 && !signal.aborted) continue;
      if (key !== undefined && !signal.aborted) attempt(() => cache?.set(key, chunks));
      return;
    }
  }
  let failed = false;
  const speech = createStreamingSpeech({
    synthesize,
    sink,
    now,
    onMetrics: streamingMetricsSink(diagnostics),
    onFailure: () => {
      failed = true;
    },
  });
  return {
    speech,
    providers,
    diagnostics,
    route,
    takeFailureNotice: (locale = DEFAULT_LOCALE) => {
      const notice = failed ? synthesisFailureNotice(locale) : undefined;
      failed = false;
      return notice;
    },
    dispose: () => {
      speech.stop();
      sink.dispose?.();
      for (const provider of providers) if (disposable(provider)) provider.dispose().catch(() => undefined);
    },
  };
};

export const liveProviders = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  route: PtBrRoute = choosePtBrRoute(process.platform, process.arch, env),
): TtsProvider[] => [
  createKokoroProvider({
    engine: createKokoroJsEngine(env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR)),
  }),
  ...(route === 'mlx'
    ? [
        createMlxAudioProvider({
          dir: env[MLX_AUDIO_DIR_ENV] || join(dataDir, MLX_AUDIO_SUBDIR),
          voiceBlend: npcVoiceBlend(MLX_KOKORO_CAPABILITIES.voices),
        }),
      ]
    : [
        createKokoroProvider({
          id: KOKORO_ONNX_PROVIDER_ID,
          capabilities: MLX_KOKORO_CAPABILITIES,
          engine: createKokoroOnnxEngine(env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR)),
        }),
      ]),
  createChatterboxProvider({ dir: env[CHATTERBOX_DIR_ENV] || join(dataDir, CHATTERBOX_SUBDIR) }),
  createF5Provider({ dir: env[F5_DIR_ENV] || join(dataDir, F5_SUBDIR) }),
];

export const optedInNarrator = (dataDir: string, language: string): VoiceProfile['fallbacks'][number] | undefined => {
  try {
    const { providerId, narratorVoice } = JSON.parse(readFileSync(join(dataDir, PREFERENCES_FILE), 'utf8')).speech;
    const capabilities = Object.hasOwn(OPT_IN_CAPABILITIES, providerId) ? OPT_IN_CAPABILITIES[providerId] : undefined;
    if (capabilities === undefined || !speaksLanguage(capabilities, language)) return undefined;
    const voiceId = capabilities.voices.includes(narratorVoice) ? narratorVoice : capabilities.voices[0];
    return voiceId === undefined ? undefined : { providerId, voiceId };
  } catch {
    return undefined;
  }
};

export const withOptedInNarrator = (narrator: VoiceProfile, choice: VoiceProfile['fallbacks'][number] | undefined) =>
  choice === undefined ? narrator : { ...narrator, fallbacks: [choice, ...narrator.fallbacks] };

const preloadable = (provider: TtsProvider | undefined): provider is KokoroProvider =>
  provider !== undefined && 'preload' in provider && provider.healthy?.() === true;

const disposable = (provider: TtsProvider): provider is KokoroProvider => 'dispose' in provider;

const failedPreloads = new WeakSet<TtsProvider>();
const announcedFailures = new WeakSet<TtsProvider>();

const unavailableNotice = (
  providers: readonly TtsProvider[],
  language: string,
  route: PtBrRoute,
  uiLocale = DEFAULT_LOCALE,
) =>
  noVoiceNotice(
    language,
    providers.filter((provider) => !failedPreloads.has(provider)),
    route,
    uiLocale,
  );

export const prepareVoice = (
  providers: readonly TtsProvider[],
  language: string,
  route: PtBrRoute,
  uiLocale = DEFAULT_LOCALE,
): string | undefined => {
  const preloaded = voicesFor(language, route)?.providerId;
  if (preloaded === MLX_KOKORO_PROVIDER_ID || preloaded === KOKORO_ONNX_PROVIDER_ID) {
    const provider = providers.find(({ id }) => id === preloaded);
    if (preloadable(provider))
      provider
        .preload()
        .then(() => failedPreloads.delete(provider))
        .catch(() => failedPreloads.add(provider));
  }
  return unavailableNotice(providers, language, route, uiLocale);
};

export const takePreloadFailureNotice = (
  providers: readonly TtsProvider[],
  language: string,
  route: PtBrRoute,
  uiLocale = DEFAULT_LOCALE,
): string | undefined => {
  const failed = providers.filter((provider) => failedPreloads.has(provider) && !announcedFailures.has(provider));
  for (const provider of failed) announcedFailures.add(provider);
  return failed.length === 0 ? undefined : unavailableNotice(providers, language, route, uiLocale);
};

export const createLiveSpeechRuntime = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  onSpeaking: (active: boolean) => void = () => undefined,
): SpeechRuntime => {
  const route = choosePtBrRoute(process.platform, process.arch, env);
  const cache = attempt(() => createFileAudioCache(join(dataDir, AUDIO_CACHE_DIR), AUDIO_CACHE_BYTES));
  return createSpeechRuntime({
    providers: liveProviders(dataDir, env, route),
    route,
    sink: duckingSink(createProcessSink(), onSpeaking),
    ...(cache === undefined ? {} : { cache }),
  });
};
