import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createKokoroProvider,
  type KokoroEngine,
  type KokoroProvider,
  type KokoroProviderOptions,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
} from './kokoro-provider.ts';
import {
  createServiceEngine,
  inheritedEnv,
  SERVICE_START_TIMEOUT_MS,
  type ServiceSpawn,
} from './local-service-engine.ts';

export type { ServiceSpawn };
export { inheritedEnv, MLX_KOKORO_CAPABILITIES, MLX_KOKORO_PROVIDER_ID };
export const MLX_AUDIO_DIR_ENV = 'RPG_MLX_AUDIO_DIR';
export const MLX_AUDIO_TOKEN_ENV = 'RPG_MLX_AUDIO_TOKEN';
export const MLX_AUDIO_MODEL_ID = 'mlx-community/Kokoro-82M-bf16';
export const MLX_AUDIO_MODEL_REVISION = 'a71e4d38b236d968966a2002c4c895dbd12b1c3c';
export const MLX_AUDIO_START_TIMEOUT_MS = SERVICE_START_TIMEOUT_MS;
export const MLX_AUDIO_SERVICE_SOURCE = join(import.meta.dirname, 'mlx-audio-service.py');

const APPLE_PLATFORM = 'darwin';
const APPLE_SILICON = 'arm64';
const SERVICE_FILE = 'mlx-audio-service.py';
const WEIGHTS_FILE = 'kokoro-v1_0.safetensors';

export const mlxAudioSupported = (platform: string = process.platform, arch: string = process.arch): boolean =>
  platform === APPLE_PLATFORM && arch === APPLE_SILICON;

export const mlxAudioPaths = (dir: string) => {
  const hfHome = join(dir, 'hf');
  return {
    python: join(dir, 'venv', 'bin', 'python'),
    service: join(dir, SERVICE_FILE),
    hfHome,
    weights: join(
      hfHome,
      'hub',
      `models--${MLX_AUDIO_MODEL_ID.replace('/', '--')}`,
      'snapshots',
      MLX_AUDIO_MODEL_REVISION,
      WEIGHTS_FILE,
    ),
  };
};

export const mlxAudioInstalled = (dir: string): boolean => {
  const { python, weights } = mlxAudioPaths(dir);
  return existsSync(python) && existsSync(weights);
};

export interface MlxAudioEngineOptions {
  readonly dir: string;
  readonly spawn?: ServiceSpawn;
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly arch?: string;
  readonly startTimeoutMs?: number;
}

export const createMlxAudioEngine = ({ dir, platform, arch, ...options }: MlxAudioEngineOptions): KokoroEngine => {
  const paths = mlxAudioPaths(dir);
  return createServiceEngine({
    ...options,
    name: 'mlx-audio',
    dir,
    python: paths.python,
    service: paths.service,
    serviceSource: MLX_AUDIO_SERVICE_SOURCE,
    hfHome: paths.hfHome,
    tokenEnv: MLX_AUDIO_TOKEN_ENV,
    blends: true,
    ready: () => mlxAudioSupported(platform, arch) && mlxAudioInstalled(dir),
    body: ({ text, voiceId, speed, blend }) => ({
      text,
      voice: voiceId,
      speed,
      ...(blend === undefined ? {} : { blend }),
    }),
  });
};

export const createMlxAudioProvider = (
  options: MlxAudioEngineOptions & Pick<KokoroProviderOptions, 'idleTimeoutMs' | 'shaping' | 'voiceBlend'>,
): KokoroProvider =>
  createKokoroProvider({
    engine: createMlxAudioEngine(options),
    id: MLX_KOKORO_PROVIDER_ID,
    capabilities: MLX_KOKORO_CAPABILITIES,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    ...(options.shaping === undefined ? {} : { shaping: options.shaping }),
    ...(options.voiceBlend === undefined ? {} : { voiceBlend: options.voiceBlend }),
  });
