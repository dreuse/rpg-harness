import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeWav, encodeWav } from '../../packages/voice/src/delivery-shaping.ts';
import {
  KOKORO_CAPABILITIES,
  KOKORO_PROVIDER_ID,
  type KokoroEngine,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
  type VoiceBlend,
} from '../../packages/voice/src/kokoro-provider.ts';
import { NARRATOR_SPEAKER } from '../../packages/voice/src/speaker-routing.ts';
import { SAMPLE_LINES, type SampleTarget, writeSamples } from './run.ts';

const RATE = 24_000;
const TONE_SAMPLES = 4800;
const TONE_AMPLITUDE = 0.02;

const toneEngine = (blends: boolean, seen: Array<VoiceBlend | undefined>): KokoroEngine => ({
  blends,
  ready: () => true,
  load: async () => {},
  unload: async () => {},
  synthesize: async (_sentence, _voice, _signal, _speed, blend) => {
    seen.push(blend);
    return encodeWav({
      format: 1,
      bits: 16,
      channels: 1,
      sampleRate: RATE,
      samples: Float32Array.from({ length: TONE_SAMPLES }, (_, i) => TONE_AMPLITUDE * Math.sin(i / 4)),
    });
  },
});

const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-samples-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const targets = (seen: Array<VoiceBlend | undefined>): SampleTarget[] => [
  { language: 'en-US', id: KOKORO_PROVIDER_ID, capabilities: KOKORO_CAPABILITIES, engine: toneEngine(false, seen) },
  {
    language: 'pt-BR',
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    engine: toneEngine(true, seen),
  },
];

test('has English and pt-BR lines, each with a narrator and an NPC each', () => {
  for (const language of ['en-US', 'pt-BR']) {
    const lines = SAMPLE_LINES.filter((line) => line.language === language);
    assert.ok(lines.some((line) => line.speakerId === NARRATOR_SPEAKER));
    assert.ok(lines.some((line) => line.speakerId !== NARRATOR_SPEAKER));
  }
});

test('writes a before and an after WAV for every line, and the after file carries the pauses', async () => {
  await withDir(async (dir) => {
    const files = await writeSamples(targets([]), dir);
    assert.equal(files.length, SAMPLE_LINES.length * 2);
    assert.deepEqual((await readdir(dir)).sort(), files.map((file) => file.split('/').pop()).sort());
    for (const line of SAMPLE_LINES) {
      const before = decodeWav(new Uint8Array(await readFile(join(dir, `${line.language}-${line.name}-before.wav`))));
      const after = decodeWav(new Uint8Array(await readFile(join(dir, `${line.language}-${line.name}-after.wav`))));
      assert.ok(before && after);
      assert.equal(after.sampleRate, RATE);
      assert.ok(after.samples.length > before.samples.length, line.name);
    }
  });
});

test('only the shaped files use a blend, and only on an engine that can blend', async () => {
  await withDir(async (dir) => {
    const seen: Array<VoiceBlend | undefined> = [];
    await writeSamples(targets(seen), dir);
    assert.ok(seen.some((blend) => blend !== undefined));
    assert.ok(seen.some((blend) => blend === undefined));
  });
});

test('skips a target whose engine is not ready', async () => {
  await withDir(async (dir) => {
    const [english, portuguese] = targets([]);
    assert.ok(english && portuguese);
    const files = await writeSamples(
      [english, { ...portuguese, engine: { ...portuguese.engine, ready: () => false } }],
      dir,
    );
    assert.ok(files.length > 0);
    assert.ok(files.every((file) => file.includes('en-US')));
  });
});
