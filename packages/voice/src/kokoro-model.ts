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
  download(consent: ModelConsent, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<void>;
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

export const KOKORO_PT_BR_VOICE_FILES: readonly ModelFile[] = Object.freeze([
  {
    path: 'voices/pf_dora.bin',
    sha256: '3da7b5b2d91847ebf5646f57631af6ececae3c29a89cd300f06edf9aa6cfe9ee',
    bytes: 522_240,
  },
  {
    path: 'voices/pm_alex.bin',
    sha256: '0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a',
    bytes: 522_240,
  },
  {
    path: 'voices/pm_santa.bin',
    sha256: '8b012db3185778afe2e45a62cbad69db73021774fe68dda634bcc748a982eede',
    bytes: 522_240,
  },
  {
    path: 'voices/af_bella.bin',
    sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
    bytes: 522_240,
  },
  {
    path: 'voices/af_sarah.bin',
    sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
    bytes: 522_240,
  },
  {
    path: 'voices/am_adam.bin',
    sha256: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716',
    bytes: 522_240,
  },
  {
    path: 'voices/am_liam.bin',
    sha256: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade',
    bytes: 522_240,
  },
  {
    path: 'voices/am_onyx.bin',
    sha256: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6',
    bytes: 522_240,
  },
  {
    path: 'voices/bf_emma.bin',
    sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
    bytes: 522_240,
  },
]);
export const KOKORO_PT_BR_MODEL_FILES: readonly ModelFile[] = Object.freeze([
  ...KOKORO_MODEL_FILES,
  ...KOKORO_PT_BR_VOICE_FILES,
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

export const KOKORO_PT_BR_MODEL_OFFER = offerFor(KOKORO_PT_BR_MODEL_FILES, KOKORO_MODEL_SOURCE);

export const kokoroModelRoot = (dir: string): string => join(dir, KOKORO_MODEL_ID);

export const consented = (consent: ModelConsent | undefined, offer: ModelOffer): boolean =>
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

  const downloadFile = async (
    file: ModelFile,
    signal: AbortSignal | undefined,
    received: (bytes: number) => void,
  ): Promise<void> => {
    const target = join(root, file.path);
    if ((await sizeOf(target)) === file.bytes) {
      received(file.bytes);
      return;
    }
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
          received(chunk.byteLength);
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
    download: async (consent, signal, onProgress) => {
      if (!consented(consent, offer)) {
        throw new Error('model download needs explicit consent to the offered size and source');
      }
      let total = 0;
      const received = (bytes: number) => {
        total += bytes;
        onProgress?.(total);
      };
      for (const file of files) await downloadFile(file, signal, received);
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
};
