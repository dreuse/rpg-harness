import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  createSigningKeys,
  RELEASES_PATH,
  type ReleaseServer,
  startReleaseServer,
} from '../../testkit/src/release-server.ts';
import { type CheckOptions, checkForUpdate, DEFAULT_RELEASES_URL } from './release.ts';

const CURRENT = '1.2.0';
const NOTES = 'Faster saves.';
const ASSET = 'rpg-cli-1.3.0.json';
const RATE_LIMITED = [403, 429];
const SERVER_ERROR = 500;
const CLOSED_PORT_URL = 'http://127.0.0.1:9/releases';

let server: ReleaseServer;

beforeEach(async () => {
  server = await startReleaseServer(createSigningKeys());
});

const options = (overrides: Partial<CheckOptions> = {}): CheckOptions => ({
  fetch,
  releasesUrl: server.releasesUrl,
  currentVersion: CURRENT,
  channel: 'stable',
  ...overrides,
});

afterEach(() => server.close());

test('detects a newer stable release with its notes and assets', async () => {
  server.publish({ version: '1.1.0', files: {} });
  server.publish({ version: '1.3.0', files: { [ASSET]: 'bundle' }, notes: NOTES });
  const result = await checkForUpdate(options());
  assert.equal(result.status, 'available');
  assert.ok(result.status === 'available');
  assert.equal(result.release.version, '1.3.0');
  assert.equal(result.release.notes, NOTES);
  assert.ok(result.release.assets.some(({ name }) => name === ASSET));
});

test('ignores the same version, older versions and drafts', async () => {
  server.publish({ version: CURRENT, files: {} });
  server.publish({ version: '1.0.0', files: {} });
  server.publish({ version: '9.0.0', files: {}, draft: true });
  assert.deepEqual(await checkForUpdate(options()), { status: 'current', version: CURRENT });
});

test('offers pre-releases only on the pre-release channel', async () => {
  server.publish({ version: '1.3.0-beta.1', files: {} });
  server.publish({ version: '1.4.0', files: {}, prerelease: true });
  assert.equal((await checkForUpdate(options())).status, 'current');
  const result = await checkForUpdate(options({ channel: 'pre-release' }));
  assert.ok(result.status === 'available');
  assert.equal(result.release.version, '1.4.0');
});

test('reports offline quietly', async () => {
  assert.deepEqual(await checkForUpdate(options({ releasesUrl: CLOSED_PORT_URL })), { status: 'offline' });
});

test('reports rate limits quietly', async () => {
  for (const status of RATE_LIMITED) {
    server.serve(RELEASES_PATH, { status, body: '{}' });
    assert.deepEqual(await checkForUpdate(options()), { status: 'rate-limited' });
  }
});

test('reports a server error or an unreadable answer as unavailable', async () => {
  server.serve(RELEASES_PATH, { status: SERVER_ERROR });
  assert.deepEqual(await checkForUpdate(options()), { status: 'unavailable' });
  server.serve(RELEASES_PATH, { body: 'not json' });
  assert.deepEqual(await checkForUpdate(options()), { status: 'unavailable' });
  server.serve(RELEASES_PATH, { body: JSON.stringify([{ tag_name: 'v2.0.0', assets: 'none' }, 'junk']) });
  assert.equal((await checkForUpdate(options())).status, 'current');
});

test('defaults to the GitHub releases API', () => {
  assert.match(DEFAULT_RELEASES_URL, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases$/);
});
