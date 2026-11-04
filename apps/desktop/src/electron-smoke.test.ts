import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CAMPAIGN_ENV } from '../../cli/src/desktop-daemon.ts';
import { createEngineGateway } from '../../cli/src/engine-gateway.ts';
import { DATA_DIR_ENV } from '../../cli/src/setup-check.ts';
import { CAPTURE_ENV, CAPTURE_LAYOUTS, CAPTURE_STATUS, CAPTURE_THEMES } from './capture.ts';
import { SMOKE_ENV, SMOKE_STATUS } from './main.ts';

const APP_DIR = join(import.meta.dirname, '..');
const PATH_FILE = 'path.txt';
const LAUNCH_TIMEOUT_MS = 60000;
const ENABLED = '1';
const LINUX = 'linux';
const DISPLAY_ENV = 'DISPLAY';
const KEPT_ENV = ['PATH', 'HOME', 'TMPDIR', DISPLAY_ENV];
const PNG_SIGNATURE = '89504e47';
const SIGNATURE_BYTES = 4;
const HEX = 'hex';
const CAMPAIGN = 'Ember';
const SEED_ACTION = 'I look around the docks.';
const NO_CHARACTER = async () => undefined;
const IGNORE = () => {};
const each = async function* <T>(items: readonly T[]) {
  yield* items;
};

const seedCampaign = async (dataDir: string) => {
  const gateway = createEngineGateway(dataDir);
  for await (const _ of gateway.create(CAMPAIGN, undefined, NO_CHARACTER));
  for await (const _ of gateway.open(CAMPAIGN, 'play', each([SEED_ACTION]), IGNORE));
};

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

const launch = async (extra: NodeJS.ProcessEnv = {}, seed = async (_dataDir: string) => {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-smoke-'));
  try {
    await seed(dataDir);
    const env = Object.fromEntries(KEPT_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
    const { stdout } = await promisify(execFile)(binary as string, [APP_DIR], {
      env: { ...env, ...extra, [SMOKE_ENV]: ENABLED, [DATA_DIR_ENV]: dataDir },
      timeout: LAUNCH_TIMEOUT_MS,
    });
    return stdout;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

test('rpg-42a.7 Electron launches, loads the page, connects to the engine and quits', { skip }, async () => {
  assert.match(await launch(), new RegExp(`${SMOKE_STATUS}Connected to engine \\d+ \\(fake GM\\)`));
});

test('rpg-42a.11 Electron captures a screenshot of each desktop view in each theme', { skip }, async (t) => {
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-screens-'));
  const stdout = await launch({ [CAPTURE_ENV]: dir, [CAMPAIGN_ENV]: CAMPAIGN }, seedCampaign);
  for (const theme of CAPTURE_THEMES)
    for (const layout of CAPTURE_LAYOUTS) {
      const file = join(dir, `${layout.name}-${theme.name}.png`);
      assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
      assert.equal(readFileSync(file).subarray(0, SIGNATURE_BYTES).toString(HEX), PNG_SIGNATURE, file);
    }
  t.diagnostic(`screenshots in ${dir}`);
});
