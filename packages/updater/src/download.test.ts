import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CHECKSUMS_NAME,
  checksumsFor,
  createSigningKeys,
  SIGNATURE_NAME,
  type SigningKeys,
  signatureFor,
  startReleaseServer,
} from '../../testkit/src/release-server.ts';
import { downloadVerified } from './download.ts';
import { checkForUpdate } from './release.ts';

const VERSION = '1.3.0';
const ASSET = 'rpg-cli-1.3.0.json';
const BUILD = 'new build bytes';
const CLOSED_PORT_URL = 'http://127.0.0.1:9';
const HALF = 4;
const RSA_BITS = 2048;
const OVERSIZED_BYTES = 128 * 1024;

const setup = async (t: { after: (fn: () => unknown) => void }, keys: SigningKeys = createSigningKeys()) => {
  const server = await startReleaseServer(keys);
  const dir = mkdtempSync(join(tmpdir(), 'rpg-updater-'));
  t.after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  server.publish({ version: VERSION, files: { [ASSET]: BUILD } });
  const download = async (publicKey = keys.publicKey) => {
    const result = await checkForUpdate({
      fetch,
      releasesUrl: server.releasesUrl,
      currentVersion: '1.0.0',
      channel: 'stable',
    });
    assert.ok(result.status === 'available');
    return downloadVerified({ fetch, release: result.release, assetName: ASSET, publicKey, dir });
  };
  return { server, dir, keys, download };
};

test('downloads a build whose checksum and signature match', async (t) => {
  const { dir, download } = await setup(t);
  const result = await download();
  assert.deepEqual(result, { status: 'verified', file: join(dir, ASSET) });
  assert.equal(readFileSync(join(dir, ASSET), 'utf8'), BUILD);
  assert.deepEqual(readdirSync(dir), [ASSET]);
});

test('rejects a build whose checksum does not match and deletes it', async (t) => {
  const { server, dir, download } = await setup(t);
  server.serve(server.assetPath(VERSION, ASSET), { body: 'tampered bytes!' });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'checksum does not match' });
  assert.deepEqual(readdirSync(dir), []);
});

test('rejects checksums signed by another key', async (t) => {
  const { server, dir, download } = await setup(t);
  const checksums = checksumsFor({ [ASSET]: BUILD });
  server.serve(server.assetPath(VERSION, SIGNATURE_NAME), {
    body: signatureFor(checksums, createSigningKeys().privateKey),
  });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'signature does not match' });
  assert.deepEqual(readdirSync(dir), []);
});

test('rejects checksums changed after signing', async (t) => {
  const { server, download } = await setup(t);
  server.serve(server.assetPath(VERSION, CHECKSUMS_NAME), { body: checksumsFor({ [ASSET]: 'other' }) });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'signature does not match' });
});

test('rejects an app without a pinned release key', async (t) => {
  const { download } = await setup(t);
  assert.deepEqual(await download('not a key'), { status: 'rejected', reason: 'signature does not match' });
});

test('rejects checksums signed with a key that is not Ed25519', async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: RSA_BITS });
  const { download } = await setup(t, {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'signature does not match' });
});

test('stops reading a signed file that is larger than its published size', async (t) => {
  const { server, dir, download } = await setup(t);
  server.serve(server.assetPath(VERSION, CHECKSUMS_NAME), { body: 'x'.repeat(OVERSIZED_BYTES) });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'download is incomplete' });
  assert.deepEqual(readdirSync(dir), []);
});

test('rejects a partial download and deletes it', async (t) => {
  const { server, dir, download } = await setup(t);
  server.serve(server.assetPath(VERSION, ASSET), { body: BUILD, truncateAt: HALF });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'download is incomplete' });
  assert.deepEqual(readdirSync(dir), []);
});

test('rejects a body shorter than the published size and deletes it', async (t) => {
  const { server, dir, download } = await setup(t);
  server.serve(server.assetPath(VERSION, ASSET), { body: BUILD.slice(0, HALF) });
  assert.deepEqual(await download(), { status: 'rejected', reason: 'download is incomplete' });
  assert.deepEqual(readdirSync(dir), []);
});

test('rejects a release without a build for this system', async (t) => {
  const { dir } = await setup(t);
  const release = { version: VERSION, notes: '', assets: [] };
  const result = await downloadVerified({ fetch, release, assetName: ASSET, publicKey: '', dir });
  assert.deepEqual(result, { status: 'rejected', reason: 'the release has no signed build for this system' });
});

test('reports offline and rate limits quietly while downloading', async (t) => {
  const { server, dir, keys, download } = await setup(t);
  const asset = (name: string) => ({ name, size: 1, url: `${CLOSED_PORT_URL}/${name}` });
  const release = { version: VERSION, notes: '', assets: [ASSET, CHECKSUMS_NAME, SIGNATURE_NAME].map(asset) };
  const offline = await downloadVerified({ fetch, release, assetName: ASSET, publicKey: keys.publicKey, dir });
  assert.deepEqual(offline, { status: 'offline' });
  server.serve(server.assetPath(VERSION, CHECKSUMS_NAME), { status: 403 });
  assert.deepEqual(await download(), { status: 'rate-limited' });
  assert.deepEqual(readdirSync(dir), []);
});
