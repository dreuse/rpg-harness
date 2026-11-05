import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DUCK_FACTOR } from '../../packages/voice/src/ambience.ts';
import { decodeWav, encodeWav } from '../../packages/voice/src/delivery-shaping.ts';
import { SAMPLES_DIR_ENV } from './run.ts';

export const DEMO_FILE = 'sound-demo-PLACEHOLDER-ambience.wav';
export const NARRATION_SAMPLE_FILE = 'en-US-narration-after.wav';
export const DEMO_LEAD_SECONDS = 3;
const DEMO_TAIL_SECONDS = 3;
const DUCK_RAMP_SECONDS = 0.15;
const FADE_IN_SECONDS = 2;
const DEFAULT_AMBIENCE_LEVEL = 0.25;
const DEFAULT_RATE = 24_000;
const DEFAULT_NARRATION_SECONDS = 6;
const NARRATION_PEAK = 0.5;
const SYLLABLE_HZ = 4;
const VOICE_HZ = 140;
const RAIN_SMOOTHING = 0.4;
const RAIN_GAIN = 0.75;
const RUMBLE_SMOOTHING = 0.002;
const RUMBLE_GAIN = 1.2;
const AMBIENCE_LOOP_SECONDS = 30;
const LCG_MULTIPLIER = 1_664_525;
const LCG_INCREMENT = 1_013_904_223;
const LCG_MODULUS = 2 ** 32;
const PCM_FORMAT = 1;
const PCM_BITS = 16;
const MONO = 1;
const FULL_SCALE = 1;

export interface DemoMix {
  readonly narration: Float32Array;
  readonly rate: number;
  readonly ambience: Float32Array;
  readonly ambienceLevel?: number;
}

export const placeholderAmbience = (seconds: number, rate: number): Float32Array => {
  let seed = 1;
  const noise = () => {
    seed = (seed * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
    return (seed / LCG_MODULUS) * 2 - 1;
  };
  let rain = 0;
  let rumble = 0;
  return Float32Array.from({ length: Math.round(seconds * rate) }, () => {
    const white = noise();
    rain += RAIN_SMOOTHING * (white - rain);
    rumble += RUMBLE_SMOOTHING * (white - rumble);
    return Math.max(-FULL_SCALE, Math.min(FULL_SCALE, rain * RAIN_GAIN + rumble * RUMBLE_GAIN));
  });
};

export const placeholderNarration = (seconds: number, rate: number): Float32Array =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, index) => {
    const time = index / rate;
    const syllable = Math.abs(Math.sin(Math.PI * SYLLABLE_HZ * time));
    return NARRATION_PEAK * syllable * Math.sin(2 * Math.PI * VOICE_HZ * time);
  });

export const mixDemo = ({
  narration,
  rate,
  ambience,
  ambienceLevel = DEFAULT_AMBIENCE_LEVEL,
}: DemoMix): Float32Array => {
  const start = DEMO_LEAD_SECONDS * rate;
  const end = start + narration.length;
  const total = end + DEMO_TAIL_SECONDS * rate;
  const ramp = DUCK_RAMP_SECONDS * rate;
  const fadeIn = FADE_IN_SECONDS * rate;
  return Float32Array.from({ length: total }, (_, index) => {
    const ducking = Math.min(FULL_SCALE, Math.max(0, Math.min(index - start, end - index) / ramp + 1));
    const duck = FULL_SCALE - ducking * (FULL_SCALE - DUCK_FACTOR);
    const gain = ambienceLevel * duck * Math.min(FULL_SCALE, index / fadeIn);
    const sample = (ambience[index % ambience.length] ?? 0) * gain + (narration[index - start] ?? 0);
    return Math.max(-FULL_SCALE, Math.min(FULL_SCALE, sample));
  });
};

export const writeSoundDemo = async (dir: string, narrationWav?: Uint8Array): Promise<string> => {
  const real = narrationWav === undefined ? undefined : decodeWav(narrationWav);
  const rate = real?.sampleRate ?? DEFAULT_RATE;
  const narration = real?.samples ?? placeholderNarration(DEFAULT_NARRATION_SECONDS, rate);
  const mixed = mixDemo({ narration, rate, ambience: placeholderAmbience(AMBIENCE_LOOP_SECONDS, rate) });
  await mkdir(dir, { recursive: true });
  const file = join(dir, DEMO_FILE);
  await writeFile(
    file,
    encodeWav({ format: PCM_FORMAT, bits: PCM_BITS, channels: MONO, sampleRate: rate, samples: mixed }),
  );
  return file;
};

if (import.meta.main) {
  const dir = process.env[SAMPLES_DIR_ENV];
  if (!dir) {
    console.error(`set ${SAMPLES_DIR_ENV}`);
    process.exit(1);
  }
  const narration = await readFile(join(dir, NARRATION_SAMPLE_FILE)).catch(() => undefined);
  console.log(await writeSoundDemo(dir, narration));
}
