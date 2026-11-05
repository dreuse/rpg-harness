import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
const HTTPS = 'https:';
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const CONTENT_LENGTH = 'content-length';
const LOCATION = 'location';

const offerFor = (sounds: readonly SoundEntry[]): ModelOffer => {
  const bytes = sounds.reduce((sum, { bytes: size }) => sum + size, 0);
  const source = [...new Set(sounds.map(({ url }) => new URL(url).origin))].join(SOURCE_SEPARATOR);
  return Object.freeze({ source, bytes, sizeMiB: Math.round(bytes / BYTES_PER_MIB) });
};

const sha256Of = (bytes: Uint8Array): string => createHash(SHA256).update(bytes).digest(HEX);

const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

const verified = async (path: string, sound: SoundEntry): Promise<boolean> => {
  try {
    const bytes = await readFile(path);
    return bytes.length === sound.bytes && sha256Of(bytes) === sound.sha256;
  } catch {
    return false;
  }
};

const requireHttps = (url: string, file: string): URL => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (parsed?.protocol !== HTTPS) throw new Error(`sound download needs https: ${file}`);
  return parsed;
};

const readCapped = async (response: Response, sound: SoundEntry): Promise<Uint8Array> => {
  const tooLarge = () => new Error(`sound body larger than expected: ${sound.file}`);
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > sound.bytes) throw tooLarge();
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
};

export const createSoundManager = ({ dir, sounds, fetch: fetchFile = fetch }: SoundManagerOptions): SoundManager => {
  const offer = offerFor(sounds);
  const target = (sound: SoundEntry) => join(dir, sound.file);

  const fetchFollowing = async (sound: SoundEntry, signal: AbortSignal | undefined): Promise<Response> => {
    let url = requireHttps(sound.url, sound.file);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchFile(url.href, signal ? { signal, redirect: 'manual' } : { redirect: 'manual' });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get(LOCATION);
      url = requireHttps(location === null ? '' : new URL(location, url).href, sound.file);
    }
    throw new Error(`sound download followed too many redirects: ${sound.file}`);
  };

  const downloadOne = async (sound: SoundEntry, signal: AbortSignal | undefined): Promise<Uint8Array> => {
    const response = await fetchFollowing(sound, signal);
    if (!response.ok) throw new Error(`sound download failed: ${sound.file} (HTTP ${response.status})`);
    const declared = response.headers.get(CONTENT_LENGTH);
    if (declared !== null && Number(declared) !== sound.bytes) {
      throw new Error(`sound content-length ${declared} differs from expected ${sound.bytes}: ${sound.file}`);
    }
    const bytes = await readCapped(response, sound);
    if (sha256Of(bytes) !== sound.sha256) throw new Error(`sound checksum mismatch: ${sound.file}`);
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
      const intact = await Promise.all(sounds.map((sound) => verified(target(sound), sound)));
      return {
        installed: intact.every(Boolean),
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
        if (await verified(target(sound), sound)) continue;
        await install(sound, await downloadOne(sound, signal));
        total += sound.bytes;
        onProgress?.(total);
      }
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
};
