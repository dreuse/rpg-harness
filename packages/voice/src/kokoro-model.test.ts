import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createKokoroModelManager,
  KOKORO_MODEL_FILES,
  KOKORO_MODEL_ID,
  KOKORO_MODEL_OFFER,
  type ModelFile,
} from './kokoro-model.ts';

const SOURCE = 'https://models.example/kokoro';
const CONTENT = new TextEncoder().encode('weights');
const OTHER = new TextEncoder().encode('tampered');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const FILES: readonly ModelFile[] = [
  { path: 'config.json', sha256: sha256(CONTENT), bytes: CONTENT.length },
  { path: 'onnx/model.onnx', sha256: sha256(CONTENT), bytes: CONTENT.length },
];
const TOTAL_BYTES = CONTENT.length * FILES.length;
const NOT_FOUND = 404;
const EXPECTED_MIB = 310;
const dirs: string[] = [];

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'kokoro-model-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fakeFetch = (body: Uint8Array = CONTENT, status = 200) => {
  const urls: string[] = [];
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    urls.push(String(url));
    return new Response(status === 200 ? Buffer.from(body) : null, { status });
  };
  return { urls, fetch: fetch as typeof globalThis.fetch };
};

const setup = async (body?: Uint8Array, status?: number) => {
  const dir = await tempDir();
  const network = fakeFetch(body, status);
  const manager = createKokoroModelManager({ dir, fetch: network.fetch, files: FILES, source: SOURCE });
  return { dir, network, manager, consent: { accepted: true as const, ...manager.offer } };
};

test('offers the pinned Kokoro model with its size and source before any download', () => {
  assert.equal(KOKORO_MODEL_OFFER.sizeMiB, EXPECTED_MIB);
  assert.equal(
    KOKORO_MODEL_OFFER.bytes,
    KOKORO_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0),
  );
  assert.match(KOKORO_MODEL_OFFER.source, /^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\//);
  assert.ok(KOKORO_MODEL_FILES.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
});

test('refuses to download without explicit consent to the offered size and source', async () => {
  const { dir, network, manager, consent } = await setup();
  const refusals = [
    undefined,
    { ...consent, accepted: false },
    { ...consent, bytes: consent.bytes + 1 },
    { ...consent, source: 'https://elsewhere.example' },
  ];
  for (const refusal of refusals) {
    await assert.rejects(manager.download(refusal as never), /consent/);
  }
  assert.deepEqual(network.urls, []);
  assert.deepEqual(await readdir(dir), []);
});

test('downloads into the app data dir after consent and verifies checksums', async () => {
  const { dir, network, manager, consent } = await setup();
  assert.deepEqual(await manager.status(), { installed: false, bytes: 0 });
  await manager.download(consent);
  assert.deepEqual(network.urls, [`${SOURCE}/config.json`, `${SOURCE}/onnx/model.onnx`]);
  assert.deepEqual(await readFile(join(dir, KOKORO_MODEL_ID, 'onnx/model.onnx')), Buffer.from(CONTENT));
  assert.deepEqual(await manager.status(), { installed: true, bytes: TOTAL_BYTES });
});

test('rpg-cm63.7 reports download progress as total bytes received so far', async () => {
  const { manager, consent } = await setup();
  const progress: number[] = [];
  await manager.download(consent, undefined, (bytes) => progress.push(bytes));
  assert.deepEqual(progress, [CONTENT.length, TOTAL_BYTES]);
});

test('rejects a checksum mismatch and deletes the download', async () => {
  const { dir, manager, consent } = await setup(OTHER);
  await assert.rejects(manager.download(consent), /checksum mismatch/);
  assert.deepEqual(await readdir(join(dir, KOKORO_MODEL_ID)), []);
  assert.deepEqual(await manager.status(), { installed: false, bytes: 0 });
});

test('rejects a failed HTTP response without leaving a partial file', async () => {
  const { dir, manager, consent } = await setup(CONTENT, NOT_FOUND);
  await assert.rejects(manager.download(consent), /HTTP 404/);
  assert.deepEqual(await readdir(join(dir, KOKORO_MODEL_ID)), []);
});

test('remove deletes the installed model', async () => {
  const { dir, manager, consent } = await setup();
  await manager.download(consent);
  await manager.remove();
  await assert.rejects(readdir(join(dir, KOKORO_MODEL_ID)), { code: 'ENOENT' });
  assert.deepEqual(await manager.status(), { installed: false, bytes: 0 });
});
