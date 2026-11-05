import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { consented, type ModelConsent, type ModelOffer, type ModelStatus } from './kokoro-model.ts';
import type { SoundEntry, SoundKind } from './sound-manifest.ts';

export interface SoundManagerOptions {
  readonly dir: string;
  readonly sounds: readonly SoundEntry[];
  readonly fetch?: typeof fetch;
}

export interface SoundManager {
  readonly offer: ModelOffer;
  status(): Promise<ModelStatus>;
  pathOf(kind: SoundKind, key: string): string | undefined;
  download(consent: ModelConsent, signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<void>;
  remove(): Promise<void>;
}

const BYTES_PER_MIB = 1024 * 1024;
const SOURCE_SEPARATOR = ', ';
const PARTIAL_SUFFIX = '.partial';
const SHA256 = 'sha256';
const HEX = 'hex';

const offerFor = (sounds: readonly SoundEntry[]): ModelOffer => {
  const bytes = sounds.reduce((sum, { bytes: size }) => sum + size, 0);
  const source = [...new Set(sounds.map(({ url }) => new URL(url).origin))].join(SOURCE_SEPARATOR);
  return Object.freeze({ source, bytes, sizeMiB: Math.round(bytes / BYTES_PER_MIB) });
};

const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

export const createSoundManager = ({ dir, sounds, fetch: fetchFile = fetch }: SoundManagerOptions): SoundManager => {
  const offer = offerFor(sounds);
  const target = (sound: SoundEntry) => join(dir, sound.file);

  const downloadOne = async (sound: SoundEntry, signal: AbortSignal | undefined): Promise<Uint8Array> => {
    const response = await fetchFile(sound.url, signal ? { signal } : {});
    if (!response.ok) throw new Error(`sound download failed: ${sound.file} (HTTP ${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash(SHA256).update(bytes).digest(HEX) !== sound.sha256) {
      throw new Error(`sound checksum mismatch: ${sound.file}`);
    }
    return bytes;
  };

  const install = async (sound: SoundEntry, bytes: Uint8Array): Promise<void> => {
    const path = target(sound);
    const partial = `${path}${PARTIAL_SUFFIX}`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(partial, bytes);
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  };

  return {
    offer,
    status: async () => {
      const sizes = await Promise.all(sounds.map((sound) => sizeOf(target(sound))));
      return {
        installed: sounds.every((sound, index) => sizes[index] === sound.bytes),
        bytes: sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0),
      };
    },
    pathOf: (kind, key) => {
      const sound = sounds.find((entry) => entry.kind === kind && entry.key === key);
      return sound !== undefined && existsSync(target(sound)) ? target(sound) : undefined;
    },
    download: async (consent, signal, onProgress) => {
      if (!consented(consent, offer)) {
        throw new Error('sound download needs explicit consent to the offered size and source');
      }
      let total = 0;
      for (const sound of sounds) {
        if ((await sizeOf(target(sound))) === sound.bytes) continue;
        await install(sound, await downloadOne(sound, signal));
        total += sound.bytes;
        onProgress?.(total);
      }
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};
