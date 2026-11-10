import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inheritedEnv } from './local-service-engine.ts';

const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const HOME = '/Users/ana';

test('rpg-cm63.75 a Finder PATH gains the standard uv directories on macOS', () => {
  const { PATH } = inheritedEnv({ PATH: FINDER_PATH, HOME }, 'darwin');
  assert.equal(PATH, `${FINDER_PATH}:${HOME}/.local/bin:${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin`);
});

test('rpg-cm63.75 Linux gets only the home directories and existing entries are not repeated', () => {
  const { PATH } = inheritedEnv({ PATH: `/usr/bin:${HOME}/.cargo/bin`, HOME }, 'linux');
  assert.equal(PATH, `/usr/bin:${HOME}/.cargo/bin:${HOME}/.local/bin`);
});

test('rpg-cm63.75 execFile finds uv through the child env PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-uv-path-'));
  try {
    const uv = join(dir, 'uv');
    writeFileSync(uv, '#!/bin/sh\necho found\n');
    chmodSync(uv, 0o755);
    const output = execFileSync('uv', [], { env: { PATH: `${FINDER_PATH}:${dir}` } });
    assert.equal(output.toString().trim(), 'found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpg-cm63.75 Windows PATH keeps its drive letters and joins with a semicolon', () => {
  const home = 'C:\\Users\\ana';
  const { PATH } = inheritedEnv({ PATH: 'C:\\Windows;C:\\Tools', HOME: home }, 'win32');
  assert.equal(PATH, `C:\\Windows;C:\\Tools;${home}/.local/bin;${home}/.cargo/bin`);
});
