import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DUCK_FACTOR } from '../../packages/voice/src/ambience.ts';
import { decodeWav, encodeWav } from '../../packages/voice/src/delivery-shaping.ts';
import {
  DEMO_FILE,
  DEMO_LEAD_SECONDS,
  mixDemo,
  placeholderAmbience,
  placeholderNarration,
  writeSoundDemo,
} from './sound-demo.ts';

const RATE = 8000;
const NARRATION_SECONDS = 2;
const AMBIENCE_LEVEL = 0.2;
const TOLERANCE = 0.2;

const rms = (samples: Float32Array, from: number, to: number): number => {
  const slice = samples.subarray(Math.floor(from * RATE), Math.floor(to * RATE));
  return Math.sqrt(slice.reduce((sum, sample) => sum + sample * sample, 0) / slice.length);
};

test('placeholder ambience is deterministic and bounded', () => {
  const first = placeholderAmbience(1, RATE);
  assert.deepEqual(first, placeholderAmbience(1, RATE));
  assert.equal(first.length, RATE);
  assert.ok(first.every((sample) => Math.abs(sample) <= 1));
});

test('the mix ducks ambience under narration and restores it afterwards', () => {
  const narration = new Float32Array(NARRATION_SECONDS * RATE);
  const mixed = mixDemo({
    narration,
    rate: RATE,
    ambience: placeholderAmbience(30, RATE),
    ambienceLevel: AMBIENCE_LEVEL,
  });
  const before = rms(mixed, 1, DEMO_LEAD_SECONDS - 0.5);
  const during = rms(mixed, DEMO_LEAD_SECONDS + 0.5, DEMO_LEAD_SECONDS + NARRATION_SECONDS - 0.5);
  const after = rms(mixed, DEMO_LEAD_SECONDS + NARRATION_SECONDS + 1.5, DEMO_LEAD_SECONDS + NARRATION_SECONDS + 2.5);
  assert.ok(Math.abs(during / before - DUCK_FACTOR) < TOLERANCE * DUCK_FACTOR, `ratio ${during / before}`);
  assert.ok(Math.abs(after / before - 1) < TOLERANCE, `ratio ${after / before}`);
});

test('narration stays audible on top of the ambience', () => {
  const narration = placeholderNarration(NARRATION_SECONDS, RATE);
  const mixed = mixDemo({
    narration,
    rate: RATE,
    ambience: placeholderAmbience(30, RATE),
    ambienceLevel: AMBIENCE_LEVEL,
  });
  assert.ok(mixed.every((sample) => Math.abs(sample) <= 1));
  assert.ok(rms(mixed, DEMO_LEAD_SECONDS + 0.2, DEMO_LEAD_SECONDS + 1) > rms(narration, 0.2, 1) * 0.5);
});

test('writes a labelled placeholder mix to the samples directory using real narration when present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-demo-'));
  try {
    const narration = encodeWav({
      format: 1,
      bits: 16,
      channels: 1,
      sampleRate: RATE,
      samples: placeholderNarration(NARRATION_SECONDS, RATE),
    });
    const file = await writeSoundDemo(dir, narration);
    assert.equal(file, join(dir, DEMO_FILE));
    assert.deepEqual(await readdir(dir), [DEMO_FILE]);
    const wav = decodeWav(new Uint8Array(await readFile(file)));
    assert.equal(wav?.sampleRate, RATE);
    assert.ok((wav?.samples.length ?? 0) > (DEMO_LEAD_SECONDS + NARRATION_SECONDS) * RATE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes a placeholder narration when none is supplied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-demo-'));
  try {
    const file = await writeSoundDemo(dir);
    assert.ok((await readFile(file)).byteLength > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
