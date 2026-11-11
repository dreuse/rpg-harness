import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const INSTALLER = join(import.meta.dirname, '..', 'install.sh');
const PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const PACKAGE = `RPG Harness-${PLATFORM}-${ARCH}`;
const LAYOUT =
  PLATFORM === 'darwin'
    ? { binary: 'RPG Harness.app/Contents/MacOS/RPG Harness', app: 'RPG Harness.app/Contents/Resources/app' }
    : { binary: 'rpg-harness', app: 'resources/app' };
const FAKE_BINARY = '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE $*"\n';

const fakeRelease = (root: string) => {
  const binary = join(root, 'build', PACKAGE, LAYOUT.binary);
  mkdirSync(join(binary, '..'), { recursive: true });
  writeFileSync(binary, FAKE_BINARY);
  chmodSync(binary, 0o755);
  mkdirSync(join(root, 'release'));
  execFileSync('tar', [
    '-czf',
    join(root, 'release', `rpg-harness-${PLATFORM}-${ARCH}.tar.gz`),
    '-C',
    join(root, 'build'),
    PACKAGE,
  ]);
  return `file://${join(root, 'release')}`;
};

test('rpg-42a.168 install.sh installs, updates and uninstalls the rpg command', () => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-install-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, RPG_RELEASE_URL: fakeRelease(root) };
  const installer = (...args: string[]) => execFileSync('sh', [INSTALLER, ...args], { env, encoding: 'utf8' });
  const launcher = join(home, '.local/bin/rpg');
  const installDir = join(home, '.local/share/rpg-harness');
  const bin = join(installDir, LAYOUT.app, 'apps/cli/src/bin.ts');

  installer();
  assert.equal(execFileSync(launcher, ['tui', 'My game'], { encoding: 'utf8' }), `1 ${bin} tui My game\n`);
  installer();
  assert.equal(execFileSync(launcher, ['list'], { encoding: 'utf8' }), `1 ${bin} list\n`);
  installer('--uninstall');
  assert.equal(existsSync(launcher), false);
  assert.equal(existsSync(installDir), false);
});

test('rpg-42a.168 install.sh keeps the current install when the download fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-install-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const good = { ...process.env, HOME: home, RPG_RELEASE_URL: fakeRelease(root) };
  execFileSync('sh', [INSTALLER], { env: good });
  const broken = { ...good, RPG_RELEASE_URL: `file://${join(root, 'missing')}` };
  assert.throws(() => execFileSync('sh', [INSTALLER], { env: broken, stdio: 'ignore' }));
  assert.equal(existsSync(join(home, '.local/share/rpg-harness', LAYOUT.binary)), true);
});
