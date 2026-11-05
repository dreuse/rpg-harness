import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeWav,
  encodeWav,
  KOKORO_DELIVERY_PAUSE,
  normaliseLoudness,
  PARAGRAPH_PAUSE_MS,
  SCENE_BREAK_PAUSE_MS,
  shapeAudio,
  shapeSentences,
  type Wav,
} from './delivery-shaping.ts';
import { KOKORO_DELIVERY_SPEED } from './kokoro-provider.ts';

const RATE = 24_000;
const MS_PER_SECOND = 1000;
const TONE_SAMPLES = 2400;
const TONE_PERIOD = 24;
const HEADER_BYTES = 44;
const PCM_BITS = 16;
const FLOAT_BITS = 32;
const FLOAT_FORMAT = 3;
const PCM_FORMAT = 1;
const QUIET = 0.02;
const LOUD = 0.9;
const TARGET_RMS = 0.1;
const NEAR = 0.01;
const NEAR_RMS = 0.002;
const HOT_PEAK = 0.99;

const tone = (amplitude: number, bits = PCM_BITS, count = TONE_SAMPLES): Wav => ({
  format: bits === FLOAT_BITS ? FLOAT_FORMAT : PCM_FORMAT,
  bits,
  channels: 1,
  sampleRate: RATE,
  samples: Float32Array.from({ length: count }, (_, i) => amplitude * Math.sin((2 * Math.PI * i) / TONE_PERIOD)),
});

const rmsOf = (samples: Float32Array): number =>
  Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(samples.length, 1));

const peakOf = (samples: Float32Array): number => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);

const pauses = (text: string, delivery?: Parameters<typeof shapeSentences>[1]) =>
  shapeSentences(text, delivery).map(({ pauseMs }) => pauseMs);

test('pauses differ by terminal punctuation and the last sentence has none', () => {
  const [period, exclamation, question, last] = pauses('One. Two! Three? Four.');
  assert.ok(period !== undefined && exclamation !== undefined && question !== undefined);
  assert.ok(exclamation < period && period < question);
  assert.equal(last, 0);
  assert.deepEqual(
    shapeSentences('One. Two!').map(({ sentence }) => sentence),
    ['One.', 'Two!'],
  );
});

test('an ellipsis, spoken or typed with three dots, pauses longest', () => {
  const stop = pauses('— Wait.\n— Who?')[0] ?? 0;
  assert.ok((pauses('— Wait…\n— Who?')[0] ?? 0) > stop);
  assert.equal(pauses('— Wait...\n— Who?')[0], pauses('— Wait…\n— Who?')[0]);
});

test('a closing quote does not hide the terminal punctuation', () => {
  assert.equal(pauses('“Go.” Run.')[0], pauses('Go. Run.')[0]);
});

test('a pause is longer before a sentence that opens dialogue', () => {
  const plain = pauses('He waited. Nothing came.')[0] ?? 0;
  for (const opening of ['“Who?”', '"Who?"', '«Quem?»']) {
    assert.ok((pauses(`He waited. ${opening}`)[0] ?? 0) > plain, opening);
  }
});

test('a dialogue dash at the start of a line opens dialogue', () => {
  assert.ok((pauses('He waited.\n— Who?')[0] ?? 0) > (pauses('He waited.\nNothing came.')[0] ?? 0));
});

test('emotion scales pauses: tense is shorter, calm and sad are longer', () => {
  const base = pauses('One. Two.')[0] ?? 0;
  const tense = pauses('One. Two.', { emotion: 'tense' })[0] ?? 0;
  const calm = pauses('One. Two.', { emotion: 'calm' })[0] ?? 0;
  const sad = pauses('One. Two.', { emotion: 'sad' })[0] ?? 0;
  assert.ok(tense < base && base < calm && calm < sad);
  assert.equal(pauses('One. Two.', { emotion: 'tense', intensity: 0 })[0], base);
  assert.equal(pauses('One. Two.', { emotion: 'smug' })[0], base);
  assert.equal(pauses('One. Two.', { emotion: 'toString' })[0], base);
});

test('every speed emotion has a pause scale', () => {
  assert.deepEqual(Object.keys(KOKORO_DELIVERY_PAUSE).sort(), Object.keys(KOKORO_DELIVERY_SPEED).sort());
});

test('paragraph and scene breaks add longer silence and the marker is not spoken', () => {
  const sentences = shapeSentences('The gate shut.\n\nDawn came.\n\n***\n\nThree days later.\nIt rained.\n---\nEnd.');
  assert.deepEqual(
    sentences.map(({ sentence }) => sentence),
    ['The gate shut.', 'Dawn came.', 'Three days later.', 'It rained.', 'End.'],
  );
  assert.deepEqual(
    sentences.map(({ pauseMs }) => pauseMs >= PARAGRAPH_PAUSE_MS),
    [true, true, false, true, false],
  );
  assert.equal(sentences[1]?.pauseMs, SCENE_BREAK_PAUSE_MS);
  assert.equal(sentences[3]?.pauseMs, SCENE_BREAK_PAUSE_MS);
  assert.ok(!sentences.some(({ sentence }) => /[*-]{3}/.test(sentence)));
});

test('a text with only a scene marker has nothing to speak', () => {
  assert.deepEqual(shapeSentences('***'), []);
  assert.deepEqual(shapeSentences('  \n '), []);
});

test('decodes and re-encodes PCM and float WAV without changing the samples', () => {
  for (const bits of [PCM_BITS, FLOAT_BITS]) {
    const original = tone(0.5, bits);
    const bytes = encodeWav(original);
    assert.equal(bytes.byteLength, HEADER_BYTES + original.samples.length * (bits / 8));
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
    const decoded = decodeWav(bytes);
    assert.ok(decoded);
    assert.equal(decoded.sampleRate, RATE);
    assert.equal(decoded.bits, bits);
    assert.equal(decoded.channels, 1);
    assert.deepEqual(encodeWav(decoded), bytes);
  }
});

test('refuses bytes that are not a supported WAV', () => {
  assert.equal(decodeWav(new TextEncoder().encode('The door creaks.')), undefined);
  assert.equal(decodeWav(new Uint8Array()), undefined);
  assert.equal(decodeWav(encodeWav({ ...tone(0.5), format: 6 })), undefined);
});

test('normalises quiet and loud chunks to the same RMS and keeps silence silent', () => {
  const quiet = decodeWav(normaliseLoudness(encodeWav(tone(QUIET))));
  const loud = decodeWav(normaliseLoudness(encodeWav(tone(LOUD))));
  assert.ok(quiet && loud);
  assert.ok(Math.abs(rmsOf(quiet.samples) - TARGET_RMS) < NEAR_RMS);
  assert.ok(Math.abs(rmsOf(loud.samples) - TARGET_RMS) < NEAR_RMS);
  const silent = encodeWav(tone(0));
  assert.deepEqual(normaliseLoudness(silent), silent);
});

test('limits the peak instead of clipping when the target RMS would exceed it', () => {
  const spiky = tone(0.05);
  spiky.samples[10] = HOT_PEAK / 2;
  const out = decodeWav(normaliseLoudness(encodeWav(spiky)));
  assert.ok(out);
  assert.ok(peakOf(out.samples) <= HOT_PEAK);
  assert.ok(peakOf(out.samples) > HOT_PEAK - NEAR * 10);
});

test('leaves bytes that are not a WAV unchanged', () => {
  const bytes = new TextEncoder().encode('The door creaks.');
  assert.deepEqual(normaliseLoudness(bytes), bytes);
  assert.deepEqual(shapeAudio(bytes, 500), bytes);
});

test('shapeAudio appends exactly the requested silence as a valid WAV', () => {
  const pauseMs = 250;
  const bytes = shapeAudio(encodeWav(tone(QUIET)), pauseMs);
  const shaped = decodeWav(bytes);
  assert.ok(shaped);
  const silenceSamples = (RATE * pauseMs) / MS_PER_SECOND;
  assert.equal(shaped.samples.length, TONE_SAMPLES + silenceSamples);
  assert.equal(peakOf(shaped.samples.subarray(TONE_SAMPLES)), 0);
  assert.ok(rmsOf(shaped.samples.subarray(0, TONE_SAMPLES)) > 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
  assert.equal(view.getUint32(40, true), bytes.byteLength - HEADER_BYTES);
  assert.equal(shapeAudio(encodeWav(tone(QUIET)), 0).byteLength, encodeWav(tone(QUIET)).byteLength);
});
