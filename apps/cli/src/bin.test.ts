import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_INPUT_LENGTH } from '../../../packages/client-protocol/src/protocol.ts';
import { CHARACTER_CREATED } from '../../../packages/engine/src/character.ts';
import { readCampaignState } from './engine-gateway.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const CAMPAIGN = 'Ember';
const FIRST_ACTION = 'I open the door.';
const SECOND_ACTION = 'I light the lantern.';
const EXIT_OK = 0;
const NO_INPUT = '';
const READ_ONLY = 0o444;
const SAVE_FILE = `${CAMPAIGN}.sqlite`;
const D20_INTENT = 'A fantasy adventure using the D20-lite rules';
const CHARACTER = 'A scout named Ash with might 6, agility 5, wits 7 and presence 4, carrying a draught.';
const VAGUE_CHARACTER = 'A scout named Ash.';

const withDataDir = (run: (dataDir: string) => void) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-cli-'));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const rpg = (dataDir: string, args: readonly string[], input = NO_INPUT) =>
  spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, RPG_DATA_DIR: dataDir },
  });

const succeed = (dataDir: string, args: readonly string[], input = NO_INPUT) => {
  const result = rpg(dataDir, args, input);
  assert.equal(result.status, EXIT_OK, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('new, play, resume and act survive two save/resume cycles with identical state', () =>
  withDataDir((dataDir) => {
    assert.ok(succeed(dataDir, ['new', CAMPAIGN]).trim().length > 0);

    const played = succeed(dataDir, ['play', CAMPAIGN], `${FIRST_ACTION}\n`);
    assert.ok(played.includes(FIRST_ACTION));
    const firstSave = readCampaignState(dataDir, CAMPAIGN);

    succeed(dataDir, ['resume', CAMPAIGN]);
    assert.deepEqual(readCampaignState(dataDir, CAMPAIGN), firstSave);

    const acted = succeed(dataDir, ['resume', CAMPAIGN], `${SECOND_ACTION}\n`);
    assert.ok(acted.includes(SECOND_ACTION));
    const secondSave = readCampaignState(dataDir, CAMPAIGN);
    assert.equal(secondSave.revision, firstSave.revision + 1);
    assert.deepEqual(secondSave.turns.map(({ input }) => input).slice(-2), [FIRST_ACTION, SECOND_ACTION]);

    succeed(dataDir, ['resume', CAMPAIGN]);
    assert.deepEqual(readCampaignState(dataDir, CAMPAIGN), secondSave);
  }));

test('failed commands exit non-zero and leave state unchanged', () =>
  withDataDir((dataDir) => {
    const missing = rpg(dataDir, ['play', CAMPAIGN], `${FIRST_ACTION}\n`);
    assert.notEqual(missing.status, EXIT_OK);
    assert.ok(missing.stderr.includes(CAMPAIGN));
    assert.deepEqual(readdirSync(dataDir), []);

    succeed(dataDir, ['new', CAMPAIGN]);
    const created = readCampaignState(dataDir, CAMPAIGN);
    const duplicate = rpg(dataDir, ['new', CAMPAIGN]);
    assert.notEqual(duplicate.status, EXIT_OK);
    assert.ok(duplicate.stderr.includes(CAMPAIGN));
    assert.deepEqual(readCampaignState(dataDir, CAMPAIGN), created);
  }));

test('a failed action mid-play reports each error, keeps the session alive and leaves state unchanged', () =>
  withDataDir((dataDir) => {
    succeed(dataDir, ['new', CAMPAIGN]);
    const before = readCampaignState(dataDir, CAMPAIGN);
    chmodSync(join(dataDir, SAVE_FILE), READ_ONLY);
    const failed = rpg(dataDir, ['play', CAMPAIGN], `${FIRST_ACTION}\n${SECOND_ACTION}\n`);
    assert.equal(failed.status, EXIT_OK);
    assert.equal(failed.stderr.trim().split('\n').length, 2);
    assert.ok(!failed.stdout.includes(FIRST_ACTION));
    assert.deepEqual(readCampaignState(dataDir, CAMPAIGN), before);
  }));

const createdCharacters = (dataDir: string) =>
  readCampaignState(dataDir, CAMPAIGN).events.filter(({ type }) => type === CHARACTER_CREATED);

test('new creates a character from a description when the ruleset supplies creation rules', () =>
  withDataDir((dataDir) => {
    const out = succeed(dataDir, ['new', CAMPAIGN, D20_INTENT], `${CHARACTER}\n`);
    assert.match(out, /Ash/);
    const events = createdCharacters(dataDir);
    assert.deepEqual(
      events.map(({ payload }) => (payload as { profile: { identity: { name: string } } }).profile.identity.name),
      ['Ash'],
    );
  }));

test('new cuts a long character description to the player input limit', () =>
  withDataDir((dataDir) => {
    succeed(dataDir, ['new', CAMPAIGN, D20_INTENT], `${CHARACTER} ${'x'.repeat(MAX_INPUT_LENGTH)}\n`);
    const backstories = createdCharacters(dataDir).map(
      ({ payload }) => (payload as { profile: { background: string } }).profile.background,
    );
    assert.deepEqual(
      backstories.map(({ length }) => length),
      [MAX_INPUT_LENGTH],
    );
  }));

test('new keeps the default hero when the player skips or leaves character creation unfinished', () => {
  for (const input of [NO_INPUT, '\n', `${VAGUE_CHARACTER}\n`])
    withDataDir((dataDir) => {
      assert.ok(succeed(dataDir, ['new', CAMPAIGN, D20_INTENT], input).trim().length > 0);
      assert.deepEqual(createdCharacters(dataDir), []);
    });
});
