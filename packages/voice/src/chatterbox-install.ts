import {
  CHATTERBOX_MODEL_DIR_ENV,
  CHATTERBOX_MODEL_FILES,
  CHATTERBOX_MODEL_ID,
  CHATTERBOX_MODEL_REVISION,
  CHATTERBOX_SERVICE_SOURCE,
  CHATTERBOX_WAIT_NOTE,
  chatterboxInstalled,
  chatterboxPaths,
} from './chatterbox-engine.ts';
import type { ModelFile, ModelOffer } from './kokoro-model.ts';
import { mlxAudioSupported } from './mlx-audio-engine.ts';
import type { StepRunner } from './mlx-audio-install.ts';
import {
  BYTES_PER_MIB,
  createPythonServiceInstaller,
  PUBLIC_PYPI,
  PYTHON_VERSION,
  type PythonServiceInstaller,
  type PythonServiceStatus,
} from './python-service-install.ts';

export const CHATTERBOX_SPECS: readonly string[] = Object.freeze(['chatterbox-tts==0.1.7', 'setuptools<81']);

const MEASURED_INSTALL_MIB = 987;

const offerBytes = (files: readonly ModelFile[]): number =>
  MEASURED_INSTALL_MIB * BYTES_PER_MIB + files.reduce((sum, file) => sum + file.bytes, 0);

export const CHATTERBOX_OFFER: ModelOffer = Object.freeze({
  source: `${PUBLIC_PYPI} (${CHATTERBOX_SPECS.join(', ')}), Python ${PYTHON_VERSION} via uv, https://huggingface.co/${CHATTERBOX_MODEL_ID}@${CHATTERBOX_MODEL_REVISION}. ${CHATTERBOX_WAIT_NOTE}`,
  bytes: offerBytes(CHATTERBOX_MODEL_FILES),
  sizeMiB: Math.round(offerBytes(CHATTERBOX_MODEL_FILES) / BYTES_PER_MIB),
});

export type ChatterboxStatus = PythonServiceStatus;
export type ChatterboxInstaller = PythonServiceInstaller;

export interface ChatterboxInstallerOptions {
  readonly dir: string;
  readonly run?: StepRunner;
  readonly platform?: string;
  readonly arch?: string;
  readonly files?: readonly ModelFile[];
}

export const createChatterboxInstaller = ({
  dir,
  run,
  platform,
  arch,
  files = CHATTERBOX_MODEL_FILES,
}: ChatterboxInstallerOptions): ChatterboxInstaller => {
  const paths = chatterboxPaths(dir);
  return createPythonServiceInstaller({
    dir,
    offer: CHATTERBOX_OFFER,
    specs: CHATTERBOX_SPECS,
    python: paths.python,
    service: paths.service,
    serviceSource: CHATTERBOX_SERVICE_SOURCE,
    hfHome: paths.hfHome,
    modelDir: paths.modelDir,
    files,
    downloadEnv: { [CHATTERBOX_MODEL_DIR_ENV]: paths.modelDir },
    supported: () => mlxAudioSupported(platform, arch),
    installed: () => chatterboxInstalled(dir, files),
    messages: {
      consent: 'Expressive voices need consent to download',
      unsupported: 'Expressive voices need an Apple Silicon Mac',
      uv: 'Expressive voices need uv to install. Install uv and try again.',
    },
    ...(run ? { run } : {}),
  });
};
