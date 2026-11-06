import { join } from 'node:path';
import { npcVoiceBlend } from '../../../packages/voice/src/cinematic.ts';
import { duckingSink } from '../../../packages/voice/src/ducking-sink.ts';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from '../../../packages/voice/src/kokoro-js-engine.ts';
import { createKokoroOnnxEngine, KOKORO_ONNX_PROVIDER_ID } from '../../../packages/voice/src/kokoro-onnx-engine.ts';
import { createKokoroProvider, type KokoroProvider } from '../../../packages/voice/src/kokoro-provider.ts';
import { noVoiceNotice, voicesFor } from '../../../packages/voice/src/language-voices.ts';
import {
  createMlxAudioProvider,
  MLX_AUDIO_DIR_ENV,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
} from '../../../packages/voice/src/mlx-audio-engine.ts';
import type { PlaybackSink } from '../../../packages/voice/src/playback.ts';
import { createProcessSink } from '../../../packages/voice/src/process-sink.ts';
import { choosePtBrRoute, type PtBrRoute } from '../../../packages/voice/src/pt-br-route.ts';
import { createStreamingSpeech, type StreamingSpeech } from '../../../packages/voice/src/streaming-speech.ts';
import type { SpeechChunk, TtsProvider } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance } from '../../../packages/voice/src/voice.ts';
import {
  createVoiceDiagnostics,
  streamingMetricsSink,
  type VoiceDiagnostics,
} from '../../../packages/voice/src/voice-diagnostics.ts';

export const VOICE_MODELS_DIR = 'voice-models';
export const MLX_AUDIO_SUBDIR = 'mlx-audio';
export const SYNTHESIS_FAILURE_NOTICE = 'Part of the story could not be read aloud, so it stays in text.';

export interface SpeechRuntime {
  readonly speech: StreamingSpeech;
  readonly providers: readonly TtsProvider[];
  readonly diagnostics: VoiceDiagnostics;
  readonly route: PtBrRoute;
  takeFailureNotice(): string | undefined;
  dispose(): void;
}

export interface SpeechRuntimeOptions {
  readonly providers: readonly TtsProvider[];
  readonly sink: PlaybackSink & { dispose?(): void };
  readonly now?: () => number;
  readonly route?: PtBrRoute;
}

export const createSpeechRuntime = ({
  providers,
  sink,
  now = performance.now.bind(performance),
  route = choosePtBrRoute(),
}: SpeechRuntimeOptions): SpeechRuntime => {
  const diagnostics = createVoiceDiagnostics();
  async function* synthesize(utterance: CommittedUtterance, signal: AbortSignal): AsyncGenerator<SpeechChunk> {
    for (const { providerId, voiceId } of utterance.profile.fallbacks) {
      const provider = providers.find(({ id }) => id === providerId);
      if (provider === undefined || provider.healthy?.() === false) continue;
      yield* provider.synthesize(utterance, voiceId, signal);
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
    takeFailureNotice: () => {
      const notice = failed ? SYNTHESIS_FAILURE_NOTICE : undefined;
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
];

const preloadable = (provider: TtsProvider | undefined): provider is KokoroProvider =>
  provider !== undefined && 'preload' in provider && provider.healthy?.() === true;

const disposable = (provider: TtsProvider): provider is KokoroProvider => 'dispose' in provider;

const failedPreloads = new WeakSet<TtsProvider>();
const announcedFailures = new WeakSet<TtsProvider>();

const unavailableNotice = (providers: readonly TtsProvider[], language: string, route: PtBrRoute) =>
  noVoiceNotice(
    language,
    providers.filter((provider) => !failedPreloads.has(provider)),
    route,
  );

export const prepareVoice = (
  providers: readonly TtsProvider[],
  language: string,
  route: PtBrRoute,
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
  return unavailableNotice(providers, language, route);
};

export const takePreloadFailureNotice = (
  providers: readonly TtsProvider[],
  language: string,
  route: PtBrRoute,
): string | undefined => {
  const failed = providers.filter((provider) => failedPreloads.has(provider) && !announcedFailures.has(provider));
  for (const provider of failed) announcedFailures.add(provider);
  return failed.length === 0 ? undefined : unavailableNotice(providers, language, route);
};

export const createLiveSpeechRuntime = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  onSpeaking: (active: boolean) => void = () => undefined,
): SpeechRuntime => {
  const route = choosePtBrRoute(process.platform, process.arch, env);
  return createSpeechRuntime({
    providers: liveProviders(dataDir, env, route),
    route,
    sink: duckingSink(createProcessSink(), onSpeaking),
  });
};
