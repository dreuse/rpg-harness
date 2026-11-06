import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FBANK_BINS,
  FBANK_FRAME_SAMPLES,
  FBANK_HOP_SAMPLES,
  logMelFrames,
  meanNormalise,
  resample,
  SPEAKER_SAMPLE_RATE,
} from './speaker-embedding.ts';

const SECOND_SAMPLES = SPEAKER_SAMPLE_RATE;
const TONE_AMPLITUDE = 0.5;
const LOW_TONE_HZ = 300;
const HIGH_TONE_HZ = 3000;
const SOURCE_RATE = 24_000;
const SOURCE_SAMPLES = 24_000;
const TONE_HZ = 1000;
const GAIN_TOLERANCE = 0.05;
const MEAN_TOLERANCE = 1e-9;

const tone = (hz: number, rate: number, samples: number): Float32Array =>
  Float32Array.from({ length: samples }, (_, i) => TONE_AMPLITUDE * Math.sin((2 * Math.PI * hz * i) / rate));

const rms = (samples: Float32Array): number =>
  Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

const peakBin = (frame: Float64Array): number => frame.indexOf(Math.max(...frame));

test('rpg-cm63.63 resample keeps duration and tone level', () => {
  const out = resample(tone(TONE_HZ, SOURCE_RATE, SOURCE_SAMPLES), SOURCE_RATE, SPEAKER_SAMPLE_RATE);
  assert.equal(out.length, SECOND_SAMPLES);
  const middle = out.slice(SECOND_SAMPLES / 4, (3 * SECOND_SAMPLES) / 4);
  assert.ok(Math.abs(rms(middle) - TONE_AMPLITUDE / Math.SQRT2) < GAIN_TOLERANCE);
});

test('rpg-cm63.63 resample at the same rate returns the input', () => {
  const input = tone(TONE_HZ, SPEAKER_SAMPLE_RATE, FBANK_FRAME_SAMPLES);
  assert.deepEqual(resample(input, SPEAKER_SAMPLE_RATE, SPEAKER_SAMPLE_RATE), input);
});

test('rpg-cm63.63 log mel frames have the expected count and bins', () => {
  const frames = logMelFrames(tone(LOW_TONE_HZ, SPEAKER_SAMPLE_RATE, SECOND_SAMPLES));
  assert.equal(frames.length, 1 + Math.floor((SECOND_SAMPLES - FBANK_FRAME_SAMPLES) / FBANK_HOP_SAMPLES));
  for (const frame of frames) assert.equal(frame.length, FBANK_BINS);
});

test('rpg-cm63.63 a higher tone peaks in a higher mel bin', () => {
  const low = logMelFrames(tone(LOW_TONE_HZ, SPEAKER_SAMPLE_RATE, SECOND_SAMPLES))[10];
  const high = logMelFrames(tone(HIGH_TONE_HZ, SPEAKER_SAMPLE_RATE, SECOND_SAMPLES))[10];
  assert.ok(low && high);
  assert.ok(peakBin(high) > peakBin(low));
});

test('rpg-cm63.63 audio shorter than one frame has no frames', () => {
  assert.deepEqual(logMelFrames(new Float32Array(FBANK_FRAME_SAMPLES - 1)), []);
});

test('rpg-cm63.63 mean normalisation zeroes every bin mean', () => {
  const frames = meanNormalise(logMelFrames(tone(LOW_TONE_HZ, SPEAKER_SAMPLE_RATE, SECOND_SAMPLES)));
  for (let bin = 0; bin < FBANK_BINS; bin++) {
    const mean = frames.reduce((sum, frame) => sum + (frame[bin] ?? 0), 0) / frames.length;
    assert.ok(Math.abs(mean) < MEAN_TOLERANCE);
  }
});
