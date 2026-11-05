import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createSoundManager } from './sound-downloader.ts';
import type { SoundEntry } from './sound-manifest.ts';

const CONTENT = new TextEncoder().encode('loop-audio');
const TAMPERED = new TextEncoder().encode('evil-audio');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const SOUNDS: readonly SoundEntry[] = [
  {
    kind: 'music',
    key: 'calm',
    file: 'music/calm.ogg',
    mimeType: 'audio/ogg',
    url: 'https://sounds.example/calm.ogg',
    sourcePage: 'https://sounds.example/calm',
    author: 'Someone',
    license: 'CC0',
    sha256: sha256(CONTENT),
    bytes: CONTENT.length,
  },
];
const dirs: string[] = [];
const NOT_FOUND = 404;

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-manager-'));
  dirs.push(dir);
  return dir;
};

const serving =
  (body: Uint8Array<ArrayBuffer>, status = 200): typeof fetch =>
  async () =>
    new Response(status === 200 ? body : null, { status });

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('offers the total size and the hosts the sounds come from', async () => {
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS });
  assert.equal(manager.offer.bytes, CONTENT.length);
  assert.equal(manager.offer.source, 'https://sounds.example');
});

test('refuses to download without consent to the offered size and source', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  await assert.rejects(
    manager.download({ ...manager.offer, accepted: true, bytes: manager.offer.bytes + 1 }),
    /explicit consent/,
  );
  assert.deepEqual(await readdir(dir), []);
});

test('downloads once with consent, verifies sha256 and reports installed sounds', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  assert.equal(manager.pathOf('music', 'calm'), undefined);
  const progress: number[] = [];
  await manager.download({ ...manager.offer, accepted: true }, undefined, (bytes) => progress.push(bytes));
  const path = manager.pathOf('music', 'calm');
  assert.equal(path, join(dir, 'music/calm.ogg'));
  assert.deepEqual(new Uint8Array(await readFile(path ?? '')), CONTENT);
  assert.deepEqual(await manager.status(), { installed: true, bytes: CONTENT.length });
  assert.deepEqual(progress, [CONTENT.length]);
});

test('does not download again when a verified file is already installed', async () => {
  const dir = await tempDir();
  let calls = 0;
  const counting: typeof fetch = async () => {
    calls += 1;
    return new Response(CONTENT);
  };
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: counting });
  await manager.download({ ...manager.offer, accepted: true });
  await manager.download({ ...manager.offer, accepted: true });
  assert.equal(calls, 1);
});

test('rejects and removes a file whose sha256 does not match', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(TAMPERED) });
  await assert.rejects(manager.download({ ...manager.offer, accepted: true }), /checksum mismatch/);
  assert.equal(manager.pathOf('music', 'calm'), undefined);
  assert.deepEqual(await manager.status(), { installed: false, bytes: 0 });
});

test('fails on an HTTP error without leaving files', async () => {
  const manager = createSoundManager({ dir: await tempDir(), sounds: SOUNDS, fetch: serving(CONTENT, NOT_FOUND) });
  await assert.rejects(manager.download({ ...manager.offer, accepted: true }), /HTTP 404/);
  assert.equal(manager.pathOf('music', 'calm'), undefined);
});

test('remove deletes every downloaded sound', async () => {
  const dir = await tempDir();
  const manager = createSoundManager({ dir, sounds: SOUNDS, fetch: serving(CONTENT) });
  await manager.download({ ...manager.offer, accepted: true });
  await manager.remove();
  assert.equal(manager.pathOf('music', 'calm'), undefined);
});
