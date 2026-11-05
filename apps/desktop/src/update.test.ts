import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSigningKeys, startReleaseServer } from '../../../packages/testkit/src/release-server.ts';
import { readState, UPDATE_STATE_FILE, UPDATES_DIR } from '../../../packages/updater/src/schedule.ts';
import { type DesktopUpdateOptions, desktopAssetName, offerDesktopUpdate, type UpdateChoice } from './update.ts';

const CURRENT = '1.2.0';
const NEXT = '1.3.0';
const NOTES = 'New map screen.';
const BUILD = 'desktop installer bytes';
const NOW = Date.parse('2026-11-04T10:00:00Z');
const ASSET = desktopAssetName(NEXT, 'darwin', 'arm64');

const setup = async (t: { after: (fn: () => unknown) => void }, choice: UpdateChoice) => {
  const keys = createSigningKeys();
  const server = await startReleaseServer(keys);
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-update-'));
  t.after(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  server.publish({ version: NEXT, notes: NOTES, files: { [ASSET]: BUILD } });
  const asked: string[] = [];
  const opened: string[] = [];
  const events: string[] = [];
  const options: DesktopUpdateOptions = {
    dataDir,
    version: CURRENT,
    platform: 'darwin',
    arch: 'arm64',
    releasesUrl: server.releasesUrl,
    publicKey: keys.publicKey,
    fetch,
    now: () => NOW,
    ask: async (release) => {
      asked.push(`${release.version}: ${release.notes}`);
      return choice;
    },
    open: async (file) => {
      events.push('open');
      opened.push(file);
    },
    backup: () => events.push('backup'),
  };
  return { server, dataDir, options, asked, opened, events };
};

test('names a build per platform and architecture', () => {
  assert.equal(desktopAssetName(NEXT, 'darwin', 'arm64'), 'rpg-desktop-1.3.0-darwin-arm64.dmg');
  assert.equal(desktopAssetName(NEXT, 'win32', 'x64'), 'rpg-desktop-1.3.0-win32-x64.exe');
  assert.equal(desktopAssetName(NEXT, 'linux', 'x64'), 'rpg-desktop-1.3.0-linux-x64.AppImage');
});

test('shows the version and notes, backs up, then opens the verified build for the player', async (t) => {
  const { options, asked, opened, events, dataDir } = await setup(t, 'download');
  assert.deepEqual(await offerDesktopUpdate(options), { status: 'verified', file: join(dataDir, UPDATES_DIR, ASSET) });
  assert.deepEqual(asked, [`${NEXT}: ${NOTES}`]);
  assert.deepEqual(events, ['backup', 'open']);
  assert.equal(readFileSync(opened[0] ?? '', 'utf8'), BUILD);
});

test('downloads nothing until the player clicks', async (t) => {
  const { options, opened, events, server } = await setup(t, 'later');
  assert.deepEqual(await offerDesktopUpdate(options), { status: 'later' });
  assert.deepEqual(opened, []);
  assert.deepEqual(events, []);
  assert.equal(server.requests.length, 1);
});

test('stop checking turns auto-check off and then makes no network call', async (t) => {
  const { options, server, dataDir } = await setup(t, 'never');
  assert.deepEqual(await offerDesktopUpdate(options), { status: 'never' });
  assert.equal(readState(join(dataDir, UPDATE_STATE_FILE)).autoCheck, false);
  const requests = server.requests.length;
  assert.deepEqual(await offerDesktopUpdate({ ...options, now: () => NOW * 2 }), { status: 'none' });
  assert.equal(server.requests.length, requests);
});

test('a tampered build is rejected, deleted and never opened', async (t) => {
  const { options, opened, server, dataDir } = await setup(t, 'download');
  server.serve(server.assetPath(NEXT, ASSET), { body: BUILD.toUpperCase() });
  assert.deepEqual(await offerDesktopUpdate(options), { status: 'rejected', reason: 'checksum does not match' });
  assert.deepEqual(opened, []);
  assert.deepEqual(readdirSync(join(dataDir, UPDATES_DIR)), []);
});

test('offline is quiet and asks nothing', async (t) => {
  const { options, asked } = await setup(t, 'download');
  assert.deepEqual(await offerDesktopUpdate({ ...options, releasesUrl: 'http://127.0.0.1:9/releases' }), {
    status: 'none',
  });
  assert.deepEqual(asked, []);
  assert.equal(existsSync(join(options.dataDir, UPDATES_DIR)), false);
});
