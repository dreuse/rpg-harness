import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWav } from './delivery-shaping.ts';
import { KOKORO_MODEL_DIR_ENV } from './kokoro-js-engine.ts';
import { createKokoroOnnxEngine, KOKORO_ONNX_PROVIDER_ID, KOKORO_SAMPLE_RATE } from './kokoro-onnx-engine.ts';
import { createKokoroProvider, MLX_KOKORO_CAPABILITIES } from './kokoro-provider.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

const VOICE = 'pf_dora';
const SENTENCE_COUNT = 2;
const MIN_AUDIO_SECONDS = 1;
const UTTERANCE: CommittedUtterance = {
  text: 'Fala baixo. O capitão escuta tudo.',
  speakerId: 'gm',
  eventId: 'ev-onnx-integration',
  profile: {
    id: 'narrator',
    language: 'pt-BR',
    pace: 1,
    style: 'calm',
    pronunciations: {},
    fallbacks: [{ providerId: KOKORO_ONNX_PROVIDER_ID, voiceId: VOICE }],
  },
};

const modelDir = process.env[KOKORO_MODEL_DIR_ENV];
const engine = modelDir ? createKokoroOnnxEngine(modelDir) : undefined;
const skip = engine?.ready() ? false : `set ${KOKORO_MODEL_DIR_ENV} to a dir with the Kokoro pt-BR files installed`;

test('speaks pt-BR on CPU through ONNX with espeak-ng phonemes, no MLX', { skip }, async () => {
  assert.ok(engine);
  const provider = createKokoroProvider({
    engine,
    id: KOKORO_ONNX_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
  });
  const chunks: SpeechChunk[] = [];
  try {
    for await (const chunk of provider.synthesize(UTTERANCE, VOICE, new AbortController().signal)) chunks.push(chunk);
  } finally {
    await provider.dispose();
  }
  assert.equal(chunks.length, SENTENCE_COUNT);
  const wavs = chunks.map((chunk) => decodeWav(chunk.audio));
  assert.ok(wavs.every((wav) => wav?.sampleRate === KOKORO_SAMPLE_RATE));
  const seconds = wavs.reduce((sum, wav) => sum + (wav ? wav.samples.length / wav.sampleRate : 0), 0);
  assert.ok(seconds > MIN_AUDIO_SECONDS);
});
