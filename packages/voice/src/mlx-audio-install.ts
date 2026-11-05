import { execFile } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { consented, type ModelConsent, type ModelOffer } from './kokoro-model.ts';
import {
  inheritedEnv,
  MLX_AUDIO_MODEL_ID,
  MLX_AUDIO_MODEL_REVISION,
  MLX_AUDIO_SERVICE_SOURCE,
  mlxAudioInstalled,
  mlxAudioPaths,
  mlxAudioSupported,
} from './mlx-audio-engine.ts';

const SPACY_EN_MODEL =
  'en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl';
export const MLX_AUDIO_SPECS: readonly string[] = Object.freeze([
  'mlx-audio==0.6.4',
  'misaki[en]==0.9.4',
  SPACY_EN_MODEL,
]);

const UV = 'uv';
const PYTHON_VERSION = '3.12';
const PUBLIC_PYPI = 'https://pypi.org/simple';
const ISOLATED = '-I';
const DOWNLOAD = 'download';
const MISSING_COMMAND = 'ENOENT';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;
const MEASURED_INSTALL_MIB = 1159;
const MEASURED_MODEL_MIB = 340;
const OFFER_MIB = MEASURED_INSTALL_MIB + MEASURED_MODEL_MIB;

export const MLX_AUDIO_OFFER: ModelOffer = Object.freeze({
  source: `${PUBLIC_PYPI} (${MLX_AUDIO_SPECS.join(', ')}), Python ${PYTHON_VERSION} via uv, https://huggingface.co/${MLX_AUDIO_MODEL_ID}@${MLX_AUDIO_MODEL_REVISION}`,
  bytes: OFFER_MIB * BYTES_PER_MIB,
  sizeMiB: OFFER_MIB,
});

export interface StepOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export type StepRunner = (command: string, args: readonly string[], options: StepOptions) => Promise<void>;

export interface MlxAudioStatus {
  readonly supported: boolean;
  readonly installed: boolean;
}

export interface MlxAudioInstaller {
  readonly offer: ModelOffer;
  status(): Promise<MlxAudioStatus>;
  install(consent: ModelConsent | undefined, signal?: AbortSignal): Promise<void>;
  remove(): Promise<void>;
}

export interface MlxAudioInstallerOptions {
  readonly dir: string;
  readonly run?: StepRunner;
  readonly platform?: string;
  readonly arch?: string;
}

const execFileStep = promisify(execFile);

const runStep: StepRunner = async (command, args, { env, signal }) => {
  await execFileStep(command, [...args], { env, maxBuffer: MAX_OUTPUT_BYTES, ...(signal ? { signal } : {}) });
};

const isMissingCommand = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === MISSING_COMMAND;

export const createMlxAudioInstaller = ({
  dir,
  run = runStep,
  platform,
  arch,
}: MlxAudioInstallerOptions): MlxAudioInstaller => {
  const paths = mlxAudioPaths(dir);
  return {
    offer: MLX_AUDIO_OFFER,
    status: async () => ({ supported: mlxAudioSupported(platform, arch), installed: mlxAudioInstalled(dir) }),
    install: async (consent, signal) => {
      if (!consented(consent, MLX_AUDIO_OFFER)) throw new Error('Brazilian Portuguese voices need consent to download');
      if (!mlxAudioSupported(platform, arch)) throw new Error('Brazilian Portuguese voices need an Apple Silicon Mac');
      const env = inheritedEnv();
      const step = (command: string, args: readonly string[], stepEnv = env) =>
        run(command, args, { env: stepEnv, ...(signal ? { signal } : {}) });
      try {
        await step(UV, ['venv', '--no-config', '--allow-existing', '--python', PYTHON_VERSION, join(dir, 'venv')]);
      } catch (error) {
        if (isMissingCommand(error))
          throw new Error('Brazilian Portuguese voices need uv to install. Install uv and try again.');
        throw error;
      }
      await step(UV, [
        'pip',
        'install',
        '--no-config',
        '--default-index',
        PUBLIC_PYPI,
        '--python',
        paths.python,
        ...MLX_AUDIO_SPECS,
      ]);
      await mkdir(dir, { recursive: true });
      await copyFile(MLX_AUDIO_SERVICE_SOURCE, paths.service);
      await step(paths.python, [ISOLATED, paths.service, DOWNLOAD], { ...env, HF_HOME: paths.hfHome });
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};
