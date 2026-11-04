import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { DATA_DIR_ENV } from '../../cli/src/setup-check.ts';
import { SMOKE_ENV, SMOKE_STATUS } from './main.ts';

const APP_DIR = join(import.meta.dirname, '..');
const PATH_FILE = 'path.txt';
const LAUNCH_TIMEOUT_MS = 60000;
const ENABLED = '1';
const LINUX = 'linux';
const DISPLAY_ENV = 'DISPLAY';
const KEPT_ENV = ['PATH', 'HOME', 'TMPDIR', DISPLAY_ENV];

const electronBinary = () => {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
    const binary = join(dir, 'dist', readFileSync(join(dir, PATH_FILE), 'utf8'));
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
};

const binary = electronBinary();
const skip =
  binary === undefined
    ? 'Electron binary is not installed (run pnpm install with network access)'
    : process.platform === LINUX && !process.env[DISPLAY_ENV]
      ? 'no display for Electron (run under xvfb-run)'
      : false;

test('rpg-42a.7 Electron launches, loads the page, connects to the engine and quits', { skip }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-smoke-'));
  try {
    const env = Object.fromEntries(KEPT_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
    const { stdout } = await promisify(execFile)(binary as string, [APP_DIR], {
      env: { ...env, [SMOKE_ENV]: ENABLED, [DATA_DIR_ENV]: dataDir },
      timeout: LAUNCH_TIMEOUT_MS,
    });
    assert.match(stdout, new RegExp(`${SMOKE_STATUS}Connected to engine \\d+ \\(fake GM\\)`));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
