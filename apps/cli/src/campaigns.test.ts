import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCampaignState } from './engine-gateway.ts';
import { hermeticGmEnv } from './gm-test-env.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const EXIT_OK = 0;
const FIRST = 'Ember';
const SECOND = 'Hollow';
const FIRST_ACTION = 'I light the lantern';
const WRONG_CONFIRMATION = 'yes';

const withDataDir = (run: (dataDir: string) => void) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-campaigns-'));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const rpg = (dataDir: string, args: readonly string[], input = '') =>
  spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input,
    env: { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir },
  });

const succeed = (dataDir: string, args: readonly string[], input = '') => {
  const result = rpg(dataDir, args, input);
  assert.equal(result.status, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('create, list, select, resume and archive campaigns without cross-campaign leakage', () =>
  withDataDir((dataDir) => {
    succeed(dataDir, ['new', FIRST]);
    succeed(dataDir, ['new', SECOND]);
    assert.match(succeed(dataDir, ['list']), new RegExp(`^Campaigns: ${FIRST}, ${SECOND}$`, 'm'));

    const untouched = readCampaignState(dataDir, SECOND);
    const opening = readCampaignState(dataDir, FIRST).turns.map(({ input }) => input);
    succeed(dataDir, ['play', FIRST], `${FIRST_ACTION}\n`);
    assert.deepEqual(
      readCampaignState(dataDir, FIRST).turns.map(({ input }) => input),
      [...opening, FIRST_ACTION],
    );
    assert.deepEqual(readCampaignState(dataDir, SECOND), untouched);
    assert.ok(!succeed(dataDir, ['resume', SECOND]).includes(FIRST_ACTION));
    assert.ok(succeed(dataDir, ['resume', FIRST]).includes(FIRST_ACTION));

    const saved = readCampaignState(dataDir, FIRST);
    assert.match(succeed(dataDir, ['archive', FIRST]), new RegExp(`Archived campaign ${FIRST}\\.`));
    const listed = succeed(dataDir, ['list']);
    assert.match(listed, new RegExp(`^Campaigns: ${SECOND}$`, 'm'));
    assert.match(listed, new RegExp(`^Archived: ${FIRST}$`, 'm'));
    assert.ok(!succeed(dataDir, []).includes(FIRST));

    const resumed = rpg(dataDir, ['resume', FIRST]);
    assert.notEqual(resumed.status, EXIT_OK);
    assert.match(resumed.stderr, new RegExp(`Campaign ${FIRST} is archived\\.`));
    assert.deepEqual(readCampaignState(dataDir, SECOND), untouched);

    succeed(dataDir, ['new', FIRST]);
    const twice = rpg(dataDir, ['archive', FIRST]);
    assert.notEqual(twice.status, EXIT_OK);
    assert.match(twice.stderr, new RegExp(`An archived campaign named ${FIRST} already exists\\.`));
    assert.deepEqual(readCampaignState(join(dataDir, 'archive'), FIRST), saved);
  }));

test('deletion requires explicit intent and offers backup/export guidance', () =>
  withDataDir((dataDir) => {
    succeed(dataDir, ['new', FIRST]);
    succeed(dataDir, ['new', SECOND]);
    const untouched = readCampaignState(dataDir, SECOND);

    for (const input of ['', `${WRONG_CONFIRMATION}\n`, `${FIRST.toLowerCase()}\n`]) {
      const kept = succeed(dataDir, ['delete', FIRST], input);
      assert.match(kept, /back up/i);
      assert.match(kept, new RegExp(`rpg backup ${FIRST}`));
      assert.match(kept, new RegExp(`rpg archive ${FIRST}`));
      assert.match(kept, new RegExp(`Type ${FIRST} to delete it`));
      assert.match(kept, new RegExp(`Kept campaign ${FIRST}\\.`));
      assert.ok(readCampaignState(dataDir, FIRST).campaign.name === FIRST);
    }

    assert.match(succeed(dataDir, ['delete', FIRST], `${FIRST}\n`), new RegExp(`Deleted campaign ${FIRST}\\.`));
    assert.throws(() => readCampaignState(dataDir, FIRST), new RegExp(`No campaign named ${FIRST}`));
    assert.deepEqual(readCampaignState(dataDir, SECOND), untouched);

    succeed(dataDir, ['archive', SECOND]);
    assert.match(succeed(dataDir, ['delete', SECOND], `${SECOND}\n`), new RegExp(`Deleted campaign ${SECOND}\\.`));
    assert.doesNotMatch(succeed(dataDir, ['list']), new RegExp(SECOND));

    const missing = rpg(dataDir, ['delete', FIRST], `${FIRST}\n`);
    assert.notEqual(missing.status, EXIT_OK);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, new RegExp(`No campaign named ${FIRST}`));
  }));
