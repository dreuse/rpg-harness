import { writeFile } from 'node:fs/promises';
import {
  F5_ACOUSTIC_MODEL,
  F5_BASE_MODEL,
  F5_LICENCE,
  F5_MANIFEST_ENV,
  F5_MODEL_DIR_ENV,
  F5_MODEL_FILES,
  F5_SERVICE_SOURCE,
  F5_VOCODER_MODEL,
  F5_WAIT_NOTE,
  f5Installed,
  f5Manifest,
  f5Paths,
  VOCODER_LICENCE,
} from './f5-tts-engine.ts';
import { F5_VOICES, FLEURS_ARCHIVE_READ_LIMIT_BYTES, FLEURS_REPO, FLEURS_REVISION } from './f5-voices.ts';
import type { ModelFile, ModelOffer } from './kokoro-model.ts';
import type { StepRunner } from './mlx-audio-install.ts';
import {
  BYTES_PER_MIB,
  createPythonServiceInstaller,
  PUBLIC_PYPI,
  PYTHON_VERSION,
  type PythonServiceInstaller,
  type PythonServiceStatus,
} from './python-service-install.ts';

export const F5_SPECS: readonly string[] = Object.freeze(['f5-tts==1.1.22', 'setuptools<81']);

const MEASURED_INSTALL_MIB = 1549;
const SIZE_NOTE = 'Size measured on macOS only. Linux and Windows downloads are larger, several GB more with CUDA.';
const SUPPORTED_PLATFORMS: readonly string[] = ['darwin', 'linux', 'win32'];
const HUGGING_FACE = 'https://huggingface.co';

const offerBytes = (files: readonly ModelFile[]): number =>
  MEASURED_INSTALL_MIB * BYTES_PER_MIB +
  files.reduce((sum, file) => sum + file.bytes, 0) +
  Object.values(FLEURS_ARCHIVE_READ_LIMIT_BYTES).reduce((sum, bytes) => sum + bytes, 0);

const repoAt = ({ repo, revision }: { readonly repo: string; readonly revision: string }): string =>
  `${HUGGING_FACE}/${repo}@${revision}`;

const voiceLicence = F5_VOICES[0]?.licence ?? '';

export const F5_OFFER: ModelOffer = Object.freeze({
  source: `${PUBLIC_PYPI} (${F5_SPECS.join(', ')}), Python ${PYTHON_VERSION} via uv, ${repoAt(F5_ACOUSTIC_MODEL)} (${F5_LICENCE}), ${repoAt(F5_BASE_MODEL)} (${F5_LICENCE}), ${repoAt(F5_VOCODER_MODEL)} (${VOCODER_LICENCE}), reference clips from ${repoAt({ repo: `datasets/${FLEURS_REPO}`, revision: FLEURS_REVISION })} (${voiceLicence}). ${SIZE_NOTE} ${F5_WAIT_NOTE}`,
  bytes: offerBytes(F5_MODEL_FILES),
  sizeMiB: Math.round(offerBytes(F5_MODEL_FILES) / BYTES_PER_MIB),
});

export type F5Status = PythonServiceStatus;
export type F5Installer = PythonServiceInstaller;

export interface F5InstallerOptions {
  readonly dir: string;
  readonly run?: StepRunner;
  readonly platform?: string;
  readonly files?: readonly ModelFile[];
}

export const createF5Installer = ({
  dir,
  run,
  platform = process.platform,
  files = F5_MODEL_FILES,
}: F5InstallerOptions): F5Installer => {
  const paths = f5Paths(dir, platform);
  return createPythonServiceInstaller({
    dir,
    offer: F5_OFFER,
    specs: F5_SPECS,
    python: paths.python,
    service: paths.service,
    serviceSource: F5_SERVICE_SOURCE,
    hfHome: paths.hfHome,
    modelDir: paths.modelDir,
    files,
    downloadEnv: { [F5_MODEL_DIR_ENV]: paths.modelDir, [F5_MANIFEST_ENV]: paths.manifest },
    supported: () => SUPPORTED_PLATFORMS.includes(platform),
    installed: () => f5Installed(dir, platform, files),
    messages: {
      consent: 'The F5-TTS voice needs consent to download',
      unsupported: 'The F5-TTS voice needs macOS, Windows or Linux',
      uv: 'The F5-TTS voice needs uv to install. Install uv and try again.',
    },
    prepare: () => writeFile(paths.manifest, JSON.stringify(f5Manifest())),
    ...(run ? { run } : {}),
  });
};
