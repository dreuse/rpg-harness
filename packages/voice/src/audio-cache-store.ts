import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioCache } from './audio-budget.ts';
import type { SpeechChunk } from './tts.ts';

const FILE_SUFFIX = '.json';
const HASH_ALGORITHM = 'sha256';
const AUDIO_ENCODING = 'base64';
const MS_PER_SECOND = 1000;

interface Entry {
  readonly size: number;
  readonly used: number;
}

interface StoredChunk extends Omit<SpeechChunk, 'audio'> {
  readonly audio: string;
}

const fileNameOf = (key: string): string => `${createHash(HASH_ALGORITHM).update(key).digest('hex')}${FILE_SUFFIX}`;

const removeFile = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    return;
  }
};

const decode = (text: string): readonly SpeechChunk[] =>
  (JSON.parse(text) as StoredChunk[]).map((chunk) => ({
    ...chunk,
    audio: new Uint8Array(Buffer.from(chunk.audio, AUDIO_ENCODING)),
  }));

const encode = (chunks: readonly SpeechChunk[]): string =>
  JSON.stringify(chunks.map((chunk) => ({ ...chunk, audio: Buffer.from(chunk.audio).toString(AUDIO_ENCODING) })));

export const createFileAudioCache = (dir: string, maxBytes: number): AudioCache => {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a finite number >= 0');
  mkdirSync(dir, { recursive: true });
  const entries = new Map<string, Entry>();
  let bytes = 0;
  let lastUsed = 0;
  const nextUse = (): number => {
    lastUsed = Math.max(Date.now(), lastUsed + 1);
    return lastUsed;
  };
  const forget = (name: string): void => {
    bytes -= entries.get(name)?.size ?? 0;
    entries.delete(name);
    removeFile(join(dir, name));
  };
  for (const name of readdirSync(dir).filter((file) => file.endsWith(FILE_SUFFIX))) {
    const { size, mtimeMs } = statSync(join(dir, name));
    entries.set(name, { size, used: mtimeMs });
    bytes += size;
    lastUsed = Math.max(lastUsed, mtimeMs);
  }
  const touch = (name: string, size: number): void => {
    const used = nextUse();
    entries.set(name, { size, used });
    utimesSync(join(dir, name), used / MS_PER_SECOND, used / MS_PER_SECOND);
  };
  const evictUntilFits = (size: number): void => {
    const oldestFirst = [...entries].sort(([, left], [, right]) => left.used - right.used);
    for (const [name] of oldestFirst) {
      if (bytes + size <= maxBytes) return;
      forget(name);
    }
  };
  evictUntilFits(0);
  return {
    get bytes() {
      return bytes;
    },
    get(key) {
      const name = fileNameOf(key);
      const entry = entries.get(name);
      if (!entry) return undefined;
      try {
        const chunks = decode(readFileSync(join(dir, name), 'utf8'));
        touch(name, entry.size);
        return chunks;
      } catch {
        forget(name);
        return undefined;
      }
    },
    set(key, chunks) {
      const name = fileNameOf(key);
      forget(name);
      const text = encode(chunks);
      const size = Buffer.byteLength(text);
      if (size > maxBytes) return;
      evictUntilFits(size);
      try {
        writeFileSync(join(dir, name), text);
      } catch {
        removeFile(join(dir, name));
        return;
      }
      bytes += size;
      touch(name, size);
    },
  };
};
