import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUSE_PAUSE_MS } from './delivery-shaping.ts';
import { createKokoroJsEngine, KOKORO_MODEL_DIR_ENV } from './kokoro-js-engine.ts';
import { createKokoroProvider } from './kokoro-provider.ts';
import { trailingSilenceMs } from './test-silence.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

const VOICE = 'af_heart';
const RIFF = 'RIFF';
const RIFF_HEADER_BYTES = 4;
const SENTENCE_COUNT = 2;
const UTTERANCE: CommittedUtterance = {
  text: 'The door creaks open. Who goes there?',
  speakerId: 'gm',
  eventId: 'ev-integration',
  profile: {
    id: 'narrator',
    language: 'en-US',
    pace: 1,
    style: 'calm',
    pronunciations: {},
    fallbacks: [{ providerId: 'kokoro', voiceId: VOICE }],
  },
};

const modelDir = process.env[KOKORO_MODEL_DIR_ENV];
const engine = modelDir ? createKokoroJsEngine(modelDir) : undefined;
const skip = engine?.ready() ? false : `set ${KOKORO_MODEL_DIR_ENV} to a dir with the Kokoro model installed`;

test('speaks one WAV chunk per sentence with the real Kokoro model', { skip }, async () => {
  assert.ok(engine);
  const provider = createKokoroProvider({ engine });
  const chunks: SpeechChunk[] = [];
  try {
    for await (const chunk of provider.synthesize(UTTERANCE, VOICE, new AbortController().signal)) chunks.push(chunk);
  } finally {
    await provider.dispose();
  }
  assert.equal(chunks.length, SENTENCE_COUNT);
  assert.equal(chunks.at(-1)?.final, true);
  for (const chunk of chunks) {
    assert.equal(new TextDecoder().decode(chunk.audio.subarray(0, RIFF_HEADER_BYTES)), RIFF);
  }
});

const PUNCTUATED = {
  ...UTTERANCE,
  text: 'The door creaked open, and nobody spoke; the captain studied the map: nothing. Who goes there?',
};
const PIECE_COUNT = 5;
const SLACK_MS = 1;

test('leaves an audible silence after each clause mark with the real Kokoro model', { skip }, async () => {
  assert.ok(engine);
  const provider = createKokoroProvider({ engine });
  const chunks: SpeechChunk[] = [];
  try {
    for await (const chunk of provider.synthesize(PUNCTUATED, VOICE, new AbortController().signal)) chunks.push(chunk);
  } finally {
    await provider.dispose();
  }
  assert.equal(chunks.length, PIECE_COUNT);
  const gaps = chunks.map((chunk) => trailingSilenceMs(chunk.audio));
  const expected = [CLAUSE_PAUSE_MS[','], CLAUSE_PAUSE_MS[';'], CLAUSE_PAUSE_MS[':']];
  for (const [index, pause] of expected.entries()) assert.ok((gaps[index] ?? 0) >= pause - SLACK_MS, `gap ${index}`);
  assert.ok((gaps[3] ?? 0) > (gaps[2] ?? 0));
  assert.equal(gaps.at(-1), 0);
});
