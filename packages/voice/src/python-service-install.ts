import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { consented, type ModelConsent, type ModelFile, type ModelOffer } from './kokoro-model.ts';
import { inheritedEnv } from './local-service-engine.ts';
import { isMissingCommand, runStep, type StepRunner } from './mlx-audio-install.ts';

export const UV = 'uv';
export const PYTHON_VERSION = '3.12';
export const PUBLIC_PYPI = 'https://pypi.org/simple';
export const BYTES_PER_MIB = 1024 * 1024;

const ISOLATED = '-I';
const DOWNLOAD = 'download';
const DISABLE_XET_ENV = 'HF_HUB_DISABLE_XET';
const DISABLED = '1';
const SHA256 = 'sha256';
const HEX = 'hex';

export interface PythonServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
}

export interface PythonServiceInstaller {
  readonly offer: ModelOffer;
  status(): Promise<PythonServiceStatus>;
  install(consent: ModelConsent | undefined, signal?: AbortSignal): Promise<void>;
  remove(): Promise<void>;
}

export interface PythonServiceInstallOptions {
  readonly dir: string;
  readonly offer: ModelOffer;
  readonly specs: readonly string[];
  readonly python: string;
  readonly service: string;
  readonly serviceSource: string;
  readonly hfHome: string;
  readonly modelDir: string;
  readonly files: readonly ModelFile[];
  readonly downloadEnv: Readonly<Record<string, string>>;
  readonly supported: () => boolean;
  readonly installed: () => boolean;
  readonly messages: { readonly consent: string; readonly unsupported: string; readonly uv: string };
  readonly prepare?: () => Promise<void>;
  readonly run?: StepRunner;
}

export const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash(SHA256);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(HEX);
};

export const createPythonServiceInstaller = ({
  dir,
  offer,
  specs,
  python,
  service,
  serviceSource,
  hfHome,
  modelDir,
  files,
  downloadEnv,
  supported,
  installed,
  messages,
  prepare,
  run = runStep,
}: PythonServiceInstallOptions): PythonServiceInstaller => {
  const verify = async (): Promise<void> => {
    for (const file of files) {
      const target = join(modelDir, file.path);
      if ((await sha256Of(target)) === file.sha256) continue;
      await rm(target, { force: true });
      throw new Error(`model checksum mismatch: ${file.path}`);
    }
  };

  return {
    offer,
    status: async () => ({ supported: supported(), installed: installed() }),
    install: async (consent, signal) => {
      if (!consented(consent, offer)) throw new Error(messages.consent);
      if (!supported()) throw new Error(messages.unsupported);
      const env = inheritedEnv();
      const step = (command: string, args: readonly string[], stepEnv = env) =>
        run(command, args, { env: stepEnv, ...(signal ? { signal } : {}) });
      try {
        await step(UV, ['venv', '--no-config', '--allow-existing', '--python', PYTHON_VERSION, join(dir, 'venv')]);
      } catch (error) {
        if (isMissingCommand(error)) throw new Error(messages.uv);
        throw error;
      }
      await step(UV, ['pip', 'install', '--no-config', '--default-index', PUBLIC_PYPI, '--python', python, ...specs]);
      await mkdir(dir, { recursive: true });
      await copyFile(serviceSource, service);
      await prepare?.();
      await step(python, [ISOLATED, service, DOWNLOAD], {
        ...env,
        HF_HOME: hfHome,
        ...downloadEnv,
        [DISABLE_XET_ENV]: DISABLED,
      });
      await verify();
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};
