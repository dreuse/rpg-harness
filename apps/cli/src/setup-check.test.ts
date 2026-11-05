import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hermeticGmEnv } from './gm-test-env.ts';
import { setupProblem } from './setup-check.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const MANIFEST = join(import.meta.dirname, '..', 'package.json');
const ROOT = join(import.meta.dirname, '..', '..', '..');
const INSTALL_DOC_LINES = ['pnpm install', 'pnpm rpg', 'RPG_DATA_DIR='];
const CAMPAIGN = 'Ember';
const ACTION = 'I open the door.';
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const READ_ONLY = 0o555;
const WRITABLE = 0o755;
const SUPPORTED_NODE = 'v24.0.0';
const OLD_NODE = 'v22.12.0';
const STACK_FRAME = /^\s+at /m;
const NESTED_DIR = join('fresh', 'nested', 'data');

const withTempDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-setup-'));
  try {
    run(dir);
  } finally {
    chmodSync(dir, WRITABLE);
    rmSync(dir, { recursive: true, force: true });
  }
};

const rpg = (dataDir: string, args: readonly string[], input = '') =>
  spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    env: { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir },
  });

const assertCleanError = (result: ReturnType<typeof rpg>, expected: string) => {
  assert.equal(result.status, EXIT_FAILURE);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.ok(result.stderr.includes(expected), result.stderr);
  assert.doesNotMatch(result.stderr, STACK_FRAME);
};

test('U08: provide single-command play, install docs, first-run checks and clean error messages', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { bin: { rpg: string } };
  assert.equal(join(import.meta.dirname, '..', manifest.bin.rpg), BIN);
  assert.match(readFileSync(BIN, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const line of INSTALL_DOC_LINES) assert.ok(readme.includes(line), line);

  assert.equal(setupProblem({ nodeVersion: SUPPORTED_NODE, hasSqlite: true }), undefined);
  assert.match(setupProblem({ nodeVersion: OLD_NODE, hasSqlite: true }) ?? '', /Node\.js 24 or newer.*v22\.12\.0/);
  assert.match(setupProblem({ nodeVersion: SUPPORTED_NODE, hasSqlite: false }) ?? '', /node:sqlite/);

  withTempDir((dir) => {
    const created = rpg(dir, ['new', CAMPAIGN]);
    assert.equal(created.status, EXIT_OK, created.stderr);
    const played = rpg(dir, ['play', CAMPAIGN], `${ACTION}\n`);
    assert.equal(played.status, EXIT_OK, played.stderr);
    assert.ok(played.stdout.includes(ACTION));

    assertCleanError(rpg(dir, ['play', 'Missing']), 'Missing');
  });
});

test('U08: system works without background services or user-managed sqlite setup', () => {
  withTempDir((dir) => {
    const dataDir = join(dir, NESTED_DIR);
    const launched = rpg(dataDir, []);
    assert.equal(launched.status, EXIT_OK, launched.stderr);
    assert.equal(launched.stderr, '');
    assert.ok(existsSync(dataDir));
    const created = rpg(dataDir, ['new', CAMPAIGN]);
    assert.equal(created.status, EXIT_OK, created.stderr);
    assert.ok(existsSync(join(dataDir, `${CAMPAIGN}.sqlite`)));
  });

  withTempDir((dir) => {
    chmodSync(dir, READ_ONLY);
    assertCleanError(rpg(join(dir, NESTED_DIR), ['new', CAMPAIGN]), 'RPG_DATA_DIR');
  });

  withTempDir((dir) => {
    const file = join(dir, 'not-a-folder');
    writeFileSync(file, '');
    assertCleanError(rpg(file, ['list']), 'RPG_DATA_DIR');
  });
});
