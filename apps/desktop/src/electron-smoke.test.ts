import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { CAMPAIGN_ENV } from '../../cli/src/desktop-daemon.ts';
import { createEngineGateway } from '../../cli/src/engine-gateway.ts';
import { FAKE_ROUTE, GM_ROUTE_ENV } from '../../cli/src/gm-api.ts';
import { DATA_DIR_ENV } from '../../cli/src/setup-check.ts';
import {
  CAPTURE_ENV,
  CAPTURE_LAYOUTS,
  CAPTURE_STATUS,
  CAPTURE_THEMES,
  JOURNEY,
  JOURNEY_ENV,
  JOURNEY_ERROR,
  SHOT_DATA_EXTENSION,
} from './capture.ts';
import { SMOKE_ENV, SMOKE_STATUS, WINDOW_HEIGHT, WINDOW_WIDTH } from './main.ts';
import { auditPage, BLOCKING_IMPACTS, decodePng, pixelDiffRatio } from './ux-check.ts';

const APP_DIR = join(import.meta.dirname, '..');
const REPO_ROOT = join(APP_DIR, '..', '..');
const PACKED_SOURCES = ['apps/*/src/**', 'apps/*/package.json', 'packages/**'];
const PACKED_APP = 'app.asar';
const PACKAGE_FILE = 'package.json';
const PACKED_PACKAGE = { name: 'rpg-harness', type: 'module', main: 'apps/desktop/src/electron-main.ts' };
const NODE_MODULES = 'node_modules';
const PICKLE_WORD = 4;
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

const run = async (dataDir: string, extra: NodeJS.ProcessEnv, app = APP_DIR) => {
  const env = Object.fromEntries(KEPT_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
  const { stdout } = await promisify(execFile)(binary as string, [app], {
    env: { ...env, ...extra, [SMOKE_ENV]: ENABLED, [DATA_DIR_ENV]: dataDir, [GM_ROUTE_ENV]: FAKE_ROUTE },
    timeout: LAUNCH_TIMEOUT_MS,
  });
  return stdout;
};

const launch = async (extra: NodeJS.ProcessEnv = {}, seed = async (_dataDir: string) => {}, app = APP_DIR) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-smoke-'));
  try {
    await seed(dataDir);
    return await run(dataDir, extra, app);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

test('rpg-42a.7 Electron launches, loads the page, connects to the engine and quits', { skip }, async () => {
  assert.match(await launch(), new RegExp(`^${SMOKE_STATUS}Connected$`, 'm'));
});

type AsarDir = { files: Record<string, AsarDir | { size: number; offset: string }> };

const writeAsar = (target: string, entries: readonly (readonly [string, Buffer])[]) => {
  const root: AsarDir = { files: {} };
  let offset = 0;
  for (const [path, data] of entries) {
    const parts = path.split(sep);
    const name = parts.pop() as string;
    const dir = parts.reduce((node, part) => {
      node.files[part] ??= { files: {} };
      return node.files[part] as AsarDir;
    }, root);
    dir.files[name] = { size: data.length, offset: String(offset) };
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const header = Buffer.alloc(PICKLE_WORD * 2 + Math.ceil(json.length / PICKLE_WORD) * PICKLE_WORD);
  header.writeUInt32LE(header.length - PICKLE_WORD, 0);
  header.writeUInt32LE(json.length, PICKLE_WORD);
  json.copy(header, PICKLE_WORD * 2);
  const size = Buffer.alloc(PICKLE_WORD * 2);
  size.writeUInt32LE(PICKLE_WORD, 0);
  size.writeUInt32LE(header.length, PICKLE_WORD);
  writeFileSync(target, Buffer.concat([size, header, ...entries.map(([, data]) => data)]));
};

const packApp = (dir: string) => {
  const sources = globSync(PACKED_SOURCES, { cwd: REPO_ROOT, exclude: (path) => basename(path) === NODE_MODULES })
    .filter((path) => statSync(join(REPO_ROOT, path)).isFile())
    .map((path) => [path, readFileSync(join(REPO_ROOT, path))] as const);
  const target = join(dir, PACKED_APP);
  writeAsar(target, [[PACKAGE_FILE, Buffer.from(JSON.stringify(PACKED_PACKAGE))], ...sources]);
  return target;
};

test('rpg-42a.6 packaged asar starts the engine .ts entry through utilityProcess and connects', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-desktop-asar-'));
  try {
    assert.match(await launch({}, undefined, packApp(dir)), new RegExp(`^${SMOKE_STATUS}Connected$`, 'm'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SHOT_PREFIXES = ['home-', ''];

test('rpg-42a.11 Electron captures a screenshot of each desktop view in each theme', { skip }, async (t) => {
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-screens-'));
  const stdout = await launch({ [CAPTURE_ENV]: dir, [CAMPAIGN_ENV]: CAMPAIGN }, seedCampaign);
  for (const prefix of SHOT_PREFIXES)
    for (const theme of CAPTURE_THEMES)
      for (const layout of CAPTURE_LAYOUTS) {
        const file = join(dir, `${prefix}${layout.name}-${theme.name}.png`);
        assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
        assert.equal(readFileSync(file).subarray(0, SIGNATURE_BYTES).toString(HEX), PNG_SIGNATURE, file);
      }
  t.diagnostic(`screenshots in ${dir}`);
});

const BASELINE_DIR = join(APP_DIR, 'visual-baselines', process.platform);
const UPDATE_BASELINES_ENV = 'RPG_DESKTOP_UPDATE_BASELINES';
const MAX_DIFF_RATIO = 0.002;

const journeyShots = (dir: string, phase: keyof typeof JOURNEY) =>
  JOURNEY[phase].flatMap(({ shot }) =>
    shot === undefined ? [] : CAPTURE_THEMES.map((theme) => join(dir, `${shot}-${theme.name}.png`)),
  );

test('rpg-42a.17 desktop journey: first run, guided start, roll, sheet edit, quit, reopen and continue', {
  skip,
}, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-journey-'));
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-journey-screens-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const files: string[] = [];
  for (const phase of ['first', 'reopen'] as const) {
    const stdout = await run(dataDir, { [CAPTURE_ENV]: dir, [JOURNEY_ENV]: phase });
    assert.doesNotMatch(stdout, new RegExp(JOURNEY_ERROR));
    for (const file of journeyShots(dir, phase)) {
      assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
      files.push(file);
    }
  }
  t.diagnostic(`screenshots in ${dir}`);
  const update = process.env[UPDATE_BASELINES_ENV] === ENABLED;
  if (update) mkdirSync(BASELINE_DIR, { recursive: true });
  const compare = !update && existsSync(BASELINE_DIR);
  if (!compare && !update) t.diagnostic(`no visual baselines for ${process.platform}; comparison skipped`);
  for (const file of files) {
    const { size, audit, masks } = JSON.parse(readFileSync(file.replace(/\.png$/, SHOT_DATA_EXTENSION), 'utf8'));
    assert.deepEqual(
      size,
      { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
      `${basename(file)} was not captured at scale 1`,
    );
    const blocking = auditPage(audit).filter(({ impact }) => BLOCKING_IMPACTS.includes(impact));
    assert.deepEqual(blocking, [], basename(file));
    const baseline = join(BASELINE_DIR, basename(file));
    if (update) copyFileSync(file, baseline);
    if (!compare) continue;
    const expected = decodePng(readFileSync(baseline));
    const sizeOf = ({ width, height }: { width: number; height: number }) => `${width}x${height}`;
    assert.equal(sizeOf(size), sizeOf(expected), `${basename(file)} size differs from its baseline`);
    const ratio = pixelDiffRatio(expected, decodePng(readFileSync(file)), masks);
    assert.ok(
      ratio <= MAX_DIFF_RATIO,
      `${basename(file)} differs from its baseline in ${(ratio * 100).toFixed(2)}% of pixels`,
    );
  }
});
