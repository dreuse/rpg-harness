import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hermeticGmEnv } from '../apps/cli/src/gm-test-env.ts';
import { PLATFORMS } from '../apps/desktop/src/packaging.ts';
import { DEFAULT_VOICE_SETTINGS, resolveVoiceMode } from '../packages/voice/src/voice.ts';

const ROOT = join(import.meta.dirname, '..');
const TEXT = 'utf8';
const BIN = join(ROOT, 'apps', 'cli', 'src', 'bin.ts');
const CAMPAIGN = 'Ember';
const ACTION = 'I wave.';
const EXIT_OK = 0;
const TEMP_PREFIX = 'rpg-q09-';
const TARGET_OSES = ['darwin', 'win32', 'linux'];
const OPTIONAL_RUNTIME_PATHS = ['/packages/voice/', '/packages/world/', '/apps/desktop/'];
const OPTIONAL_LOADED = 'optional runtime module loaded';
const BLOCK_OPTIONAL_RUNTIME = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    for (const path of ${JSON.stringify(OPTIONAL_RUNTIME_PATHS)}) {
      if (resolved.url.includes(path)) throw new Error('${OPTIONAL_LOADED} ' + path);
    }
    return resolved;
  },
});
`)}`;
const CORE_PACKAGES = ['domain', 'rules', 'engine', 'persistence', 'memory', 'narrative', 'content', 'intent'];
const OPTIONAL_PACKAGES = ['@rpg/voice', '@rpg/world', '@rpg/updater', '@rpg/desktop', '@rpg/cli'];
const OPTIONAL_IMPORT = /from '[^']*\/(?:voice|world|updater|apps)\//;
const SOURCE_FILE = /\.ts$/;
const TEST_FILE = /\.test\.ts$/;
const BD = 'bd';
const UNRESOLVED_P0_BUGS = ['list', '--status=open,in_progress,blocked', '--priority=0', '--type=bug', '--json'];

const MATRIX: readonly { row: string; file: string; titles: readonly string[] }[] = [
  {
    row: 'full-off smoke',
    file: 'apps/cli/src/tui.test.ts',
    titles: [
      'A18: headless text-only play does not depend on audio stack',
      'UI06: text-only and limited terminal environments still work without graphics',
    ],
  },
  {
    row: 'full-off smoke',
    file: 'packages/client-protocol/src/guided-start.test.ts',
    titles: ['rpg-42a.14 optional features default off and turning one off again restores default provenance'],
  },
  {
    row: 'same campaign across CLI/TUI/desktop',
    file: 'apps/desktop/src/cross-client.test.ts',
    titles: [
      'play campaign in desktop, resume in tui and compare identical state',
      'no duplicate turns on reconnect, restart or renderer switch',
    ],
  },
  {
    row: 'same campaign across CLI/TUI/desktop',
    file: 'apps/cli/src/client-session.test.ts',
    titles: ['clients subscribe to canonical event revisions and can resume same campaign'],
  },
  {
    row: 'voice on/off fixtures',
    file: 'packages/voice/src/voice.test.ts',
    titles: ['all features remain available with voice completely disabled'],
  },
  {
    row: 'voice on/off fixtures',
    file: 'packages/voice/src/campaign-acceptance.test.ts',
    titles: [
      'run mixed text/speech campaign with narrator, persistent npc voices and resume',
      'voice toggle, provider failure and game restart preserve canonical state',
    ],
  },
  {
    row: 'voice on/off fixtures',
    file: 'apps/desktop/src/voice.test.ts',
    titles: [
      'A18: desktop supports full voice; tui supports appropriate audio controls when available',
      'A21: desktop asks before the first capture and declining keeps text play',
    ],
  },
  {
    row: 'package smoke install on each target OS',
    file: 'apps/desktop/src/packaging.test.ts',
    titles: [
      'UI11 produce and verify platform-specific installation/launch and local data directory handling',
      'UI11 smoke test reports a missing install and a missing provider without launching',
    ],
  },
  {
    row: 'package smoke install on each target OS',
    file: 'apps/cli/src/update.test.ts',
    titles: ['update stages the verified build and installs it only on restart'],
  },
  {
    row: 'optional dice',
    file: 'apps/cli/src/roll-visualization.test.ts',
    titles: ['emits nothing when the visualization preference is disabled'],
  },
  {
    row: 'optional dice',
    file: 'apps/cli/src/client-session.test.ts',
    titles: ['encounter rolls stay hidden when dice visualization is off or the roll is gm-only'],
  },
  {
    row: 'optional combat',
    file: 'packages/engine/src/encounter.test.ts',
    titles: ['an encounter without pinned rules or sheets runs narratively and rejects mechanical moves'],
  },
  {
    row: 'optional combat',
    file: 'packages/intent/src/settings-change.test.ts',
    titles: ['N08 combat alone can be turned off or on'],
  },
  {
    row: 'optional world sim',
    file: 'packages/world/src/policy.test.ts',
    titles: ['unsupported mechanics are adjudicated visibly or simulation capability is disabled'],
  },
  {
    row: 'optional world sim',
    file: 'packages/world/src/simulation.test.ts',
    titles: ['simulates budgeted factions in conflict across game days deterministically under each pacing'],
  },
];

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) ? [path] : [];
  });

const manifestDeps = (name: string): string[] => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), TEXT));
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies });
};

test('pass m3 acceptance matrix with all optional capabilities implemented and disabled-mode smoke tests', (t) => {
  for (const { row, file, titles } of MATRIX) {
    const path = join(ROOT, file);
    assert.ok(existsSync(path), `${row}: missing ${file}`);
    const text = readFileSync(path, TEXT);
    for (const title of titles) assert.ok(text.includes(`'${title}'`), `${row}: ${file} lacks test '${title}'`);
  }

  assert.deepEqual([...PLATFORMS], TARGET_OSES);
  assert.deepEqual(resolveVoiceMode(DEFAULT_VOICE_SETTINGS), { kind: 'typed-input-only' });

  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir, TERM: 'dumb', NO_COLOR: '1' };
  const rpg = (args: readonly string[], input = '') =>
    spawnSync(process.execPath, ['--import', BLOCK_OPTIONAL_RUNTIME, BIN, ...args], { input, encoding: TEXT, env });
  const created = rpg(['new', CAMPAIGN]);
  assert.equal(created.status, EXIT_OK, created.stderr);
  const played = rpg(['play', CAMPAIGN], `${ACTION}\n`);
  assert.equal(played.status, EXIT_OK, played.stderr);
  assert.doesNotMatch(played.stderr, new RegExp(OPTIONAL_LOADED));
  assert.match(played.stdout, new RegExp(`: ${ACTION}`));
  assert.match(rpg(['journal', CAMPAIGN]).stdout, /Rain drums/);
});

test('no unresolved p0 critical defect and all runtime components remain optional', async (t) => {
  for (const name of CORE_PACKAGES) {
    assert.deepEqual(
      manifestDeps(name).filter((dep) => OPTIONAL_PACKAGES.includes(dep)),
      [],
      `${name} manifest`,
    );
    const offending = sources(join(ROOT, 'packages', name, 'src')).filter((file) =>
      OPTIONAL_IMPORT.test(readFileSync(file, TEXT)),
    );
    assert.deepEqual(offending, [], `${name} imports an optional runtime module`);
  }

  const bd = spawnSync(BD, UNRESOLVED_P0_BUGS, { cwd: ROOT, encoding: TEXT });
  const unavailable = bd.error ? bd.error.message : bd.status === EXIT_OK ? '' : bd.stderr.trim();
  await t.test(
    'no unresolved p0 bug in beads',
    { skip: unavailable ? `bd unavailable: ${unavailable}` : false },
    () => {
      assert.deepEqual(JSON.parse(bd.stdout), []);
    },
  );
});
