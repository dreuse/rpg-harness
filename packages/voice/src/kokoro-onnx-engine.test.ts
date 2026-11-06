import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { decodeWav } from './delivery-shaping.ts';
import { KOKORO_PT_BR_MODEL_FILES, kokoroModelRoot } from './kokoro-model.ts';
import {
  createKokoroOnnxEngine,
  defaultPorts,
  espeakIpa,
  KOKORO_MAX_TOKENS,
  KOKORO_SAMPLE_RATE,
  KOKORO_STYLE_DIMENSION,
  type OnnxPorts,
  phonemizeWithPunctuation,
  selectEspeakVoice,
  styleFor,
  tokenize,
} from './kokoro-onnx-engine.ts';
import { PT_BR_BLEND_PARTNERS } from './pt-br-blends.ts';

const VOCAB = { a: 1, b: 2, ' ': 3 };
const VOICE = 'pf_dora';
const SIGNAL = new AbortController().signal;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const voiceBytes = (): Uint8Array => {
  const rows = new Float32Array(KOKORO_MAX_TOKENS * KOKORO_STYLE_DIMENSION);
  for (let row = 0; row < KOKORO_MAX_TOKENS; row++) {
    rows.fill(row, row * KOKORO_STYLE_DIMENSION, (row + 1) * KOKORO_STYLE_DIMENSION);
  }
  return new Uint8Array(rows.buffer);
};

const installFake = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'kokoro-onnx-'));
  dirs.push(dir);
  const root = kokoroModelRoot(dir);
  for (const file of KOKORO_PT_BR_MODEL_FILES) {
    await mkdir(join(root, file.path, '..'), { recursive: true });
    const content = file.path.endsWith('.bin')
      ? voiceBytes()
      : file.path === 'tokenizer.json'
        ? JSON.stringify({ model: { vocab: VOCAB } })
        : 'x';
    await writeFile(join(root, file.path), content);
  }
  return dir;
};

const fakePorts = () => {
  const calls: Array<Record<string, { dims: readonly number[]; data: ArrayLike<number | bigint> }>> = [];
  let released = false;
  const ports: OnnxPorts = {
    phonemize: async (text) => text.toLowerCase(),
    loadRuntime: async () => ({
      Tensor: class {
        readonly type: string;
        readonly data: ArrayLike<number | bigint>;
        readonly dims: readonly number[];
        constructor(type: string, data: ArrayLike<number | bigint>, dims: readonly number[]) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
      InferenceSession: {
        create: async () => ({
          run: async (feeds: Record<string, { dims: readonly number[]; data: ArrayLike<number | bigint> }>) => {
            calls.push(feeds);
            return { waveform: { data: new Float32Array([0, 0.5, -0.5, 0.25]) } };
          },
          release: async () => {
            released = true;
          },
        }),
      },
    }),
  };
  return { ports, calls, released: () => released };
};

test('tokenize wraps known phonemes with pad ids and drops unknown ones', () => {
  assert.deepEqual(tokenize('a b?z', VOCAB), [0, 1, 3, 2, 0]);
});

test('tokenize caps the sequence at the model limit', () => {
  const ids = tokenize('a'.repeat(KOKORO_MAX_TOKENS + 50), VOCAB);
  assert.equal(ids.length, KOKORO_MAX_TOKENS);
  assert.equal(ids[0], 0);
  assert.equal(ids.at(-1), 0);
});

test('styleFor selects the voice row for the token count', () => {
  const style = styleFor(voiceBytes(), 7);
  assert.equal(style.length, KOKORO_STYLE_DIMENSION);
  assert.ok(style.every((value) => value === 7));
});

test('selectEspeakVoice and espeakIpa throw when espeak reports a failure', () => {
  const failing = { set_voice: () => 1, synthesize_ipa: () => ({ code: 1, ipa: '' }) };
  const working = { set_voice: () => 0, synthesize_ipa: () => ({ code: 0, ipa: 'oi' }) };
  assert.throws(() => selectEspeakVoice(failing), /espeak voice/);
  assert.throws(() => espeakIpa(failing, 'oi'), /espeak could not phonemize/);
  assert.doesNotThrow(() => selectEspeakVoice(working));
  assert.equal(espeakIpa(working, 'oi'), 'oi');
});

test('defaultPorts retry after a failed espeak load', async () => {
  const ports = defaultPorts(() => Promise.reject(new Error('no wasm')));
  await assert.rejects(ports.phonemize('oi'), /no wasm/);
  await assert.rejects(ports.phonemize('oi'), /no wasm/);
});

test('styleFor rejects a voice file with the wrong size', () => {
  assert.throws(() => styleFor(new Uint8Array(10), 1), /voice file/);
});

test('is not ready and refuses synthesis until the files are installed and loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kokoro-onnx-'));
  dirs.push(dir);
  const engine = createKokoroOnnxEngine(dir, fakePorts().ports);
  assert.equal(engine.ready(), false);
  await assert.rejects(engine.synthesize('a', VOICE, SIGNAL, 1), /not loaded/);
});

test('synthesizes a 24 kHz mono WAV through the model with the style row and speed', async () => {
  const dir = await installFake();
  const { ports, calls } = fakePorts();
  const engine = createKokoroOnnxEngine(dir, ports);
  assert.equal(engine.ready(), true);
  await engine.load();
  const wav = decodeWav(await engine.synthesize('ab', VOICE, SIGNAL, 1.25));
  assert.equal(wav?.sampleRate, KOKORO_SAMPLE_RATE);
  assert.equal(wav?.channels, 1);
  assert.equal(wav?.samples.length, 4);
  const feeds = calls[0];
  assert.deepEqual(Array.from(feeds?.input_ids?.data ?? []), [0n, 1n, 2n, 0n]);
  assert.deepEqual(feeds?.input_ids?.dims, [1, 4]);
  assert.equal(feeds?.style?.data[0], 2);
  assert.equal(feeds?.speed?.data[0], 1.25);
});

test('rejects a voice outside the pt-BR allowlist before touching the filesystem', async () => {
  const dir = await installFake();
  const engine = createKokoroOnnxEngine(dir, fakePorts().ports);
  await engine.load();
  await assert.rejects(engine.synthesize('a', '../../etc/passwd', SIGNAL, 1), /unknown voice/);
});

test('unload releases the session and refuses further synthesis', async () => {
  const dir = await installFake();
  const fake = fakePorts();
  const engine = createKokoroOnnxEngine(dir, fake.ports);
  await engine.load();
  await engine.unload();
  assert.equal(fake.released(), true);
  await assert.rejects(engine.synthesize('a', VOICE, SIGNAL, 1), /not loaded/);
});

test('phonemizeWithPunctuation keeps punctuation, drops separators and joins line breaks', () => {
  const ipa = (clause: string): string => `${clause.toUpperCase()}_x\ny`;
  assert.equal(phonemizeWithPunctuation('ola, mundo!', ipa), 'OLAx y, MUNDOx y!');
});

const PARTNER_OFFSET = 1000;
const BLEND_WEIGHT = 0.25;

test('rpg-cm63.45 mixes the style rows of two voices by the blend weight', async () => {
  const dir = await installFake();
  const partner = PT_BR_BLEND_PARTNERS[0] ?? '';
  const rows = new Float32Array(KOKORO_MAX_TOKENS * KOKORO_STYLE_DIMENSION);
  for (let row = 0; row < KOKORO_MAX_TOKENS; row++) {
    rows.fill(PARTNER_OFFSET + row, row * KOKORO_STYLE_DIMENSION, (row + 1) * KOKORO_STYLE_DIMENSION);
  }
  await writeFile(join(kokoroModelRoot(dir), 'voices', `${partner}.bin`), new Uint8Array(rows.buffer));
  const { ports, calls } = fakePorts();
  const engine = createKokoroOnnxEngine(dir, ports);
  assert.equal(engine.blends, true);
  await engine.load();
  await engine.synthesize('ab', VOICE, SIGNAL, 1, { first: VOICE, second: partner, weight: BLEND_WEIGHT });
  const mixed = Number(calls[0]?.style?.data[0]);
  assert.ok(Math.abs(mixed - (2 + BLEND_WEIGHT * PARTNER_OFFSET)) < 1e-3, String(mixed));
});

test('rpg-cm63.45 rejects a blend partner outside the allowlist', async () => {
  const dir = await installFake();
  const engine = createKokoroOnnxEngine(dir, fakePorts().ports);
  await engine.load();
  await assert.rejects(
    engine.synthesize('a', VOICE, SIGNAL, 1, { first: VOICE, second: '../../etc/passwd', weight: BLEND_WEIGHT }),
    /unknown voice/,
  );
});
