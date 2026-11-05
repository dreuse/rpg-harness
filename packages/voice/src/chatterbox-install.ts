import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHATTERBOX_MODEL_DIR_ENV,
  CHATTERBOX_MODEL_FILES,
  CHATTERBOX_MODEL_ID,
  CHATTERBOX_MODEL_REVISION,
  CHATTERBOX_SERVICE_SOURCE,
  chatterboxInstalled,
  chatterboxPaths,
} from './chatterbox-engine.ts';
import { consented, type ModelConsent, type ModelFile, type ModelOffer } from './kokoro-model.ts';
import { inheritedEnv } from './local-service-engine.ts';
import { mlxAudioSupported } from './mlx-audio-engine.ts';
import { isMissingCommand, runStep, type StepRunner } from './mlx-audio-install.ts';

export const CHATTERBOX_SPECS: readonly string[] = Object.freeze(['chatterbox-tts==0.1.7', 'setuptools<81']);

const UV = 'uv';
const PYTHON_VERSION = '3.12';
const PUBLIC_PYPI = 'https://pypi.org/simple';
const ISOLATED = '-I';
const DOWNLOAD = 'download';
const DISABLE_XET_ENV = 'HF_HUB_DISABLE_XET';
const DISABLED = '1';
const BYTES_PER_MIB = 1024 * 1024;
const MEASURED_INSTALL_MIB = 987;
const SHA256 = 'sha256';
const HEX = 'hex';

const offerBytes = (files: readonly ModelFile[]): number =>
  MEASURED_INSTALL_MIB * BYTES_PER_MIB + files.reduce((sum, file) => sum + file.bytes, 0);

export const CHATTERBOX_OFFER: ModelOffer = Object.freeze({
  source: `${PUBLIC_PYPI} (${CHATTERBOX_SPECS.join(', ')}), Python ${PYTHON_VERSION} via uv, https://huggingface.co/${CHATTERBOX_MODEL_ID}@${CHATTERBOX_MODEL_REVISION}`,
  bytes: offerBytes(CHATTERBOX_MODEL_FILES),
  sizeMiB: Math.round(offerBytes(CHATTERBOX_MODEL_FILES) / BYTES_PER_MIB),
});

export interface ChatterboxStatus {
  readonly supported: boolean;
  readonly installed: boolean;
}

export interface ChatterboxInstaller {
  readonly offer: ModelOffer;
  status(): Promise<ChatterboxStatus>;
  install(consent: ModelConsent | undefined, signal?: AbortSignal): Promise<void>;
  remove(): Promise<void>;
}

export interface ChatterboxInstallerOptions {
  readonly dir: string;
  readonly run?: StepRunner;
  readonly platform?: string;
  readonly arch?: string;
  readonly files?: readonly ModelFile[];
}

const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash(SHA256);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(HEX);
};

export const createChatterboxInstaller = ({
  dir,
  run = runStep,
  platform,
  arch,
  files = CHATTERBOX_MODEL_FILES,
}: ChatterboxInstallerOptions): ChatterboxInstaller => {
  const paths = chatterboxPaths(dir);

  const verify = async (): Promise<void> => {
    for (const file of files) {
      const target = join(paths.modelDir, file.path);
      if ((await sha256Of(target)) === file.sha256) continue;
      await rm(target, { force: true });
      throw new Error(`model checksum mismatch: ${file.path}`);
    }
  };

  return {
    offer: CHATTERBOX_OFFER,
    status: async () => ({ supported: mlxAudioSupported(platform, arch), installed: chatterboxInstalled(dir, files) }),
    install: async (consent, signal) => {
      if (!consented(consent, CHATTERBOX_OFFER)) throw new Error('Expressive voices need consent to download');
      if (!mlxAudioSupported(platform, arch)) throw new Error('Expressive voices need an Apple Silicon Mac');
      const env = inheritedEnv();
      const step = (command: string, args: readonly string[], stepEnv = env) =>
        run(command, args, { env: stepEnv, ...(signal ? { signal } : {}) });
      try {
        await step(UV, ['venv', '--no-config', '--allow-existing', '--python', PYTHON_VERSION, join(dir, 'venv')]);
      } catch (error) {
        if (isMissingCommand(error)) throw new Error('Expressive voices need uv to install. Install uv and try again.');
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
        ...CHATTERBOX_SPECS,
      ]);
      await mkdir(dir, { recursive: true });
      await copyFile(CHATTERBOX_SERVICE_SOURCE, paths.service);
      await step(paths.python, [ISOLATED, paths.service, DOWNLOAD], {
        ...env,
        HF_HOME: paths.hfHome,
        [CHATTERBOX_MODEL_DIR_ENV]: paths.modelDir,
        [DISABLE_XET_ENV]: DISABLED,
      });
      await verify();
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};
