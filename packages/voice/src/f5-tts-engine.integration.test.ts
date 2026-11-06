import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createF5Engine, createF5Provider, F5_DIR_ENV, F5_PROVIDER_ID } from './f5-tts-engine.ts';
import { F5_VOICES } from './f5-voices.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

const SAMPLES_DIR_ENV = 'RPG_VOICE_SAMPLES_DIR';
const RIFF = 'RIFF';
const RIFF_BYTES = 4;
const SAMPLE_RATE_OFFSET = 24;
const DATA_OFFSET = 44;
const F5_SAMPLE_RATE = 24_000;
const PCM_BYTES = 2;
const PCM_MAX = 32_768;
const MIN_RMS = 0.01;
const MS_PER_SECOND = 1000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+\/synthesize$/;
const DELIVERIES = ['neutral', 'calm', 'whisper', 'tense', 'angry', 'excited'] as const;
const LINE = 'Fala baixo. O capitão escuta tudo.';

const utterance = (voiceId: string, emotion: string): CommittedUtterance => ({
  text: LINE,
  speakerId: 'gm',
  eventId: `ev-${voiceId}-${emotion}`,
  delivery: { emotion, intensity: 1 },
  profile: {
    id: 'gm',
    language: 'pt-BR',
    pace: 1,
    style: 'calm',
    pronunciations: {},
    fallbacks: [{ providerId: F5_PROVIDER_ID, voiceId }],
  },
});

const secondsOf = (wav: Uint8Array): number => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(SAMPLE_RATE_OFFSET, true), F5_SAMPLE_RATE);
  return (wav.byteLength - DATA_OFFSET) / PCM_BYTES / F5_SAMPLE_RATE;
};

const rmsOf = (wav: Uint8Array): number => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let sum = 0;
  let count = 0;
  for (let offset = DATA_OFFSET; offset + PCM_BYTES <= wav.byteLength; offset += PCM_BYTES) {
    sum += (view.getInt16(offset, true) / PCM_MAX) ** 2;
    count += 1;
  }
  return Math.sqrt(sum / Math.max(count, 1));
};

const dir = process.env[F5_DIR_ENV];
const samplesDir = process.env[SAMPLES_DIR_ENV];
const ready = dir !== undefined && createF5Engine({ dir }).ready();
const skip = ready ? false : `set ${F5_DIR_ENV} to an installed F5-TTS dir`;

test('speaks pt-BR with every reference voice and delivery through the real F5-TTS service', { skip }, async (t) => {
  assert.ok(dir);
  const provider = createF5Provider({ dir, shaping: false });
  try {
    let started = performance.now();
    await provider.preload();
    t.diagnostic(`service start ms ${Math.round(performance.now() - started)}`);
    for (const voice of F5_VOICES) {
      for (const emotion of DELIVERIES) {
        const chunks: SpeechChunk[] = [];
        started = performance.now();
        let firstAudioMs = 0;
        for await (const chunk of provider.synthesize(
          utterance(voice.id, emotion),
          voice.id,
          new AbortController().signal,
        )) {
          if (chunks.length === 0) firstAudioMs = performance.now() - started;
          chunks.push(chunk);
        }
        const totalMs = performance.now() - started;
        assert.ok(chunks.length > 0, `${voice.id} ${emotion} produced no audio`);
        let seconds = 0;
        for (const [sequence, chunk] of chunks.entries()) {
          assert.equal(new TextDecoder().decode(chunk.audio.subarray(0, RIFF_BYTES)), RIFF);
          assert.ok(rmsOf(chunk.audio) > MIN_RMS, `${voice.id} ${emotion} ${sequence} is silent`);
          seconds += secondsOf(chunk.audio);
          if (samplesDir) {
            mkdirSync(samplesDir, { recursive: true });
            writeFileSync(join(samplesDir, `${voice.id}-${emotion}-${sequence}.wav`), chunk.audio);
          }
        }
        t.diagnostic(
          `${voice.id} ${emotion} first audio ms ${Math.round(firstAudioMs)}, audio s ${seconds.toFixed(2)}, RTF ${(totalMs / MS_PER_SECOND / seconds).toFixed(3)}`,
        );
      }
    }
  } finally {
    await provider.dispose();
  }
});

test('the real service listens on loopback and rejects a wrong token or an unknown voice', { skip }, async () => {
  assert.ok(dir);
  const seen: { url: string; headers: Headers }[] = [];
  const spy: typeof fetch = (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return fetch(input, init);
  };
  const engine = createF5Engine({ dir, fetch: spy });
  await engine.load();
  try {
    await engine.synthesize('Olá.', F5_VOICES[0]?.id ?? '', new AbortController().signal, 1);
    const [{ url, headers } = assert.fail('no request')] = seen;
    assert.match(url, LOOPBACK_ORIGIN);
    const post = (authorization: string, voice: string) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Olá.', voice, speed: 1 }),
      });
    assert.equal((await post('Bearer wrong', F5_VOICES[0]?.id ?? '')).status, HTTP_UNAUTHORIZED);
    assert.equal((await post(headers.get('authorization') ?? '', '../../etc/passwd')).status, HTTP_BAD_REQUEST);
  } finally {
    await engine.unload();
  }
});
