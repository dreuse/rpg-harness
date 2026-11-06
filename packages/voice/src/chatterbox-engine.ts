import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clamp, finiteOr } from './delivery-shaping.ts';
import type { ModelFile } from './kokoro-model.ts';
import {
  createKokoroProvider,
  type KokoroCapabilities,
  type KokoroEngine,
  type KokoroProvider,
  type KokoroProviderOptions,
} from './kokoro-provider.ts';
import { createServiceEngine, type ServiceSpawn } from './local-service-engine.ts';
import { mlxAudioSupported } from './mlx-audio-engine.ts';
import type { Delivery } from './voice.ts';

export const CHATTERBOX_PROVIDER_ID = 'chatterbox';
export const CHATTERBOX_DIR_ENV = 'RPG_CHATTERBOX_DIR';
export const CHATTERBOX_TOKEN_ENV = 'RPG_CHATTERBOX_TOKEN';
export const CHATTERBOX_MODEL_DIR_ENV = 'RPG_CHATTERBOX_MODEL_DIR';
export const CHATTERBOX_MODEL_ID = 'ResembleAI/chatterbox';
export const CHATTERBOX_MODEL_REVISION = '5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18';
export const CHATTERBOX_SERVICE_SOURCE = join(import.meta.dirname, 'chatterbox-service.py');
export const CHATTERBOX_VOICE = 'chatterbox-default';
export const CHATTERBOX_MEASURED_FIRST_AUDIO_MS = 8247;
export const CHATTERBOX_MEASURED_RTF = 3.1;
export const CHATTERBOX_MEASURED_ON = 'Apple M3 Max';
const MS_PER_SECOND = 1000;
export const CHATTERBOX_WAIT_NOTE = `Slower, more expressive voice. Measured on an ${CHATTERBOX_MEASURED_ON}: about ${Math.round(CHATTERBOX_MEASURED_FIRST_AUDIO_MS / MS_PER_SECOND)} seconds before the first sentence, and about ${CHATTERBOX_MEASURED_RTF} times slower than real time. Slower computers wait longer.`;
export const MIN_EXAGGERATION = 0.25;
export const MAX_EXAGGERATION = 2;

export const CHATTERBOX_MODEL_FILES: readonly ModelFile[] = Object.freeze([
  { path: 've.pt', sha256: '4b16d836bc598509860f6fa068165a8bb5e9ac84f05582dfcf278a5a372879f1', bytes: 5_698_626 },
  {
    path: 't3_mtl23ls_v2.safetensors',
    sha256: 'b1237586127ce98e7800a68e49938eb5092846862aabcb6e17b2fda7889a6c75',
    bytes: 2_143_989_752,
  },
  {
    path: 's3gen.pt',
    sha256: '9b9ff07e60b20c136e2b1b3d7563a24604e8d2c4c267888d1ee929dd0151d2a3',
    bytes: 1_057_165_844,
  },
  {
    path: 'grapheme_mtl_merged_expanded_v1.json',
    sha256: '69632f47220a788a52ce2661d096453c5655e9bf25289d89a8d832c46ee07dbf',
    bytes: 69_989,
  },
  { path: 'conds.pt', sha256: '6552d70568833628ba019c6b03459e77fe71ca197d5c560cef9411bee9d87f4e', bytes: 107_374 },
]);

export const CHATTERBOX_CAPABILITIES: KokoroCapabilities = Object.freeze({
  languages: Object.freeze(['pt-BR']),
  voices: Object.freeze([CHATTERBOX_VOICE]),
  streaming: true,
  emotion: true,
});

export interface ChatterboxExpression {
  readonly exaggeration: number;
  readonly cfg_weight: number;
}

const NEUTRAL_EXPRESSION: ChatterboxExpression = Object.freeze({ exaggeration: 0.5, cfg_weight: 0.5 });

export const CHATTERBOX_DELIVERY_EXPRESSION: Readonly<Record<string, ChatterboxExpression>> = Object.freeze({
  neutral: NEUTRAL_EXPRESSION,
  calm: { exaggeration: 0.35, cfg_weight: 0.4 },
  sad: { exaggeration: 0.35, cfg_weight: 0.35 },
  tender: { exaggeration: 0.4, cfg_weight: 0.4 },
  whisper: { exaggeration: MIN_EXAGGERATION, cfg_weight: 0.4 },
  happy: { exaggeration: 0.65, cfg_weight: 0.45 },
  tense: { exaggeration: 0.7, cfg_weight: 0.4 },
  fearful: { exaggeration: 0.8, cfg_weight: 0.35 },
  angry: { exaggeration: 0.9, cfg_weight: 0.3 },
  excited: { exaggeration: 0.9, cfg_weight: 0.3 },
});

const FULL_INTENSITY = 1;
const NO_INTENSITY = 0;
const MIN_CFG_WEIGHT = 0;
const MAX_CFG_WEIGHT = 1;

const towards = (neutral: number, target: number, intensity: number): number =>
  neutral + (target - neutral) * intensity;

export const chatterboxExpression = (delivery: Delivery | undefined): ChatterboxExpression => {
  const emotion = delivery?.emotion;
  const target =
    typeof emotion === 'string' && Object.hasOwn(CHATTERBOX_DELIVERY_EXPRESSION, emotion)
      ? (CHATTERBOX_DELIVERY_EXPRESSION[emotion] ?? NEUTRAL_EXPRESSION)
      : NEUTRAL_EXPRESSION;
  const intensity = clamp(finiteOr(delivery?.intensity, FULL_INTENSITY), NO_INTENSITY, FULL_INTENSITY);
  return {
    exaggeration: clamp(
      towards(NEUTRAL_EXPRESSION.exaggeration, target.exaggeration, intensity),
      MIN_EXAGGERATION,
      MAX_EXAGGERATION,
    ),
    cfg_weight: clamp(
      towards(NEUTRAL_EXPRESSION.cfg_weight, target.cfg_weight, intensity),
      MIN_CFG_WEIGHT,
      MAX_CFG_WEIGHT,
    ),
  };
};

const SERVICE_FILE = 'chatterbox-service.py';

export const chatterboxPaths = (dir: string) => ({
  python: join(dir, 'venv', 'bin', 'python'),
  service: join(dir, SERVICE_FILE),
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

export const chatterboxInstalled = (dir: string, files: readonly ModelFile[] = CHATTERBOX_MODEL_FILES): boolean => {
  const { python, modelDir } = chatterboxPaths(dir);
  return existsSync(python) && files.every((file) => hasExactSize(join(modelDir, file.path), file.bytes));
};

export interface ChatterboxEngineOptions {
  readonly dir: string;
  readonly spawn?: ServiceSpawn;
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly arch?: string;
  readonly startTimeoutMs?: number;
  readonly files?: readonly ModelFile[];
}

export const createChatterboxEngine = ({
  dir,
  platform,
  arch,
  files = CHATTERBOX_MODEL_FILES,
  ...options
}: ChatterboxEngineOptions): KokoroEngine => {
  const paths = chatterboxPaths(dir);
  return createServiceEngine({
    ...options,
    name: CHATTERBOX_PROVIDER_ID,
    dir,
    python: paths.python,
    service: paths.service,
    serviceSource: CHATTERBOX_SERVICE_SOURCE,
    hfHome: paths.hfHome,
    tokenEnv: CHATTERBOX_TOKEN_ENV,
    env: { [CHATTERBOX_MODEL_DIR_ENV]: paths.modelDir },
    ready: () => mlxAudioSupported(platform, arch) && chatterboxInstalled(dir, files),
    body: ({ text, voiceId, delivery }) => ({ text, voice: voiceId, ...chatterboxExpression(delivery) }),
  });
};

export const createChatterboxProvider = (
  options: ChatterboxEngineOptions & Pick<KokoroProviderOptions, 'idleTimeoutMs' | 'shaping'>,
): KokoroProvider =>
  createKokoroProvider({
    engine: createChatterboxEngine(options),
    id: CHATTERBOX_PROVIDER_ID,
    capabilities: CHATTERBOX_CAPABILITIES,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.shaping === undefined ? {} : { shaping: options.shaping }),
  });
