import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCampaignState } from './engine-gateway.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const EXIT_OK = 0;
const DEFAULT_CAMPAIGN = 'Ember';
const INTENT_CAMPAIGN = 'Hollow';
const INTENT = 'A horror story using the Narrative rules';
const MISSING_INTENT = 'A fantasy adventure using the Pathfinder rules';

const withDataDir = (run: (dataDir: string) => void) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-quickstart-'));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const rpg = (dataDir: string, args: readonly string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, RPG_DATA_DIR: dataDir } });

const succeed = (dataDir: string, args: readonly string[]) => {
  const result = rpg(dataDir, args);
  assert.equal(result.status, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('new users can start with default choices or one-sentence campaign intent', () =>
  withDataDir((dataDir) => {
    const defaults = succeed(dataDir, ['new', DEFAULT_CAMPAIGN]);
    assert.match(defaults, /^Ruleset: none \(default\)$/m);
    assert.match(defaults, /^Genre: none \(default\)$/m);
    assert.match(defaults, /^Dice: as the ruleset decides \(default\)$/m);

    const intended = succeed(dataDir, ['new', INTENT_CAMPAIGN, INTENT]);
    assert.match(intended, /^Ruleset: narrative original \(derived\)$/m);
    assert.match(intended, /^Genre: horror 1\.0\.0 \(derived\)$/m);

    const launcher = succeed(dataDir, []);
    assert.ok(launcher.includes(DEFAULT_CAMPAIGN) && launcher.includes(INTENT_CAMPAIGN));
    assert.ok(launcher.includes('rpg resume'));

    const saved = readCampaignState(dataDir, INTENT_CAMPAIGN);
    assert.ok(succeed(dataDir, ['resume', INTENT_CAMPAIGN]).trim().length > 0);
    assert.deepEqual(readCampaignState(dataDir, INTENT_CAMPAIGN), saved);
  }));

test('missing ruleset files are surfaced honestly instead of invented', () =>
  withDataDir((dataDir) => {
    const result = rpg(dataDir, ['new', DEFAULT_CAMPAIGN, MISSING_INTENT]);
    assert.notEqual(result.status, EXIT_OK);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Ruleset Pathfinder is not installed\./);
    assert.match(result.stderr, /Installed rulesets: d20-lite original, dice-pool-lite original, narrative original\./);
    assert.match(result.stderr, /rpg import <file>/);
    assert.deepEqual(readdirSync(dataDir), []);
  }));
