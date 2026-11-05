import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { SoundEntry } from '../../../packages/voice/src/sound-manifest.ts';
import { createSoundHost } from './sound-host.ts';

const CONTENT = new TextEncoder().encode('calm-loop');
const DIR_PREFIX = 'rpg-sound-host-';
const OK = 200;
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
    sha256: createHash('sha256').update(CONTENT).digest('hex'),
    bytes: CONTENT.length,
  },
];

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const serving = (requests: string[] = []): typeof fetch => {
  return (async (url: string) => {
    requests.push(url);
    return new Response(CONTENT, { status: OK });
  }) as unknown as typeof fetch;
};

const consentTo = (offer: { source: string; bytes: number; sizeMiB: number }) => ({ ...offer, accepted: true });

test('rpg-cm63.33 status offers the pack and reports it missing until downloaded', async () => {
  const host = createSoundHost({ dir, sounds: SOUNDS, fetch: serving() });
  const { installed, offer } = await host.status();
  assert.equal(installed, false);
  assert.equal(offer.bytes, CONTENT.length);
  assert.equal(offer.source, 'https://sounds.example');
});

test('rpg-cm63.33 download needs valid consent and reports progress', async () => {
  const requests: string[] = [];
  const host = createSoundHost({ dir, sounds: SOUNDS, fetch: serving(requests) });
  const { offer } = await host.status();
  await assert.rejects(
    host.download(undefined, () => {}),
    RangeError,
  );
  await assert.rejects(
    host.download({ accepted: false }, () => {}),
    RangeError,
  );
  assert.deepEqual(requests, []);
  const progress: number[] = [];
  await host.download(consentTo(offer), (bytes) => progress.push(bytes));
  assert.deepEqual(progress, [CONTENT.length]);
  assert.equal((await host.status()).installed, true);
  assert.deepEqual(readdirSync(join(dir, 'music')), ['calm.ogg']);
});

test('rpg-cm63.33 consent for a different offer is refused', async () => {
  const host = createSoundHost({ dir, sounds: SOUNDS, fetch: serving() });
  const { offer } = await host.status();
  await assert.rejects(host.download(consentTo({ ...offer, bytes: offer.bytes + 1 }), () => {}));
});

test('rpg-cm63.33 simultaneous downloads share one run', async () => {
  const requests: string[] = [];
  const host = createSoundHost({ dir, sounds: SOUNDS, fetch: serving(requests) });
  const { offer } = await host.status();
  await Promise.all([host.download(consentTo(offer), () => {}), host.download(consentTo(offer), () => {})]);
  assert.equal(requests.length, 1);
});

test('rpg-cm63.33 file reads a downloaded sound and nothing before the download', async () => {
  const host = createSoundHost({ dir, sounds: SOUNDS, fetch: serving() });
  assert.equal(await host.file('music', 'calm'), undefined);
  await host.download(consentTo((await host.status()).offer), () => {});
  assert.deepEqual(await host.file('music', 'calm'), new Uint8Array(CONTENT));
});

test('rpg-cm63.33 file only answers for sounds in the manifest', async () => {
  const host = createSoundHost({ dir, sounds: SOUNDS, fetch: serving() });
  for (const [kind, key] of [
    ['music', '../../etc/passwd'],
    ['music', 'combat'],
    ['ambience', 'calm'],
    ['../music', 'calm'],
    [undefined, 'calm'],
    ['music', 42],
    ['music', { toString: () => 'calm' }],
  ] as const)
    await assert.rejects(host.file(kind, key), RangeError);
});
