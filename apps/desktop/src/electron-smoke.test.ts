import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
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
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_LOCALE, LANGUAGE_ENV } from '../../../packages/client-protocol/src/locale.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { CAMPAIGN_ENV } from '../../cli/src/desktop-daemon.ts';
import {
  createCampaignFrom,
  createEngineGateway,
  FAKE_GAME_MASTER,
  type GameMaster,
  openClientSession,
} from '../../cli/src/engine-gateway.ts';
import { CLAUDE_BIN_ENV, CLAUDE_CODE_ROUTE, FAKE_ROUTE, GM_ROUTE_ENV } from '../../cli/src/gm-api.ts';
import type { GmProposal } from '../../cli/src/gm-proposals.ts';
import { DATA_DIR_ENV } from '../../cli/src/setup-check.ts';
import {
  CAPTURE_ENV,
  CAPTURE_LAYOUTS,
  CAPTURE_STATUS,
  CAPTURE_THEMES,
  JOURNEY,
  JOURNEY_ENV,
  JOURNEY_ERROR,
  journeyLayouts,
  journeyShotName,
  SHOT_DATA_EXTENSION,
} from './capture.ts';
import { SMOKE_ENV, SMOKE_STATUS, WINDOW_HEIGHT, WINDOW_WIDTH } from './main.ts';
import { smokeSkip } from './smoke-skip.ts';
import { auditPage, BLOCKING_IMPACTS, decodePng, pixelDiffRatio } from './ux-check.ts';
import { FAKE_VOICE_ROUTE, VOICE_ROUTE_ENV } from './voice-host.ts';

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
const DISPLAY_ENV = 'DISPLAY';
const KEPT_ENV = ['PATH', 'HOME', 'TMPDIR', DISPLAY_ENV];
const PNG_SIGNATURE = '89504e47';
const SIGNATURE_BYTES = 4;
const HEX = 'hex';
const CAMPAIGN = 'Ember';
const PORTUGUESE = 'pt-BR';
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
const { skip, failure: missingBinaryFailure } = smokeSkip({
  binary,
  platform: process.platform,
  display: process.env[DISPLAY_ENV],
  env: process.env,
});

if (missingBinaryFailure) {
  test('rpg-42a.119 Electron binary is installed for the desktop smoke', () => {
    assert.fail(missingBinaryFailure);
  });
}

const FORCE_SRGB = '--force-color-profile=srgb';
const FORCE_SCALE_1 = '--force-device-scale-factor=1';

const run = async (dataDir: string, extra: NodeJS.ProcessEnv, app = APP_DIR) => {
  const env = Object.fromEntries(KEPT_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])));
  const { stdout } = await promisify(execFile)(binary as string, [FORCE_SRGB, FORCE_SCALE_1, app], {
    env: {
      ...env,
      [LANGUAGE_ENV]: DEFAULT_LOCALE,
      ...extra,
      [SMOKE_ENV]: ENABLED,
      [DATA_DIR_ENV]: dataDir,
      [GM_ROUTE_ENV]: extra[GM_ROUTE_ENV] ?? FAKE_ROUTE,
      [VOICE_ROUTE_ENV]: FAKE_VOICE_ROUTE,
    },
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
  JOURNEY[phase].flatMap((step) =>
    step.shot === undefined
      ? []
      : CAPTURE_THEMES.flatMap((theme) =>
          journeyLayouts(step).map(({ name }) =>
            join(dir, `${journeyShotName(step.shot ?? '', name, theme.name)}.png`),
          ),
        ),
  );
const widthOf = (file: string) =>
  CAPTURE_LAYOUTS.find(({ name }) => basename(file).includes(`-${name}-`))?.width ?? WINDOW_WIDTH;

type Phase = keyof typeof JOURNEY;

const captureJourneys = async (
  t: TestContext,
  phases: readonly Phase[],
  extra: NodeJS.ProcessEnv = {},
): Promise<string[]> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-journey-'));
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-journey-screens-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const files: string[] = [];
  for (const phase of phases) {
    const stdout = await run(dataDir, { ...extra, [CAPTURE_ENV]: dir, [JOURNEY_ENV]: phase });
    assert.doesNotMatch(stdout, new RegExp(JOURNEY_ERROR));
    for (const file of journeyShots(dir, phase)) {
      assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
      files.push(file);
    }
  }
  t.diagnostic(`screenshots in ${dir}`);
  return files;
};

const checkBaselines = (t: TestContext, files: readonly string[]) => {
  const update = process.env[UPDATE_BASELINES_ENV] === ENABLED;
  if (update) mkdirSync(BASELINE_DIR, { recursive: true });
  const compare = !update && existsSync(BASELINE_DIR);
  if (!compare && !update) t.diagnostic(`no visual baselines for ${process.platform}; comparison skipped`);
  for (const file of files) {
    const { size, audit, masks } = JSON.parse(readFileSync(file.replace(/\.png$/, SHOT_DATA_EXTENSION), 'utf8'));
    assert.deepEqual(
      size,
      { width: widthOf(file), height: WINDOW_HEIGHT },
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
};

test('rpg-42a.17 desktop journey: first run, guided start, roll, sheet edit, quit, reopen and continue', {
  skip,
}, async (t) => {
  checkBaselines(t, await captureJourneys(t, ['first', 'reopen']));
});

test('rpg-42a.39 desktop journey in Brazilian Portuguese: home, guided start and play', { skip }, async (t) => {
  const files = await captureJourneys(t, ['portuguese'], { [LANGUAGE_ENV]: PORTUGUESE });
  checkBaselines(t, files);
  const { audit } = JSON.parse(readFileSync(files[0]?.replace(/\.png$/, SHOT_DATA_EXTENSION) ?? '', 'utf8'));
  assert.equal(audit.lang, PORTUGUESE);
});

const OPEN_FILES_ENV = 'RPG_DESKTOP_OPEN_FILES';
const OWN_RULES_FILE = 'two-dice.md';

test('rpg-42a.82 desktop journey of own rules files: choice, added file and a created campaign', {
  skip,
}, async (t) => {
  const rulesDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-own-rules-'));
  t.after(() => rmSync(rulesDir, { recursive: true, force: true }));
  writeFileSync(join(rulesDir, OWN_RULES_FILE), '# Combat\nTo attack, roll 2d6 and add Might.');
  const files = await captureJourneys(t, ['ownRules'], { [OPEN_FILES_ENV]: join(rulesDir, OWN_RULES_FILE) });
  for (const file of files) {
    const { audit } = JSON.parse(readFileSync(file.replace(/\.png$/, SHOT_DATA_EXTENSION), 'utf8'));
    assert.deepEqual(
      auditPage(audit).filter(({ impact }) => BLOCKING_IMPACTS.includes(impact)),
      [],
      basename(file),
    );
  }
});

test('rpg-42a.142 desktop journey of an unknown genre phrase: the blank-world notice on the summary', {
  skip,
}, async (t) => {
  const files = await captureJourneys(t, ['openWorld']);
  checkBaselines(t, files);
  assert.ok(files.length > 0);
});

test('rpg-42a.38 desktop journey of a diceless, sheetless campaign: rules, summary and play', { skip }, async (t) => {
  checkBaselines(t, await captureJourneys(t, ['diceless']));
});

const DESKTOP_CLIENT = 'desktop';
const PHYSICAL_RULESET = { id: 'd20-lite', edition: 'original' };
const PHYSICAL_ACTION = 'I slashed my sword on his head';
const PHYSICAL_SETUP = 'Old Tam sets down his mug and stares at you.';
const PHYSICAL_OFFER: GmProposal = {
  kind: 'check',
  id: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
};
const PHYSICAL_CHARACTER = 'A scout named Wren with might 3, agility 2, wits 2 and presence 1.';

const seedPhysicalOffer = async (dataDir: string, whoRolls: 'me' | 'app' = 'me') => {
  await createCampaignFrom(
    dataDir,
    {
      version: PROTOCOL_VERSION,
      type: 'CreateCampaign',
      name: CAMPAIGN,
      choices: { ruleset: PHYSICAL_RULESET, character: PHYSICAL_CHARACTER, diceVisualization: true },
      play: { whoRolls },
    },
    DESKTOP_CLIENT,
  );
  const gm: GameMaster = {
    request: async () => ({
      narration: PHYSICAL_SETUP,
      proposals: [PHYSICAL_OFFER],
      segments: [{ text: PHYSICAL_SETUP }],
    }),
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm);
  try {
    const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
    const snapshot = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(snapshot.ok);
    const { revision, currentScene, characters } = snapshot.value;
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: 'seed-physical',
      expectedRevision: revision,
      sceneId: currentScene?.id ?? '',
      actorId: characters[0]?.id ?? '',
      input: PHYSICAL_ACTION,
    });
    assert.ok(submitted.ok);
    await narrate();
  } finally {
    close();
  }
};

test('rpg-42a.96 desktop journey of a physical roll: the report field and the player-rolled card', {
  skip,
}, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-physical-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await seedPhysicalOffer(dataDir);
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-physical-screens-'));
  const stdout = await run(dataDir, { [CAPTURE_ENV]: dir, [JOURNEY_ENV]: 'physical' });
  assert.doesNotMatch(stdout, new RegExp(JOURNEY_ERROR));
  const files = journeyShots(dir, 'physical');
  for (const file of files) assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
  checkBaselines(t, files);
});

test('rpg-42a.87 desktop journey of a pending roll offer: the primary button in English and Portuguese', {
  skip,
}, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-offer-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await seedPhysicalOffer(dataDir, 'app');
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-offer-screens-'));
  const files: string[] = [];
  for (const [phase, language] of [
    ['rollOffer', DEFAULT_LOCALE],
    ['rollOfferPortuguese', PORTUGUESE],
  ] as const) {
    const stdout = await run(dataDir, { [CAPTURE_ENV]: dir, [JOURNEY_ENV]: phase, [LANGUAGE_ENV]: language });
    assert.doesNotMatch(stdout, new RegExp(JOURNEY_ERROR));
    for (const file of journeyShots(dir, phase)) {
      assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
      files.push(file);
    }
  }
  checkBaselines(t, files);
});

test('rpg-42a.109 desktop journey of the open slash menu: placement in English and Portuguese', { skip }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-slash-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await createCampaignFrom(
    dataDir,
    {
      version: PROTOCOL_VERSION,
      type: 'CreateCampaign',
      name: CAMPAIGN,
      choices: { ruleset: PHYSICAL_RULESET, character: PHYSICAL_CHARACTER },
    },
    DESKTOP_CLIENT,
  );
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-slash-screens-'));
  const files: string[] = [];
  for (const [phase, language] of [
    ['slashMenu', DEFAULT_LOCALE],
    ['slashMenuPortuguese', PORTUGUESE],
  ] as const) {
    const stdout = await run(dataDir, { [CAPTURE_ENV]: dir, [JOURNEY_ENV]: phase, [LANGUAGE_ENV]: language });
    assert.doesNotMatch(stdout, new RegExp(JOURNEY_ERROR));
    for (const file of journeyShots(dir, phase)) {
      assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
      files.push(file);
    }
  }
  checkBaselines(t, files);
});

const LIMIT_REPLY = JSON.stringify({
  type: 'result',
  is_error: true,
  result: "You've hit your limit · resets 3:30pm (Europe/Lisbon)",
});
const RECOVERED_REPLY = JSON.stringify({
  type: 'result',
  is_error: false,
  result: 'The guard squints at you, then waves you through the gate.',
  usage: { input_tokens: 120, output_tokens: 40 },
});
const LIMIT_EXIT = 1;

const limitThenRecoverClaude = (dir: string) => {
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const counter = path.join(__dirname, 'calls');
const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(calls + 1));
fs.readFileSync(0);
if (calls === 0) { process.stdout.write(${JSON.stringify(LIMIT_REPLY)}); process.exitCode = ${LIMIT_EXIT}; }
else process.stdout.write(${JSON.stringify(RECOVERED_REPLY)});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
};

test('rpg-42a.101 desktop journey of a failed provider turn: the notice with retry, then the recovered narration', {
  skip,
}, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-failure-'));
  const binDir = mkdtempSync(join(tmpdir(), 'rpg-desktop-failure-bin-'));
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });
  await createCampaignFrom(
    dataDir,
    {
      version: PROTOCOL_VERSION,
      type: 'CreateCampaign',
      name: CAMPAIGN,
      choices: { ruleset: PHYSICAL_RULESET, character: PHYSICAL_CHARACTER },
    },
    DESKTOP_CLIENT,
  );
  const dir = process.env[CAPTURE_ENV] || mkdtempSync(join(tmpdir(), 'rpg-desktop-failure-screens-'));
  const stdout = await run(dataDir, {
    [CAPTURE_ENV]: dir,
    [JOURNEY_ENV]: 'failure',
    [GM_ROUTE_ENV]: CLAUDE_CODE_ROUTE,
    [CLAUDE_BIN_ENV]: limitThenRecoverClaude(binDir),
  });
  assert.doesNotMatch(stdout, new RegExp(JOURNEY_ERROR));
  const files = journeyShots(dir, 'failure');
  for (const file of files) assert.ok(stdout.includes(`${CAPTURE_STATUS}${file}`), file);
  checkBaselines(t, files);
});
