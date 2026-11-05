import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { PASSAGES, type Passage } from './passages.ts';
import { type BenchOutput, type PassageResult, RESULT_TAG } from './report.ts';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEVICE = 'cpu';
const WARMUP_TEXT = 'Hello.';
const VOICES: Record<Passage['language'], string> = { en: 'af_heart', 'pt-BR': 'pf_dora' };
const VERSIONED_PACKAGES = ['kokoro-js', '@huggingface/transformers', 'onnxruntime-node'];

type Audio = { audio: Float32Array; sampling_rate: number; save: (path: string) => Promise<void> };
type Splitter = { push: (text: string) => void; close: () => void };
type Tts = {
  model: { dispose: () => Promise<void> };
  generate: (text: string, options: { voice: string }) => Promise<Audio>;
  stream: (input: Splitter, options: { voice: string }) => AsyncIterable<{ audio: Audio }>;
};
type KokoroModule = {
  KokoroTTS: { from_pretrained: (id: string, options: { dtype: string; device: string }) => Promise<Tts> };
  TextSplitterStream: new () => Splitter;
};

const { values } = parseArgs({
  options: { dir: { type: 'string' }, dtype: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' } },
});
const { dir, dtype, out, name } = values;
if (!dir || !dtype || !out || !name)
  throw new Error('usage: --dir <install dir> --dtype <q8|fp32> --out <dir> --name <candidate>');

const load = createRequire(join(dir, 'package.json'));
const transformers = load('@huggingface/transformers') as { env: { cacheDir: string } };
transformers.env.cacheDir = join(dir, 'models', name);
const { KokoroTTS, TextSplitterStream } = load('kokoro-js') as KokoroModule;
const packageVersion = (pkg: string): string =>
  (JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8')) as { version: string }).version;

const synthesize = async (tts: Tts, passage: Passage): Promise<PassageResult> => {
  const splitter = new TextSplitterStream();
  splitter.push(passage.text);
  splitter.close();
  const start = performance.now();
  let firstAudioMs: number | undefined;
  let audioSeconds = 0;
  const chunks: Audio[] = [];
  for await (const { audio } of tts.stream(splitter, { voice: VOICES[passage.language] })) {
    firstAudioMs ??= performance.now() - start;
    audioSeconds += audio.audio.length / audio.sampling_rate;
    chunks.push(audio);
  }
  const totalMs = performance.now() - start;
  await Promise.all(chunks.map((chunk, index) => chunk.save(join(out, `${passage.id}-${index}.wav`))));
  return { passageId: passage.id, ok: true, firstAudioMs: firstAudioMs ?? totalMs, totalMs, audioSeconds };
};

mkdirSync(out, { recursive: true });
let start = performance.now();
let tts: Tts | undefined = await KokoroTTS.from_pretrained(MODEL_ID, { dtype, device: DEVICE });
const loadMs = performance.now() - start;
start = performance.now();
await tts.generate(WARMUP_TEXT, { voice: VOICES.en });
const warmupMs = performance.now() - start;
const results: PassageResult[] = [];
for (const passage of PASSAGES) {
  results.push(
    await synthesize(tts, passage).catch((error: Error) => ({
      passageId: passage.id,
      ok: false as const,
      error: error.message,
    })),
  );
}
start = performance.now();
await tts.model.dispose();
tts = undefined;
globalThis.gc?.();
const output: BenchOutput = {
  candidate: name,
  versions: Object.fromEntries(VERSIONED_PACKAGES.map((pkg) => [pkg, packageVersion(pkg)])),
  device: DEVICE,
  loadMs,
  warmupMs,
  unloadMs: performance.now() - start,
  results,
};
console.log(RESULT_TAG + JSON.stringify(output));
