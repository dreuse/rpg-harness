import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Ready } from '../../../packages/client-protocol/src/wire.ts';
import { API_KEY_ENV, DAEMON_ENTRY, daemonEnv } from '../../cli/src/desktop-daemon.ts';
import { hermeticGmEnv } from '../../cli/src/gm-test-env.ts';
import { userDataDir } from '../../cli/src/setup-check.ts';
import { type FileSystem, type Launcher, launchDescriptor, PLATFORMS, type Platform, smokeTest } from './packaging.ts';

const HOME = { darwin: '/Users/ana', win32: 'C:\\Users\\ana', linux: '/home/ana' } as const;
const INSTALL = { darwin: '/Applications', win32: 'C:\\Program Files\\rpg', linux: '/opt/rpg' } as const;
const API_KEY = 'sk-test';
const BIN = join(import.meta.dirname, '..', '..', 'cli', 'src', 'bin.ts');
const DATA_DIR_ENV = 'RPG_DATA_DIR';
const CAMPAIGN = 'Ember';
const TEMP_PREFIX = 'rpg-ui11-';
const UTF8 = 'utf8';
const EXIT_OK = 0;
const PING_THEN_SHUTDOWN = '{"id":0,"type":"Ping"}\n{"id":1,"type":"Shutdown"}\n';

const fakeFs = (files: Record<string, string> = {}) => {
  const contents = new Map(Object.entries(files));
  const dirs = new Set<string>();
  const fs: FileSystem = {
    exists: (path) => contents.has(path) || dirs.has(path),
    mkdir: (path) => {
      dirs.add(path);
    },
  };
  return { fs, contents, dirs };
};

const fakeLauncher = () => {
  const launches: string[] = [];
  const launcher: Launcher = (executable) => {
    launches.push(executable);
    return true;
  };
  return { launcher, launches };
};

const installed = (platform: Platform) =>
  fakeFs({ [launchDescriptor(platform, INSTALL[platform]).executable]: 'binary' });

const snapshot = (dir: string) =>
  new Map(readdirSync(dir, { recursive: true, encoding: UTF8 }).map((file) => [file, readFileSync(join(dir, file))]));

test('UI11 produce and verify platform-specific installation/launch and local data directory handling', () => {
  const expectedData = {
    darwin: '/Users/ana/Library/Application Support/rpg',
    win32: 'C:\\Users\\ana\\AppData\\Roaming\\rpg',
    linux: '/home/ana/.local/share/rpg',
  };
  const expectedExecutable = {
    darwin: '/Applications/RPG Harness.app/Contents/MacOS/RPG Harness',
    win32: 'C:\\Program Files\\rpg\\RPG Harness.exe',
    linux: '/opt/rpg/rpg-harness',
  };
  for (const platform of PLATFORMS) {
    assert.equal(userDataDir({ platform, env: {}, homedir: HOME[platform] }), expectedData[platform]);
    assert.equal(launchDescriptor(platform, INSTALL[platform]).executable, expectedExecutable[platform]);
    const { fs, dirs } = installed(platform);
    const { launcher, launches } = fakeLauncher();
    const result = smokeTest({
      platform,
      env: { [API_KEY_ENV]: API_KEY },
      homedir: HOME[platform],
      installDir: INSTALL[platform],
      fs,
      launch: launcher,
    });
    assert.deepEqual(result, {
      platform,
      installed: true,
      launched: true,
      dataDir: expectedData[platform],
      gm: 'api',
    });
    assert.deepEqual(launches, [expectedExecutable[platform]]);
    assert.ok(dirs.has(expectedData[platform]));
  }
  assert.equal(userDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/xdg' }, homedir: HOME.linux }), '/xdg/rpg');
  assert.equal(
    userDataDir({ platform: 'win32', env: { APPDATA: 'D:\\AppData' }, homedir: HOME.win32 }),
    'D:\\AppData\\rpg',
  );
  assert.equal(
    userDataDir({ platform: 'darwin', env: { [DATA_DIR_ENV]: '/custom' }, homedir: HOME.darwin }),
    '/custom',
  );
});

test('UI11 smoke test reports a missing install and a missing provider without launching', () => {
  const { fs } = fakeFs();
  const { launcher, launches } = fakeLauncher();
  const result = smokeTest({
    platform: 'linux',
    env: {},
    homedir: HOME.linux,
    installDir: INSTALL.linux,
    fs,
    launch: launcher,
  });
  assert.equal(result.installed, false);
  assert.equal(result.launched, false);
  assert.equal(result.gm, 'fake');
  assert.deepEqual(launches, []);
});

test('UI11 missing model-provider configuration never results in data loss', () => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const env = { ...hermeticGmEnv(), [DATA_DIR_ENV]: dataDir };
    const rpg = (args: readonly string[]) => {
      const result = spawnSync(process.execPath, [BIN, ...args], { encoding: UTF8, env });
      assert.equal(result.status, EXIT_OK, result.stderr);
      return result.stdout;
    };
    rpg(['new', CAMPAIGN]);
    const before = snapshot(dataDir);
    assert.ok(before.size > 0);

    const daemon = spawnSync(process.execPath, [DAEMON_ENTRY], {
      input: PING_THEN_SHUTDOWN,
      encoding: UTF8,
      env: daemonEnv(env),
    });
    assert.equal(daemon.status, EXIT_OK, daemon.stderr);
    const [ready, ...replies] = daemon.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal((ready as Ready).gm, 'fake');
    assert.deepEqual(
      replies.map(({ type }) => type),
      ['Pong', 'Stopped'],
    );

    assert.deepEqual(snapshot(dataDir), before);
    assert.match(rpg(['list']), new RegExp(`^Campaigns: ${CAMPAIGN}$`, 'm'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
