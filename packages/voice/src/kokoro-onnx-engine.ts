import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeWav } from './delivery-shaping.ts';
import { designedVoicepackPath } from './designed-voicepack-path.ts';
import { designedVoiceOf } from './designed-voices.ts';
import {
  KOKORO_PT_BR_MODEL_FILES,
  KOKORO_PT_BR_VOICE_FILES,
  KOKORO_WEIGHTS_PATH,
  kokoroModelRoot,
} from './kokoro-model.ts';
import type { KokoroEngine, VoiceBlend } from './kokoro-provider.ts';

export { KOKORO_ONNX_PROVIDER_ID } from './kokoro-provider.ts';

export const KOKORO_SAMPLE_RATE = 24_000;
export const KOKORO_STYLE_DIMENSION = 256;
export const KOKORO_MAX_TOKENS = 510;

const ONNX_MODULE = 'onnxruntime-node';
const ESPEAK_MODULE = '@echogarden/espeak-ng-emscripten';
const ESPEAK_VOICE = 'pt-br';
const TOKENIZER_PATH = 'tokenizer.json';
const VOICE_DIR = 'voices';
const VOICE_EXTENSION = '.bin';
const ESPEAK_OK = 0;
const PAD_ID = 0;
const PAD_COUNT = 2;
const BYTES_PER_FLOAT = 4;
const PCM_FORMAT = 1;
const PCM_BITS = 16;
const MONO = 1;
const CPU = 'cpu';
const PUNCTUATION = /([,.!?;:…—])/;
const PHONEME_SEPARATOR = /_/g;
const LINE_BREAKS = /\s*\n\s*/g;

export interface OnnxTensor {
  readonly data: ArrayLike<number | bigint>;
  readonly dims: readonly number[];
}

export interface OnnxSession {
  run(feeds: Record<string, OnnxTensor>): Promise<Record<string, { readonly data: ArrayLike<number> }>>;
  release(): Promise<void>;
}

export interface OnnxRuntime {
  readonly Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: readonly number[]) => OnnxTensor;
  readonly InferenceSession: {
    create(path: string, options: { readonly executionProviders: readonly string[] }): Promise<OnnxSession>;
  };
}

export interface OnnxPorts {
  phonemize(text: string): Promise<string>;
  loadRuntime(): Promise<OnnxRuntime>;
}

export interface EspeakWorker {
  set_voice(voice: string): number;
  synthesize_ipa(text: string): { readonly code: number; readonly ipa: string };
}

export interface EspeakModule {
  readonly default: () => Promise<{ readonly eSpeakNGWorker: new () => EspeakWorker }>;
}

export const tokenize = (phonemes: string, vocab: Readonly<Record<string, number>>): number[] => {
  const ids = [...phonemes].flatMap((char) => (Object.hasOwn(vocab, char) ? [vocab[char] as number] : []));
  return [PAD_ID, ...ids.slice(0, KOKORO_MAX_TOKENS - PAD_COUNT), PAD_ID];
};

export const styleFor = (voice: Uint8Array, tokenCount: number): Float32Array => {
  const rowBytes = KOKORO_STYLE_DIMENSION * BYTES_PER_FLOAT;
  if (voice.byteLength !== KOKORO_MAX_TOKENS * rowBytes) throw new Error('voice file has an unexpected size');
  const start = voice.byteOffset + Math.min(tokenCount, KOKORO_MAX_TOKENS - 1) * rowBytes;
  return new Float32Array(voice.buffer.slice(start, start + rowBytes));
};

export const phonemizeWithPunctuation = (text: string, ipaOf: (clause: string) => string): string =>
  text
    .split(PUNCTUATION)
    .map((part, index) => {
      const clause = part.trim();
      return index % 2 === 1 || clause === '' ? part : part.replace(clause, () => ipaOf(clause));
    })
    .join('')
    .replace(PHONEME_SEPARATOR, '')
    .replace(LINE_BREAKS, ' ');

export const selectEspeakVoice = (worker: EspeakWorker): void => {
  if (worker.set_voice(ESPEAK_VOICE) !== ESPEAK_OK) throw new Error(`espeak voice unavailable: ${ESPEAK_VOICE}`);
};

export const espeakIpa = (worker: EspeakWorker, clause: string): string => {
  const { code, ipa } = worker.synthesize_ipa(clause);
  if (code !== ESPEAK_OK) throw new Error('espeak could not phonemize the text');
  return ipa;
};

const loadEspeak = () => import(ESPEAK_MODULE) as Promise<EspeakModule>;

export const defaultPorts = (load: () => Promise<EspeakModule> = loadEspeak): OnnxPorts => {
  let worker: Promise<EspeakWorker> | undefined;
  const espeak = (): Promise<EspeakWorker> => {
    worker ??= load()
      .then(async ({ default: create }) => {
        const loaded = new (await create()).eSpeakNGWorker();
        selectEspeakVoice(loaded);
        return loaded;
      })
      .catch((error: unknown) => {
        worker = undefined;
        throw error;
      });
    return worker;
  };
  return {
    phonemize: async (text) => {
      const loaded = await espeak();
      return phonemizeWithPunctuation(text, (clause) => espeakIpa(loaded, clause));
    },
    loadRuntime: async () => (await import(ONNX_MODULE)) as OnnxRuntime,
  };
};

export const createKokoroOnnxEngine = (dir: string, ports: OnnxPorts = defaultPorts()): KokoroEngine => {
  const root = kokoroModelRoot(dir);
  const voices = new Map<string, Uint8Array>();
  let loaded: { session: OnnxSession; runtime: OnnxRuntime; vocab: Record<string, number> } | undefined;

  const voiceBytes = async (voiceId: string): Promise<Uint8Array> => {
    const path = `${VOICE_DIR}/${voiceId}${VOICE_EXTENSION}`;
    const designed = designedVoiceOf(voiceId);
    if (!designed && !KOKORO_PT_BR_VOICE_FILES.some((file) => file.path === path)) {
      throw new Error(`unknown voice: ${voiceId}`);
    }
    const cached = voices.get(voiceId);
    if (cached) return cached;
    const bytes = new Uint8Array(await readFile(designed ? designedVoicepackPath(designed) : join(root, path)));
    voices.set(voiceId, bytes);
    return bytes;
  };

  const styleOf = async (voiceId: string, tokenCount: number, blend: VoiceBlend | undefined): Promise<Float32Array> => {
    const style = styleFor(await voiceBytes(voiceId), tokenCount);
    if (blend === undefined) return style;
    const partner = styleFor(await voiceBytes(blend.second), tokenCount);
    return style.map((value, index) => (1 - blend.weight) * value + blend.weight * (partner[index] ?? value));
  };

  return {
    blends: true,
    ready: () => KOKORO_PT_BR_MODEL_FILES.every((file) => existsSync(join(root, file.path))),
    load: async () => {
      const runtime = await ports.loadRuntime();
      const tokenizer = JSON.parse(await readFile(join(root, TOKENIZER_PATH), 'utf8')) as {
        model: { vocab: Record<string, number> };
      };
      const session = await runtime.InferenceSession.create(join(root, KOKORO_WEIGHTS_PATH), {
        executionProviders: [CPU],
      });
      loaded = { session, runtime, vocab: tokenizer.model.vocab };
    },
    synthesize: async (sentence, voiceId, _signal, speed, blend) => {
      if (!loaded) throw new Error('kokoro model not loaded');
      const { session, runtime, vocab } = loaded;
      const ids = tokenize(await ports.phonemize(sentence), vocab);
      const output = await session.run({
        input_ids: new runtime.Tensor('int64', BigInt64Array.from(ids, BigInt), [MONO, ids.length]),
        style: new runtime.Tensor('float32', await styleOf(voiceId, ids.length - PAD_COUNT, blend), [
          MONO,
          KOKORO_STYLE_DIMENSION,
        ]),
        speed: new runtime.Tensor('float32', new Float32Array([speed]), [MONO]),
      });
      const waveform = output.waveform;
      if (!waveform) throw new Error('kokoro model returned no waveform');
      return encodeWav({
        format: PCM_FORMAT,
        bits: PCM_BITS,
        channels: MONO,
        sampleRate: KOKORO_SAMPLE_RATE,
        samples: Float32Array.from(waveform.data),
      });
    },
    unload: async () => {
      const previous = loaded;
      loaded = undefined;
      voices.clear();
      await previous?.session.release();
    },
  };
};
