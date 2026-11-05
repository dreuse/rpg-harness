import type { Delivery } from './voice.ts';

export interface Wav {
  readonly format: number;
  readonly bits: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

export interface ShapedSentence {
  readonly sentence: string;
  readonly pauseMs: number;
}

export const KOKORO_DELIVERY_PAUSE = Object.freeze({
  neutral: 1,
  tense: 0.6,
  fearful: 0.7,
  angry: 0.75,
  excited: 0.8,
  happy: 0.9,
  whisper: 1.2,
  calm: 1.3,
  tender: 1.3,
  sad: 1.5,
});

export const PARAGRAPH_PAUSE_MS = 600;
export const SCENE_BREAK_PAUSE_MS = 1400;
export const TARGET_RMS = 0.1;
export const PEAK_LIMIT = 0.98;

const SEGMENTER_LOCALE = 'en';
const DEFAULT_PAUSE_MS = 250;
const DIALOGUE_LEAD_PAUSE_MS = 150;
const TERMINAL_PAUSE_MS: Readonly<Record<string, number>> = Object.freeze({
  '.': 350,
  '!': 300,
  '?': 400,
  '…': 500,
});
const ASCII_ELLIPSIS = '...';
const UNICODE_ELLIPSIS = '…';
const CLOSING_MARKS = /["'”’»)\]]+$/;
const DIALOGUE_START = /^["“«'‘—–-]/;
const DIALOGUE_DASH = /^[—–]/;
const SCENE_MARKER = /^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/;
const LINE_BREAK = /\r?\n/;
const NEUTRAL = 1;
const FULL_INTENSITY = 1;
const NO_INTENSITY = 0;
const SILENCE_RMS = 0.001;
const MAX_GAIN = 8;
const MS_PER_SECOND = 1000;
const SEMITONES_PER_OCTAVE = 12;

const PCM_FORMAT = 1;
const FLOAT_FORMAT = 3;
const PCM_BITS = 16;
const FLOAT_BITS = 32;
const PCM_SCALE = 32768;
const PCM_MAX = 32767;
const BITS_PER_BYTE = 8;
const HEADER_BYTES = 44;
const RIFF_SIZE_OFFSET = 4;
const CHUNK_HEADER_BYTES = 8;
const RIFF_HEADER_BYTES = 12;
const FMT_CHUNK_BYTES = 16;
const TAG_BYTES = 4;
const FMT_FORMAT_OFFSET = 8;
const FMT_CHANNELS_OFFSET = 10;
const FMT_RATE_OFFSET = 12;
const FMT_BITS_OFFSET = 22;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const pauseScale = (delivery: Delivery | undefined): number => {
  const emotion = delivery?.emotion;
  const scale =
    typeof emotion === 'string' && Object.hasOwn(KOKORO_DELIVERY_PAUSE, emotion)
      ? KOKORO_DELIVERY_PAUSE[emotion as keyof typeof KOKORO_DELIVERY_PAUSE]
      : NEUTRAL;
  const intensity = clamp(finiteOr(delivery?.intensity, FULL_INTENSITY), NO_INTENSITY, FULL_INTENSITY);
  return NEUTRAL + (scale - NEUTRAL) * intensity;
};

const terminalOf = (sentence: string): string => {
  const bare = sentence.replace(CLOSING_MARKS, '');
  return bare.endsWith(ASCII_ELLIPSIS) ? UNICODE_ELLIPSIS : bare.slice(-1);
};

type Break = 'none' | 'paragraph' | 'scene';

const BREAK_PAUSE_MS: Readonly<Record<Break, number>> = Object.freeze({
  none: 0,
  paragraph: PARAGRAPH_PAUSE_MS,
  scene: SCENE_BREAK_PAUSE_MS,
});

interface Block {
  readonly text: string;
  after: Break;
}

const blocksOf = (text: string): Block[] => {
  const blocks: Block[] = [];
  let lines: string[] = [];
  const flush = (after: Break): void => {
    const last = blocks.at(-1);
    if (lines.length > 0) blocks.push({ text: lines.join(' '), after });
    else if (last && after === 'scene') last.after = after;
    lines = [];
  };
  for (const line of text.split(LINE_BREAK)) {
    if (SCENE_MARKER.test(line)) flush('scene');
    else if (line.trim() === '') flush('paragraph');
    else {
      if (DIALOGUE_DASH.test(line.trim())) flush('none');
      lines.push(line.trim());
    }
  }
  flush('none');
  return blocks;
};

const segmenter = new Intl.Segmenter(SEGMENTER_LOCALE, { granularity: 'sentence' });

const sentencesOf = (text: string): string[] =>
  [...segmenter.segment(text)].map(({ segment }) => segment.trim()).filter((sentence) => sentence !== '');

export const shapeSentences = (text: string, delivery?: Delivery): ShapedSentence[] => {
  const scale = pauseScale(delivery);
  const flat = blocksOf(text).flatMap(({ text: block, after }) =>
    sentencesOf(block).map((sentence, index, all) => ({
      sentence,
      breakMs: index === all.length - 1 ? BREAK_PAUSE_MS[after] : 0,
    })),
  );
  return flat.map(({ sentence, breakMs }, index) => {
    if (index === flat.length - 1) return { sentence, pauseMs: 0 };
    const lead = DIALOGUE_START.test(flat[index + 1]?.sentence ?? '') ? DIALOGUE_LEAD_PAUSE_MS : 0;
    const spoken = (TERMINAL_PAUSE_MS[terminalOf(sentence)] ?? DEFAULT_PAUSE_MS) + lead;
    return { sentence, pauseMs: Math.max(Math.round(spoken * scale), breakMs) };
  });
};

const tagAt = (bytes: Uint8Array, offset: number): string => DECODER.decode(bytes.subarray(offset, offset + TAG_BYTES));

const isSupported = (format: number, bits: number): boolean =>
  (format === PCM_FORMAT && bits === PCM_BITS) || (format === FLOAT_FORMAT && bits === FLOAT_BITS);

export const decodeWav = (bytes: Uint8Array): Wav | undefined => {
  if (bytes.byteLength < HEADER_BYTES || tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, CHUNK_HEADER_BYTES) !== 'WAVE') {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: Omit<Wav, 'samples'> | undefined;
  for (let offset = RIFF_HEADER_BYTES; offset + CHUNK_HEADER_BYTES <= bytes.byteLength; ) {
    const tag = tagAt(bytes, offset);
    const start = offset + CHUNK_HEADER_BYTES;
    const size = Math.min(view.getUint32(offset + TAG_BYTES, true), bytes.byteLength - start);
    if (tag === 'fmt ' && size >= FMT_CHUNK_BYTES) {
      fmt = {
        format: view.getUint16(offset + FMT_FORMAT_OFFSET, true),
        channels: view.getUint16(offset + FMT_CHANNELS_OFFSET, true),
        sampleRate: view.getUint32(offset + FMT_RATE_OFFSET, true),
        bits: view.getUint16(offset + FMT_BITS_OFFSET, true),
      };
    } else if (tag === 'data') {
      if (!fmt || fmt.channels < 1 || !isSupported(fmt.format, fmt.bits)) return undefined;
      const width = fmt.bits / BITS_PER_BYTE;
      const samples = new Float32Array(Math.floor(size / width));
      for (let index = 0; index < samples.length; index += 1) {
        const at = start + index * width;
        samples[index] = fmt.format === FLOAT_FORMAT ? view.getFloat32(at, true) : view.getInt16(at, true) / PCM_SCALE;
      }
      return { ...fmt, samples };
    }
    offset = start + size + (size % 2);
  }
  return undefined;
};

export const encodeWav = ({ format, bits, channels, sampleRate, samples }: Wav): Uint8Array => {
  const width = bits / BITS_PER_BYTE;
  const dataBytes = samples.length * width;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(ENCODER.encode('RIFF'), 0);
  view.setUint32(RIFF_SIZE_OFFSET, bytes.byteLength - CHUNK_HEADER_BYTES, true);
  bytes.set(ENCODER.encode('WAVEfmt '), CHUNK_HEADER_BYTES);
  view.setUint32(16, FMT_CHUNK_BYTES, true);
  view.setUint16(FMT_FORMAT_OFFSET + RIFF_HEADER_BYTES, format, true);
  view.setUint16(FMT_CHANNELS_OFFSET + RIFF_HEADER_BYTES, channels, true);
  view.setUint32(FMT_RATE_OFFSET + RIFF_HEADER_BYTES, sampleRate, true);
  view.setUint32(28, sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true);
  view.setUint16(FMT_BITS_OFFSET + RIFF_HEADER_BYTES, bits, true);
  bytes.set(ENCODER.encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  for (const [index, sample] of samples.entries()) {
    const at = HEADER_BYTES + index * width;
    if (format === FLOAT_FORMAT) view.setFloat32(at, sample, true);
    else view.setInt16(at, clamp(Math.round(sample * PCM_SCALE), -PCM_SCALE, PCM_MAX), true);
  }
  return bytes;
};

const rmsOf = (samples: Float32Array): number =>
  Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);

const peakOf = (samples: Float32Array): number => samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);

export const normaliseLoudness = (bytes: Uint8Array): Uint8Array => {
  const wav = decodeWav(bytes);
  if (!wav || wav.samples.length === 0) return bytes;
  const rms = rmsOf(wav.samples);
  if (rms < SILENCE_RMS) return bytes;
  const gain = Math.min(TARGET_RMS / rms, PEAK_LIMIT / peakOf(wav.samples), MAX_GAIN);
  return encodeWav({ ...wav, samples: wav.samples.map((sample) => sample * gain) });
};

const withSilence = (wav: Wav, pauseMs: number): Wav => {
  const silent = Math.round((wav.sampleRate * pauseMs) / MS_PER_SECOND) * wav.channels;
  const samples = new Float32Array(wav.samples.length + silent);
  samples.set(wav.samples);
  return { ...wav, samples };
};

export const shapeAudio = (bytes: Uint8Array, pauseMs: number): Uint8Array => {
  const levelled = decodeWav(normaliseLoudness(bytes));
  return levelled ? encodeWav(pauseMs > 0 ? withSilence(levelled, pauseMs) : levelled) : bytes;
};

export const pitchRatio = (semitones: number): number =>
  Number.isFinite(semitones)
    ? 2 ** (clamp(semitones, -SEMITONES_PER_OCTAVE, SEMITONES_PER_OCTAVE) / SEMITONES_PER_OCTAVE)
    : NEUTRAL;

const resampled = ({ samples, channels }: Wav, ratio: number): Float32Array => {
  const frames = Math.floor(samples.length / channels);
  const shifted = new Float32Array(Math.floor(frames / ratio) * channels);
  for (let frame = 0; frame * channels < shifted.length; frame += 1) {
    const position = frame * ratio;
    const before = Math.floor(position);
    const after = Math.min(before + 1, frames - 1);
    for (let channel = 0; channel < channels; channel += 1) {
      const from = samples[before * channels + channel] ?? 0;
      const to = samples[after * channels + channel] ?? 0;
      shifted[frame * channels + channel] = from + (to - from) * (position - before);
    }
  }
  return shifted;
};

export const shiftPitch = (bytes: Uint8Array, semitones: number): Uint8Array => {
  const ratio = pitchRatio(semitones);
  const wav = ratio === NEUTRAL ? undefined : decodeWav(bytes);
  return wav ? encodeWav({ ...wav, samples: resampled(wav, ratio) }) : bytes;
};
