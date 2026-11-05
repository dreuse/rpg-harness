import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMlxAudioEngine, createMlxAudioProvider, MLX_AUDIO_DIR_ENV } from './mlx-audio-engine.ts';
import { NARRATOR_SPEAKER } from './speaker-routing.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

const SAMPLES_DIR_ENV = 'RPG_VOICE_SAMPLES_DIR';
const PT_BR = 'pt-BR';
const RIFF = 'RIFF';
const RIFF_BYTES = 4;
const SAMPLE_RATE_OFFSET = 24;
const DATA_OFFSET = 44;
const KOKORO_SAMPLE_RATE = 24_000;
const PCM_BYTES = 2;
const PCM_MAX = 32_768;
const MIN_RMS = 0.01;
const MIN_SECONDS_PER_SENTENCE = 0.5;
const MAX_SECONDS_PER_SENTENCE = 12;
const MS_PER_SECOND = 1000;

const LINES = [
  {
    voice: 'pf_dora',
    speakerId: NARRATOR_SPEAKER,
    text: 'A chuva não parava havia três dias quando a caravana chegou aos portões de Varrow. As tochas chiavam sob os arcos.',
  },
  { voice: 'pm_alex', speakerId: 'npc-guard', text: 'Fala baixo. O capitão escuta tudo.' },
  {
    voice: 'pm_santa',
    speakerId: 'npc-innkeeper',
    text: 'Duas moedas de prata pelo quarto. O café da manhã é à parte.',
  },
] as const;

const utterance = (line: (typeof LINES)[number], index: number): CommittedUtterance => ({
  text: line.text,
  speakerId: line.speakerId,
  eventId: `ev-pt-${index}`,
  profile: {
    id: line.speakerId,
    language: PT_BR,
    pace: 1,
    style: 'calm',
    pronunciations: {},
    fallbacks: [{ providerId: 'kokoro-mlx', voiceId: line.voice }],
  },
});

const secondsOf = (wav: Uint8Array): number => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(SAMPLE_RATE_OFFSET, true), KOKORO_SAMPLE_RATE);
  return (wav.byteLength - DATA_OFFSET) / PCM_BYTES / KOKORO_SAMPLE_RATE;
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

const dir = process.env[MLX_AUDIO_DIR_ENV];
const samplesDir = process.env[SAMPLES_DIR_ENV];
const ready = dir !== undefined && createMlxAudioEngine({ dir }).ready();
const skip = ready ? false : `set ${MLX_AUDIO_DIR_ENV} to an installed mlx-audio dir on an Apple Silicon Mac`;

test('speaks pt-BR narration and NPC lines through the real mlx-audio service', { skip }, async (t) => {
  assert.ok(dir);
  const provider = createMlxAudioProvider({ dir });
  try {
    let started = performance.now();
    await provider.preload();
    t.diagnostic(`service start ms ${Math.round(performance.now() - started)}`);
    for (const [index, line] of LINES.entries()) {
      const chunks: SpeechChunk[] = [];
      started = performance.now();
      let firstAudioMs = 0;
      for await (const chunk of provider.synthesize(utterance(line, index), line.voice, new AbortController().signal)) {
        if (chunks.length === 0) firstAudioMs = performance.now() - started;
        chunks.push(chunk);
      }
      const totalMs = performance.now() - started;
      assert.ok(chunks.length > 0, `${line.voice} produced no audio`);
      assert.equal(chunks.at(-1)?.final, true);
      let seconds = 0;
      for (const [sequence, chunk] of chunks.entries()) {
        assert.equal(new TextDecoder().decode(chunk.audio.subarray(0, RIFF_BYTES)), RIFF);
        const chunkSeconds = secondsOf(chunk.audio);
        assert.ok(chunkSeconds >= MIN_SECONDS_PER_SENTENCE && chunkSeconds <= MAX_SECONDS_PER_SENTENCE);
        assert.ok(rmsOf(chunk.audio) > MIN_RMS, `${line.voice} sentence ${sequence} is silent`);
        seconds += chunkSeconds;
        if (samplesDir) {
          mkdirSync(samplesDir, { recursive: true });
          writeFileSync(join(samplesDir, `pt-BR-${line.voice}-${sequence}.wav`), chunk.audio);
        }
      }
      t.diagnostic(
        `${line.voice} first audio ms ${Math.round(firstAudioMs)}, audio s ${seconds.toFixed(2)}, RTF ${(totalMs / MS_PER_SECOND / seconds).toFixed(3)}`,
      );
    }
  } finally {
    await provider.dispose();
  }
});

const HTTP_UNAUTHORIZED = 401;
const HTTP_BAD_REQUEST = 400;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+\/synthesize$/;

test('the real service listens on loopback and rejects a wrong token or an unknown voice', { skip }, async () => {
  assert.ok(dir);
  const seen: { url: string; headers: Headers }[] = [];
  const spy: typeof fetch = (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return fetch(input, init);
  };
  const engine = createMlxAudioEngine({ dir, fetch: spy });
  await engine.load();
  try {
    await engine.synthesize('Olá.', 'pf_dora', new AbortController().signal, 1);
    const [{ url, headers } = assert.fail('no request')] = seen;
    assert.match(url, LOOPBACK_ORIGIN);
    const post = (authorization: string, voice: string) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Olá.', voice, speed: 1 }),
      });
    assert.equal((await post('Bearer wrong', 'pf_dora')).status, HTTP_UNAUTHORIZED);
    assert.equal((await post(headers.get('authorization') ?? '', '../../etc/passwd')).status, HTTP_BAD_REQUEST);
  } finally {
    await engine.unload();
  }
});
