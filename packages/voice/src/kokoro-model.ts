import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ModelFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ModelOffer {
  readonly source: string;
  readonly bytes: number;
  readonly sizeMiB: number;
}

export interface ModelConsent extends ModelOffer {
  readonly accepted: true;
}

export interface ModelStatus {
  readonly installed: boolean;
  readonly bytes: number;
}

export interface ModelManagerOptions {
  readonly dir: string;
  readonly fetch?: typeof fetch;
  readonly files?: readonly ModelFile[];
  readonly source?: string;
}

export interface ModelManager {
  readonly offer: ModelOffer;
  status(): Promise<ModelStatus>;
  download(consent: ModelConsent, signal?: AbortSignal): Promise<void>;
  remove(): Promise<void>;
}

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_MODEL_SOURCE = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main`;
export const KOKORO_WEIGHTS_PATH = 'onnx/model.onnx';
export const KOKORO_MODEL_FILES: readonly ModelFile[] = Object.freeze([
  { path: 'config.json', sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f', bytes: 44 },
  { path: 'tokenizer.json', sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34', bytes: 3497 },
  {
    path: 'tokenizer_config.json',
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
    bytes: 113,
  },
  {
    path: KOKORO_WEIGHTS_PATH,
    sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
    bytes: 325_532_232,
  },
]);

const BYTES_PER_MIB = 1024 * 1024;
const SHA256 = 'sha256';
const HEX = 'hex';
const PARTIAL_SUFFIX = '.partial';
const WRITE_MODE = 'w';

const offerFor = (files: readonly ModelFile[], source: string): ModelOffer => {
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return Object.freeze({ source, bytes, sizeMiB: Math.round(bytes / BYTES_PER_MIB) });
};

export const KOKORO_MODEL_OFFER = offerFor(KOKORO_MODEL_FILES, KOKORO_MODEL_SOURCE);

export const kokoroModelRoot = (dir: string): string => join(dir, KOKORO_MODEL_ID);

const consented = (consent: ModelConsent | undefined, offer: ModelOffer): boolean =>
  consent?.accepted === true && consent.source === offer.source && consent.bytes === offer.bytes;

const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

export const createKokoroModelManager = ({
  dir,
  fetch: fetchFile = fetch,
  files = KOKORO_MODEL_FILES,
  source = KOKORO_MODEL_SOURCE,
}: ModelManagerOptions): ModelManager => {
  const root = kokoroModelRoot(dir);
  const offer = offerFor(files, source);

  const downloadFile = async (file: ModelFile, signal: AbortSignal | undefined): Promise<void> => {
    const target = join(root, file.path);
    const partial = `${target}${PARTIAL_SUFFIX}`;
    await mkdir(dirname(target), { recursive: true });
    const response = await fetchFile(`${source}/${file.path}`, signal ? { signal } : {});
    if (!response.ok || !response.body)
      throw new Error(`model download failed: ${file.path} (HTTP ${response.status})`);
    try {
      const hash = createHash(SHA256);
      const handle = await open(partial, WRITE_MODE);
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          await handle.write(chunk);
        }
      } finally {
        await handle.close();
      }
      if (hash.digest(HEX) !== file.sha256) throw new Error(`model checksum mismatch: ${file.path}`);
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  };

  return {
    offer,
    status: async () => {
      const sizes = await Promise.all(files.map((file) => sizeOf(join(root, file.path))));
      return {
        installed: files.every((file, index) => sizes[index] === file.bytes),
        bytes: sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0),
      };
    },
    download: async (consent, signal) => {
      if (!consented(consent, offer)) {
        throw new Error('model download needs explicit consent to the offered size and source');
      }
      for (const file of files) await downloadFile(file, signal);
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
};
