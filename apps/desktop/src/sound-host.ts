import { readFile } from 'node:fs/promises';
import type { ModelOffer } from '../../../packages/voice/src/kokoro-model.ts';
import { createSoundManager } from '../../../packages/voice/src/sound-downloader.ts';
import { loadBundledManifest, type SoundEntry } from '../../../packages/voice/src/sound-manifest.ts';
import { isConsent } from './voice-host.ts';

export type SoundHostStatus = {
  readonly installed: boolean;
  readonly bytes: number;
  readonly available?: readonly string[];
  readonly offer: ModelOffer;
};

export type SoundHost = {
  status(): Promise<SoundHostStatus>;
  download(consent: unknown, onProgress: (bytes: number) => void): Promise<void>;
  file(kind: unknown, key: unknown): Promise<Uint8Array | undefined>;
};

export const createSoundHost = ({
  dir,
  sounds = loadBundledManifest(),
  fetch: fetchFile,
}: {
  readonly dir: string;
  readonly sounds?: readonly SoundEntry[];
  readonly fetch?: typeof fetch;
}): SoundHost => {
  const manager = createSoundManager({ dir, sounds, ...(fetchFile === undefined ? {} : { fetch: fetchFile }) });
  let running: Promise<void> | undefined;
  return {
    status: async () => ({ ...(await manager.status()), offer: manager.offer }),
    download: (consent, onProgress) => {
      if (!isConsent(consent)) return Promise.reject(new RangeError('download consent is invalid'));
      running ??= manager.download(consent, undefined, onProgress).finally(() => {
        running = undefined;
      });
      return running;
    },
    file: async (kind, key) => {
      const entry = sounds.find((sound) => sound.kind === kind && sound.key === key);
      if (entry === undefined) throw new RangeError('unknown sound');
      const path = manager.pathOf(entry.kind, entry.key);
      return path === undefined ? undefined : new Uint8Array(await readFile(path));
    },
  };
};
