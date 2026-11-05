import { join } from 'node:path';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from '../../../packages/voice/src/kokoro-js-engine.ts';
import { createKokoroProvider } from '../../../packages/voice/src/kokoro-provider.ts';
import type { PlaybackSink } from '../../../packages/voice/src/playback.ts';
import { createProcessSink } from '../../../packages/voice/src/process-sink.ts';
import { createStreamingSpeech, type StreamingSpeech } from '../../../packages/voice/src/streaming-speech.ts';
import type { SpeechChunk, TtsProvider } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance } from '../../../packages/voice/src/voice.ts';
import {
  createVoiceDiagnostics,
  streamingMetricsSink,
  type VoiceDiagnostics,
} from '../../../packages/voice/src/voice-diagnostics.ts';

export const VOICE_MODELS_DIR = 'voice-models';

export interface SpeechRuntime {
  readonly speech: StreamingSpeech;
  readonly diagnostics: VoiceDiagnostics;
  dispose(): void;
}

export interface SpeechRuntimeOptions {
  readonly providers: readonly TtsProvider[];
  readonly sink: PlaybackSink & { dispose?(): void };
  readonly now?: () => number;
}

export const createSpeechRuntime = ({
  providers,
  sink,
  now = performance.now.bind(performance),
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
  const speech = createStreamingSpeech({ synthesize, sink, now, onMetrics: streamingMetricsSink(diagnostics) });
  return {
    speech,
    diagnostics,
    dispose: () => {
      speech.stop();
      sink.dispose?.();
    },
  };
};

export const createLiveSpeechRuntime = (dataDir: string, env: NodeJS.ProcessEnv = process.env): SpeechRuntime =>
  createSpeechRuntime({
    providers: [
      createKokoroProvider({
        engine: createKokoroJsEngine(env[KOKORO_MODEL_DIR_ENV] || join(dataDir, VOICE_MODELS_DIR)),
      }),
    ],
    sink: createProcessSink(),
  });
