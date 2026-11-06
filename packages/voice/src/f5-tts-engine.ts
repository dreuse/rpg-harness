import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clamp, finiteOr } from './delivery-shaping.ts';
import {
  F5_VOICES,
  FLEURS_ARCHIVE_READ_LIMIT_BYTES,
  FLEURS_PT_BR_AUDIO_DIR,
  FLEURS_REPO,
  FLEURS_REVISION,
} from './f5-voices.ts';
import type { ModelFile } from './kokoro-model.ts';
import {
  createKokoroProvider,
  type KokoroCapabilities,
  type KokoroEngine,
  type KokoroProvider,
  type KokoroProviderOptions,
} from './kokoro-provider.ts';
import { createServiceEngine, type ServiceSpawn } from './local-service-engine.ts';
import { MAX_RATE, MIN_RATE } from './prosody.ts';

export const F5_PROVIDER_ID = 'f5-tts';
export const F5_DIR_ENV = 'RPG_F5_DIR';
export const F5_TOKEN_ENV = 'RPG_F5_TOKEN';
export const F5_MODEL_DIR_ENV = 'RPG_F5_MODEL_DIR';
export const F5_MANIFEST_ENV = 'RPG_F5_MANIFEST';
export const F5_SERVICE_SOURCE = join(import.meta.dirname, 'f5-tts-service.py');
export const F5_MIN_SPEED = MIN_RATE;
export const F5_MAX_SPEED = MAX_RATE;
export const F5_LICENCE = 'CC-BY-NC-4.0';
export const VOCODER_LICENCE = 'MIT';
export const F5_NFE_STEP = 16;
export const F5_MEASURED_FIRST_AUDIO_MS = Object.freeze({ gpu: 1111, cpu: 6408 });
export const F5_MEASURED_ON = 'Apple M3 Max';

const MS_PER_SECOND = 1000;
const NEUTRAL_SPEED = 1;
const SERVICE_FILE = 'f5-tts-service.py';
const MANIFEST_FILE = 'f5-manifest.json';
const WINDOWS = 'win32';

export interface F5Download {
  readonly repo: string;
  readonly revision: string;
  readonly file: string;
  readonly dir: string;
}

const ACOUSTIC_DIR = 'acoustic';
const BASE_DIR = 'base';
const VOCODER_DIR = 'vocoder';
const ACOUSTIC_FILE = 'pt-br/model_last.safetensors';
const VOCAB_FILE = 'F5TTS_Base/vocab.txt';

export const F5_ACOUSTIC_MODEL = Object.freeze({
  repo: 'firstpixel/F5-TTS-pt-br',
  revision: '5ebc6913f2d92e4c0cb5396a9867aa1c0c1c4281',
});
export const F5_BASE_MODEL = Object.freeze({
  repo: 'SWivid/F5-TTS',
  revision: '84e5a410d9cead4de2f847e7c9369a6440bdfaca',
});
export const F5_VOCODER_MODEL = Object.freeze({
  repo: 'charactr/vocos-mel-24khz',
  revision: '0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21',
});

export const F5_DOWNLOADS: readonly F5Download[] = Object.freeze([
  { ...F5_ACOUSTIC_MODEL, file: ACOUSTIC_FILE, dir: ACOUSTIC_DIR },
  { ...F5_BASE_MODEL, file: VOCAB_FILE, dir: BASE_DIR },
  { ...F5_VOCODER_MODEL, file: 'config.yaml', dir: VOCODER_DIR },
  { ...F5_VOCODER_MODEL, file: 'pytorch_model.bin', dir: VOCODER_DIR },
]);

const modelFile = (dir: string, file: string, sha256: string, bytes: number): ModelFile => ({
  path: `${dir}/${file}`,
  sha256,
  bytes,
});

export const F5_MODEL_FILES: readonly ModelFile[] = Object.freeze([
  modelFile(
    ACOUSTIC_DIR,
    ACOUSTIC_FILE,
    'c25e2678bdd4304071e3d0e39a283a7d23ffbc23678080c5b0b741dda2e07f0f',
    1_348_431_976,
  ),
  modelFile(BASE_DIR, VOCAB_FILE, '2a05f992e00af9b0bd3800a8d23e78d520dbd705284ed2eedb5f4bd29398fa3c', 13_800),
  modelFile(VOCODER_DIR, 'config.yaml', 'da9033922f969a47f0c160010226919e59f27761fd5066f3828d46de6650b0fc', 461),
  modelFile(
    VOCODER_DIR,
    'pytorch_model.bin',
    '97ec976ad1fd67a33ab2682d29c0ac7df85234fae875aefcc5fb215681a91b2a',
    54_365_991,
  ),
  ...F5_VOICES.map((voice) => voice.clip),
]);

const seconds = (ms: number): number => Math.round(ms / MS_PER_SECOND);

export const F5_WAIT_NOTE = `Slower, more expressive voice. Measured on an ${F5_MEASURED_ON}: about ${seconds(F5_MEASURED_FIRST_AUDIO_MS.gpu)} second before the first sentence on the GPU, about ${seconds(F5_MEASURED_FIRST_AUDIO_MS.cpu)} seconds on the CPU alone. Slower computers wait longer.`;

export const F5_ATTRIBUTIONS: readonly string[] = Object.freeze([
  `F5-TTS acoustic model by SWivid (${F5_LICENCE})`,
  `Brazilian Portuguese fine-tune ${F5_ACOUSTIC_MODEL.repo} by firstpixel (${F5_LICENCE})`,
  `Vocos vocoder ${F5_VOCODER_MODEL.repo} by charactr (${VOCODER_LICENCE})`,
  ...F5_VOICES.map((voice) => `${voice.id}: ${voice.attribution} (${voice.licence}), ${voice.source}`),
]);

export const F5_CAPABILITIES: KokoroCapabilities = Object.freeze({
  languages: Object.freeze(['pt-BR']),
  voices: Object.freeze(F5_VOICES.map((voice) => voice.id)),
  streaming: true,
  emotion: false,
});

export const f5Manifest = () => ({
  downloads: F5_DOWNLOADS,
  model: {
    checkpoint: `${ACOUSTIC_DIR}/${ACOUSTIC_FILE}`,
    vocab: `${BASE_DIR}/${VOCAB_FILE}`,
    vocoder: VOCODER_DIR,
    nfeStep: F5_NFE_STEP,
  },
  archives: Object.entries(FLEURS_ARCHIVE_READ_LIMIT_BYTES).map(([archive, maxBytes]) => ({
    url: `https://huggingface.co/datasets/${FLEURS_REPO}/resolve/${FLEURS_REVISION}/${FLEURS_PT_BR_AUDIO_DIR}/${archive}.tar.gz`,
    maxBytes,
    members: F5_VOICES.filter((voice) => voice.archive === archive).map((voice) => ({
      member: voice.member,
      target: voice.clip.path,
    })),
  })),
  voices: F5_VOICES.map(({ id, refText, clip }) => ({ id, refText, clip: clip.path })),
});

export const f5Speed = (speed: number): number => clamp(finiteOr(speed, NEUTRAL_SPEED), F5_MIN_SPEED, F5_MAX_SPEED);

export const f5Paths = (dir: string, platform: string = process.platform) => ({
  python: platform === WINDOWS ? join(dir, 'venv', 'Scripts', 'python.exe') : join(dir, 'venv', 'bin', 'python'),
  service: join(dir, SERVICE_FILE),
  manifest: join(dir, MANIFEST_FILE),
  hfHome: join(dir, 'hf'),
  modelDir: join(dir, 'model'),
});

const hasExactSize = (path: string, bytes: number): boolean => {
  try {
    return statSync(path).size === bytes;
  } catch {
    return false;
  }
};

export const f5Installed = (dir: string, platform?: string, files: readonly ModelFile[] = F5_MODEL_FILES): boolean => {
  const { python, modelDir } = f5Paths(dir, platform);
  return existsSync(python) && files.every((file) => hasExactSize(join(modelDir, file.path), file.bytes));
};

export interface F5EngineOptions {
  readonly dir: string;
  readonly spawn?: ServiceSpawn;
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly startTimeoutMs?: number;
  readonly files?: readonly ModelFile[];
}

export const createF5Engine = ({
  dir,
  platform,
  files = F5_MODEL_FILES,
  ...options
}: F5EngineOptions): KokoroEngine => {
  const paths = f5Paths(dir, platform);
  return createServiceEngine({
    ...options,
    name: F5_PROVIDER_ID,
    dir,
    python: paths.python,
    service: paths.service,
    serviceSource: F5_SERVICE_SOURCE,
    hfHome: paths.hfHome,
    tokenEnv: F5_TOKEN_ENV,
    env: { [F5_MODEL_DIR_ENV]: paths.modelDir, [F5_MANIFEST_ENV]: paths.manifest },
    ready: () => f5Installed(dir, platform, files),
    body: ({ text, voiceId, speed }) => ({ text, voice: voiceId, speed: f5Speed(speed) }),
  });
};

export const createF5Provider = (
  options: F5EngineOptions & Pick<KokoroProviderOptions, 'idleTimeoutMs' | 'shaping'>,
): KokoroProvider =>
  createKokoroProvider({
    engine: createF5Engine(options),
    id: F5_PROVIDER_ID,
    capabilities: F5_CAPABILITIES,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.shaping === undefined ? {} : { shaping: options.shaping }),
  });
