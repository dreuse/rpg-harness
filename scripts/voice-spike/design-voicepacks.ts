import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeWav, encodeWav } from '../../packages/voice/src/delivery-shaping.ts';
import { DESIGNED_MANIFEST } from '../../packages/voice/src/designed-manifest.ts';
import { DESIGNED_MANIFEST_FILE, DESIGNED_VOICEPACK_DIR } from '../../packages/voice/src/designed-voicepack-path.ts';
import type { DesignedInput, DesignedManifest, DesignedVoice } from '../../packages/voice/src/designed-voices.ts';
import { F5_VOICES, FLEURS_PT_BR_AUDIO_DIR, FLEURS_REPO, FLEURS_REVISION } from '../../packages/voice/src/f5-voices.ts';
import { KOKORO_WEIGHTS_PATH, kokoroModelRoot } from '../../packages/voice/src/kokoro-model.ts';
import {
  defaultPorts,
  KOKORO_SAMPLE_RATE,
  KOKORO_STYLE_DIMENSION,
  styleFor,
  tokenize,
} from '../../packages/voice/src/kokoro-onnx-engine.ts';
import { KOKORO_VOICE_LICENCE } from '../../packages/voice/src/pt-br-blends.ts';
import { type CatalogAge, type CatalogGender, VOICE_CATALOG } from '../../packages/voice/src/voice-catalog.ts';
import { cosineSimilarity, createSpeakerEmbedder } from './speaker-embedding.ts';
import { searchVoicepack } from './voicepack-search.ts';

interface Target {
  readonly id: string;
  readonly gender: CatalogGender;
  readonly ages: readonly CatalogAge[];
  readonly clips: readonly { readonly archive: string; readonly name: string; readonly path: string }[];
  readonly seed: number;
}

const SAMPLES_ROOT = join(homedir(), 'rpg-voice-samples');
const DEFAULT_MODEL_DIR = join(SAMPLES_ROOT, 'blends', 'onnx-model');
const DEFAULT_SPEAKER_MODEL = join(SAMPLES_ROOT, 'speaker-model', 'voxceleb_resnet34_LM.onnx');
const SAMPLES_DIR = join(SAMPLES_ROOT, 'kokoro-designed');
const F5_REFERENCE_DIR = join(SAMPLES_ROOT, 'f5', 'reference-clips');
const FLEURS_DEV_DIR = join(SAMPLES_ROOT, 'fleurs-dev', 'extract', 'dev');
const VOICE_DIR = 'voices';
const VOICE_EXTENSION = '.bin';
const TOKENIZER_PATH = 'tokenizer.json';
const PAD_COUNT = 2;
const SPEED = 1;
const PCM_FORMAT = 1;
const PCM_BITS = 16;
const MONO = 1;
const DEFAULT_WEIGHT_STEPS = 40;
const DEFAULT_DELTA_STEPS = 60;
const SPEAKER_MODEL_ID = 'Wespeaker/wespeaker-voxceleb-resnet34-LM (ResNet34, 256-d embedding)';
const SPEAKER_MODEL_SOURCE = 'https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM';
const SPEAKER_MODEL_LICENCE = 'CC-BY-4.0';
const TIMBRE_TAGS = 2;
const DEV = 'dev';
const MALE_ADULT_CLIPS = [
  '10114312680249610589',
  '10165966771567591302',
  '10181533133173393073',
  '10214311447059175309',
  '10221738448089878097',
  '10275176137959631739',
  '10288689224088672788',
  '1028956226170549330',
];
const MALE_YOUNG_CLIPS = [
  '10281411371095075004',
  '10469354627012887368',
  '10484400070252823650',
  '10772221179495683943',
  '1088555081702852536',
  '11193159258989471636',
  '11278916061079989542',
  '11296799965122436324',
];

const PROBE_TEXTS = Object.freeze([
  'Boa noite, viajante. A estalagem ainda tem um quarto livre, mas o jantar custa duas moedas de prata.',
  'O velho mapa mostra um caminho estreito entre as montanhas, e ninguém voltou de lá nos últimos anos.',
]);
const HELD_OUT_TEXTS = Object.freeze([
  'A tempestade chegou depressa, e o capitão mandou recolher as velas antes que o vento rasgasse o mastro.',
  'Diga ao ferreiro que a espada ficou pronta, mas que o preço combinado já não é suficiente.',
]);
const SAMPLE_TEXT = `${PROBE_TEXTS[0]} ${HELD_OUT_TEXTS[0]}`;

const f5Clip = (voiceId: string): Target['clips'][number] => {
  const voice = F5_VOICES.find(({ id }) => id === voiceId);
  if (!voice) throw new Error(`unknown reference voice: ${voiceId}`);
  return {
    archive: voice.archive,
    name: voice.member.split('/')[1] ?? '',
    path: join(F5_REFERENCE_DIR, `${voiceId}.wav`),
  };
};

const devClips = (names: readonly string[]): Target['clips'] =>
  names.map((name) => ({ archive: DEV, name: `${name}.wav`, path: join(FLEURS_DEV_DIR, `${name}.wav`) }));

const TARGETS: readonly Target[] = Object.freeze([
  { id: 'pf_luiza', gender: 'female', ages: ['young'], clips: [f5Clip('f5-pt-f1')], seed: 1 },
  { id: 'pf_beatriz', gender: 'female', ages: ['adult'], clips: [f5Clip('f5-pt-f2')], seed: 2 },
  { id: 'pm_davi', gender: 'male', ages: ['young'], clips: devClips(MALE_YOUNG_CLIPS), seed: 3 },
  { id: 'pm_henrique', gender: 'male', ages: ['adult'], clips: devClips(MALE_ADULT_CLIPS), seed: 4 },
]);

const INPUTS: readonly DesignedInput[] = Object.freeze([
  {
    role: 'reference clips (human read speech)',
    source: `https://huggingface.co/datasets/${FLEURS_REPO}/tree/${FLEURS_REVISION}/${FLEURS_PT_BR_AUDIO_DIR}`,
    licence: F5_VOICES[0]?.licence ?? '',
    attribution: F5_VOICES[0]?.attribution ?? '',
  },
  { role: 'speaker similarity model', source: SPEAKER_MODEL_SOURCE, licence: SPEAKER_MODEL_LICENCE },
  {
    role: 'Kokoro-82M ONNX model and base voice style vectors',
    source: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
    licence: KOKORO_VOICE_LICENCE,
  },
]);

const { values: args } = parseArgs({
  options: {
    'model-dir': { type: 'string', default: DEFAULT_MODEL_DIR },
    'speaker-model': { type: 'string', default: DEFAULT_SPEAKER_MODEL },
    only: { type: 'string' },
    'weight-steps': { type: 'string', default: String(DEFAULT_WEIGHT_STEPS) },
    'delta-steps': { type: 'string', default: String(DEFAULT_DELTA_STEPS) },
  },
});

const floatsOf = (bytes: Uint8Array): Float32Array =>
  new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

const wavSamples = (path: string): { samples: Float32Array; sampleRate: number } => {
  const wav = decodeWav(new Uint8Array(readFileSync(path)));
  if (!wav) throw new Error(`unreadable wav: ${path}`);
  return wav;
};

const unit = (vector: Float32Array): Float32Array => {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
};

const meanOf = (vectors: readonly Float32Array[]): Float32Array =>
  Float32Array.from(
    { length: vectors[0]?.length ?? 0 },
    (_, i) => vectors.reduce((sum, vector) => sum + (vector[i] as number), 0) / vectors.length,
  );

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

const root = kokoroModelRoot(args['model-dir'] as string);
const ports = defaultPorts();
const runtime = await ports.loadRuntime();
const vocab = (
  JSON.parse(readFileSync(join(root, TOKENIZER_PATH), 'utf8')) as { model: { vocab: Record<string, number> } }
).model.vocab;
const session = await runtime.InferenceSession.create(join(root, KOKORO_WEIGHTS_PATH), { executionProviders: ['cpu'] });
const embed = await createSpeakerEmbedder(args['speaker-model'] as string, runtime);

const tokenCache = new Map<string, number[]>();
const idsOf = async (text: string): Promise<number[]> => {
  const cached = tokenCache.get(text) ?? tokenize(await ports.phonemize(text), vocab);
  tokenCache.set(text, cached);
  return cached;
};

const synthesize = async (text: string, pack: Float32Array): Promise<Float32Array> => {
  const ids = await idsOf(text);
  const style = styleFor(new Uint8Array(pack.buffer, pack.byteOffset, pack.byteLength), ids.length - PAD_COUNT);
  const output = await session.run({
    input_ids: new runtime.Tensor('int64', BigInt64Array.from(ids, BigInt), [MONO, ids.length]),
    style: new runtime.Tensor('float32', style, [MONO, KOKORO_STYLE_DIMENSION]),
    speed: new runtime.Tensor('float32', new Float32Array([SPEED]), [MONO]),
  });
  const waveform = output.waveform;
  if (!waveform) throw new Error('kokoro model returned no waveform');
  return Float32Array.from(waveform.data);
};

const scoreAgainst =
  (reference: Float32Array, texts: readonly string[]) =>
  async (pack: Float32Array): Promise<number> => {
    const scores: number[] = [];
    for (const text of texts) {
      scores.push(cosineSimilarity(await embed(await synthesize(text, pack), KOKORO_SAMPLE_RATE), reference));
    }
    return mean(scores);
  };

const referenceOf = async (target: Target): Promise<Float32Array> => {
  const embeddings: Float32Array[] = [];
  for (const { path } of target.clips) {
    const { samples, sampleRate } = wavSamples(path);
    embeddings.push(unit(await embed(samples, sampleRate)));
  }
  return unit(meanOf(embeddings));
};

const basesFor = (gender: CatalogGender): { id: string; pack: Float32Array }[] =>
  readdirSync(join(root, VOICE_DIR))
    .filter((file) => file.endsWith(VOICE_EXTENSION))
    .map((file) => file.slice(0, -VOICE_EXTENSION.length))
    .filter((id) => VOICE_CATALOG[id]?.gender === gender)
    .sort()
    .map((id) => ({
      id,
      pack: floatsOf(new Uint8Array(readFileSync(join(root, VOICE_DIR, `${id}${VOICE_EXTENSION}`)))),
    }));

const selected = TARGETS.filter(({ id }) => args.only === undefined || id === args.only);
if (selected.length === 0) throw new Error(`unknown target: ${args.only}`);

const references = new Map<string, Float32Array>();
for (const target of TARGETS) references.set(target.id, await referenceOf(target));

mkdirSync(SAMPLES_DIR, { recursive: true });
mkdirSync(DESIGNED_VOICEPACK_DIR, { recursive: true });

const designed: DesignedVoice[] = [];
for (const target of selected) {
  const reference = references.get(target.id) as Float32Array;
  const bases = basesFor(target.gender);
  const dimension = KOKORO_STYLE_DIMENSION;
  const baselineScores = await Promise.all(bases.map(async ({ pack }) => scoreAgainst(reference, PROBE_TEXTS)(pack)));
  const baselineIndex = baselineScores.indexOf(Math.max(...baselineScores));
  const result = await searchVoicepack({
    bases: bases.map(({ pack }) => pack),
    dimension,
    seed: target.seed,
    weightSteps: Number(args['weight-steps']),
    deltaSteps: Number(args['delta-steps']),
    score: scoreAgainst(reference, PROBE_TEXTS),
  });
  const heldOut = await scoreAgainst(reference, HELD_OUT_TEXTS)(result.pack);
  const otherTargetsMax = Math.max(
    ...(await Promise.all(
      TARGETS.filter(({ id }) => id !== target.id).map(({ id }) =>
        scoreAgainst(references.get(id) as Float32Array, HELD_OUT_TEXTS)(result.pack),
      ),
    )),
  );
  const bytes = new Uint8Array(result.pack.buffer, result.pack.byteOffset, result.pack.byteLength);
  const file = `${target.id}${VOICE_EXTENSION}`;
  writeFileSync(join(DESIGNED_VOICEPACK_DIR, file), bytes);
  writeFileSync(
    join(SAMPLES_DIR, `${target.id}.wav`),
    encodeWav({
      format: PCM_FORMAT,
      bits: PCM_BITS,
      channels: MONO,
      sampleRate: KOKORO_SAMPLE_RATE,
      samples: await synthesize(SAMPLE_TEXT, result.pack),
    }),
  );
  const weights = Object.fromEntries(
    bases.flatMap(({ id }, index) =>
      (result.weights[index] ?? 0) > 0 ? [[id, +(result.weights[index] as number).toFixed(4)]] : [],
    ),
  );
  const dominant = Object.entries(weights).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const voice: DesignedVoice = {
    id: target.id,
    gender: target.gender,
    ages: target.ages,
    timbre: (VOICE_CATALOG[dominant]?.timbre ?? []).slice(0, TIMBRE_TAGS),
    licence: KOKORO_VOICE_LICENCE,
    file,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    references: target.clips.map(({ archive, name }) => ({
      file: `${archive}/${name}`,
      url: `https://huggingface.co/datasets/${FLEURS_REPO}/blob/${FLEURS_REVISION}/${FLEURS_PT_BR_AUDIO_DIR}/${archive}.tar.gz#${archive}/${name}`,
    })),
    weights,
    seed: target.seed,
    similarity: {
      score: +heldOut.toFixed(4),
      searchScore: +result.score.toFixed(4),
      baselineVoice: bases[baselineIndex]?.id ?? '',
      baselineScore: +(baselineScores[baselineIndex] as number).toFixed(4),
      otherTargetsMax: +otherTargetsMax.toFixed(4),
    },
  };
  designed.push(voice);
  console.log(JSON.stringify({ id: voice.id, ...voice.similarity, weights }));
}

const previous = DESIGNED_MANIFEST.voices;
const kept = previous.filter(({ id }) => !designed.some((voice) => voice.id === id));
const order = TARGETS.map(({ id }) => id);
const manifest: DesignedManifest = {
  similarityModel: SPEAKER_MODEL_ID,
  inputs: INPUTS,
  voices: [...kept, ...designed].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
};
writeFileSync(
  DESIGNED_MANIFEST_FILE,
  `import type { DesignedManifest } from './designed-voices.ts';\n\nexport const DESIGNED_MANIFEST: DesignedManifest = ${JSON.stringify(manifest, null, 2)};\n`,
);
