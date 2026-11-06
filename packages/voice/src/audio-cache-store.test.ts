import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFileAudioCache } from './audio-cache-store.ts';
import type { SpeechChunk } from './tts.ts';

const CHUNK_BYTES = 100;
const ENTRY_COUNT = 3;
const TEMP_PREFIX = 'rpg-audio-cache-';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const chunks = (fill: number): readonly SpeechChunk[] => [
  {
    utteranceEventId: 'ev',
    sequence: 0,
    audio: new Uint8Array(CHUNK_BYTES).fill(fill),
    mimeType: 'audio/wav',
    voiceId: 'v',
    final: true,
  },
];

const diskBytes = (): number => readdirSync(dir).reduce((total, name) => total + statSync(join(dir, name)).size, 0);

const entrySize = (): number => {
  const probe = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  probe.set('probe', chunks(0));
  const size = diskBytes();
  rmSync(dir, { recursive: true, force: true });
  return size;
};

test('entries survive a restart', () => {
  createFileAudioCache(dir, Number.MAX_SAFE_INTEGER).set('k', chunks(7));
  const reopened = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(reopened.get('k'), chunks(7));
  assert.equal(reopened.bytes, diskBytes());
});

test('evicts the least recently used entry and never exceeds the size limit', () => {
  const size = entrySize();
  const cache = createFileAudioCache(dir, size * (ENTRY_COUNT - 1));
  cache.set('a', chunks(1));
  cache.set('b', chunks(2));
  assert.ok(cache.get('a'));
  cache.set('c', chunks(3));
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('a'));
  assert.ok(cache.get('c'));
  assert.ok(cache.bytes <= size * (ENTRY_COUNT - 1));
  assert.ok(diskBytes() <= size * (ENTRY_COUNT - 1));
  const reopened = createFileAudioCache(dir, size * (ENTRY_COUNT - 1));
  reopened.set('d', chunks(4));
  assert.equal(reopened.get('a'), undefined);
  assert.ok(reopened.get('c'));
  assert.ok(diskBytes() <= size * (ENTRY_COUNT - 1));
});

test('reopening with a smaller limit evicts down to it', () => {
  const size = entrySize();
  const roomy = createFileAudioCache(dir, size * ENTRY_COUNT);
  for (const [key, fill] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ] as const)
    roomy.set(key, chunks(fill));
  const reopened = createFileAudioCache(dir, size);
  assert.equal(reopened.bytes, size);
  assert.equal(diskBytes(), size);
  assert.ok(reopened.get('c'));
  assert.equal(reopened.get('a'), undefined);
});

test('an entry larger than the limit is not stored', () => {
  const cache = createFileAudioCache(dir, 1);
  cache.set('big', chunks(1));
  assert.equal(cache.get('big'), undefined);
  assert.deepEqual(readdirSync(dir), []);
});

test('hostile keys cannot escape the directory', () => {
  const cache = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  cache.set('../../escape', chunks(1));
  const [name, ...rest] = readdirSync(dir);
  assert.match(name ?? '', /^[0-9a-f]+\.json$/);
  assert.deepEqual(rest, []);
});

test('a corrupt file is dropped', () => {
  const cache = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  cache.set('k', chunks(1));
  const [file] = readdirSync(dir);
  writeFileSync(join(dir, file as string), 'not json');
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.bytes, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('a failed write is dropped without throwing', () => {
  const cache = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, 'not a directory');
  assert.doesNotThrow(() => cache.set('k', chunks(1)));
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.bytes, 0);
});

test('an entry written by another instance on the same directory is a hit', () => {
  const reader = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  const writer = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  writer.set('shared', chunks(1));
  assert.deepEqual(reader.get('shared'), chunks(1));
  assert.equal(reader.bytes, diskBytes());
});

test('a missing file on an index miss stays a miss', () => {
  const reader = createFileAudioCache(dir, Number.MAX_SAFE_INTEGER);
  assert.equal(reader.get('absent'), undefined);
  assert.equal(reader.bytes, 0);
});
