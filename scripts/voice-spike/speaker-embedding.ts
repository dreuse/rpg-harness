import type { OnnxRuntime, OnnxSession } from '../../packages/voice/src/kokoro-onnx-engine.ts';

export const SPEAKER_SAMPLE_RATE = 16_000;
export const FBANK_FRAME_SAMPLES = 400;
export const FBANK_HOP_SAMPLES = 160;
export const FBANK_BINS = 80;

const FFT_SIZE = 512;
const SPECTRUM_BINS = FFT_SIZE / 2;
const LOW_HZ = 20;
const PREEMPHASIS = 0.97;
const POVEY_POWER = 0.85;
const MEL_SCALE_HZ = 700;
const MEL_SCALE_FACTOR = 1127;
const INT16_SCALE = 32_768;
const LOG_FLOOR = 1.1920929e-7;
const RESAMPLE_HALF_TAPS = 16;
const FEATURE_INPUT = 'feats';
const EMBEDDING_OUTPUT = 'embs';
const FLOAT32 = 'float32';
const BATCH = 1;

const melOf = (hz: number): number => MEL_SCALE_FACTOR * Math.log(1 + hz / MEL_SCALE_HZ);

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

export const resample = (samples: Float32Array, from: number, to: number): Float32Array => {
  if (from === to) return samples;
  const cutoff = Math.min(1, to / from);
  const half = RESAMPLE_HALF_TAPS / cutoff;
  const length = Math.round((samples.length * to) / from);
  return Float32Array.from({ length }, (_, n) => {
    const centre = (n * from) / to;
    let sum = 0;
    for (let m = Math.ceil(centre - half); m <= Math.floor(centre + half); m++) {
      const value = samples[m];
      if (value === undefined) continue;
      const offset = centre - m;
      sum += value * cutoff * sinc(cutoff * offset) * (0.5 + 0.5 * Math.cos((Math.PI * offset) / half));
    }
    return sum;
  });
};

const window = Float64Array.from(
  { length: FBANK_FRAME_SAMPLES },
  (_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME_SAMPLES - 1))) ** POVEY_POWER,
);

const melFilters = (): Float64Array[] => {
  const binHz = SPEAKER_SAMPLE_RATE / FFT_SIZE;
  const lowMel = melOf(LOW_HZ);
  const step = (melOf(SPEAKER_SAMPLE_RATE / 2) - lowMel) / (FBANK_BINS + 1);
  return Array.from({ length: FBANK_BINS }, (_, bin) => {
    const [left, centre, right] = [0, 1, 2].map((offset) => lowMel + (bin + offset) * step) as [number, number, number];
    return Float64Array.from({ length: SPECTRUM_BINS }, (_, j) => {
      const mel = melOf(j * binHz);
      if (mel <= left || mel >= right) return 0;
      return mel <= centre ? (mel - left) / (centre - left) : (right - mel) / (right - centre);
    });
  });
};

const FILTERS = melFilters();

const fft = (re: Float64Array, im: Float64Array): void => {
  const size = re.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < length / 2; k++) {
        const [cos, sin] = [Math.cos(angle * k), Math.sin(angle * k)];
        const a = start + k;
        const b = a + length / 2;
        const tr = (re[b] as number) * cos - (im[b] as number) * sin;
        const ti = (re[b] as number) * sin + (im[b] as number) * cos;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
};

const frameSpectrum = (samples: Float32Array, start: number): Float64Array => {
  const frame = Float64Array.from({ length: FBANK_FRAME_SAMPLES }, (_, i) => (samples[start + i] ?? 0) * INT16_SCALE);
  const mean = frame.reduce((sum, value) => sum + value, 0) / frame.length;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FBANK_FRAME_SAMPLES; i++) {
    const previous = (frame[Math.max(i - 1, 0)] as number) - mean;
    re[i] = ((frame[i] as number) - mean - PREEMPHASIS * previous) * (window[i] as number);
  }
  fft(re, im);
  return Float64Array.from({ length: SPECTRUM_BINS }, (_, j) => (re[j] as number) ** 2 + (im[j] as number) ** 2);
};

export const logMelFrames = (samples: Float32Array): Float64Array[] => {
  const count =
    samples.length < FBANK_FRAME_SAMPLES
      ? 0
      : 1 + Math.floor((samples.length - FBANK_FRAME_SAMPLES) / FBANK_HOP_SAMPLES);
  return Array.from({ length: count }, (_, index) => {
    const power = frameSpectrum(samples, index * FBANK_HOP_SAMPLES);
    return Float64Array.from(FILTERS, (filter) =>
      Math.log(
        Math.max(
          filter.reduce((sum, weight, j) => sum + weight * (power[j] as number), 0),
          LOG_FLOOR,
        ),
      ),
    );
  });
};

export const meanNormalise = (frames: Float64Array[]): Float64Array[] => {
  const means = Float64Array.from(
    { length: FBANK_BINS },
    (_, bin) => frames.reduce((sum, frame) => sum + (frame[bin] as number), 0) / frames.length,
  );
  return frames.map((frame) => frame.map((value, bin) => value - (means[bin] as number)));
};

export const cosineSimilarity = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    normA += (a[i] as number) ** 2;
    normB += (b[i] as number) ** 2;
  }
  return dot / Math.sqrt(normA * normB);
};

export type SpeakerEmbedder = (samples: Float32Array, sampleRate: number) => Promise<Float32Array>;

export const createSpeakerEmbedder = async (modelPath: string, runtime: OnnxRuntime): Promise<SpeakerEmbedder> => {
  const session: OnnxSession = await runtime.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  return async (samples, sampleRate) => {
    const frames = meanNormalise(logMelFrames(resample(samples, sampleRate, SPEAKER_SAMPLE_RATE)));
    const feats = Float32Array.from(frames.flatMap((frame) => [...frame]));
    const output = await session.run({
      [FEATURE_INPUT]: new runtime.Tensor(FLOAT32, feats, [BATCH, frames.length, FBANK_BINS]),
    });
    const embedding = output[EMBEDDING_OUTPUT];
    if (!embedding) throw new Error('speaker model returned no embedding');
    return Float32Array.from(embedding.data);
  };
};
