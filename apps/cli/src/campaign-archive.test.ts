import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { MAX_ARCHIVE_BYTES, restoreArchive } from './campaign-archive.ts';
import { readCampaignState } from './engine-gateway.ts';
import { hermeticGmEnv } from './gm-test-env.ts';

const BIN = join(import.meta.dirname, 'bin.ts');
const EXIT_OK = 0;
const CAMPAIGN = 'Ember';
const ACTION = 'I light the lantern';
const RULEPACK = 'homebrew-core';
const RULEPACK_REVISION = '2.1.0';
const DATA = 'data';
const OUTSIDE = 'outside';
const ARCHIVE = 'ember.rpg-archive.json';
const ENCODED_NAMES = ['AC/DC', '..'];
const TEMP_SUFFIX = '.tmp';
const PIN_RULEPACK = 'INSERT INTO ruleset_ref (campaign_id, rulepack_id, revision) SELECT id, ?, ? FROM campaign';
const SELECT_PINS = 'SELECT rulepack_id, revision FROM ruleset_ref ORDER BY rulepack_id';

const withRoot = (run: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-archive-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

const refuse = (dataDir: string, args: readonly string[], reason: RegExp) => {
  const result = rpg(dataDir, args);
  assert.notEqual(result.status, EXIT_OK, args.join(' '));
  assert.match(result.stderr, reason, args.join(' '));
};

const campaignFile = (dataDir: string, name: string) => join(dataDir, `${encodeURIComponent(name)}.sqlite`);

const pins = (dataDir: string, name: string) => {
  const connection = openDatabase(campaignFile(dataDir, name));
  try {
    return connection.database
      .prepare(SELECT_PINS)
      .all()
      .map(({ rulepack_id, revision }) => ({ rulepack_id, revision }));
  } finally {
    connection.close();
  }
};

const pinRulepack = (dataDir: string) => {
  const connection = openDatabase(campaignFile(dataDir, CAMPAIGN));
  connection.database.prepare(PIN_RULEPACK).run(RULEPACK, RULEPACK_REVISION);
  connection.close();
};

const listTree = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();

test('round-trip campaigns and rulepack version pins through portable validated archives', () =>
  withRoot((root) => {
    const source = join(root, 'source');
    const target = join(root, 'target');
    const file = join(root, ARCHIVE);
    succeed(source, ['new', CAMPAIGN]);
    succeed(source, ['play', CAMPAIGN], `${ACTION}\n`);
    pinRulepack(source);
    const saved = readCampaignState(source, CAMPAIGN);
    const savedPins = pins(source, CAMPAIGN);

    assert.match(succeed(source, ['export', CAMPAIGN, file]), new RegExp(`Exported campaign ${CAMPAIGN}`));
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(manifest.campaign, CAMPAIGN);
    assert.deepEqual(manifest.rulesets, [{ rulepackId: RULEPACK, revision: RULEPACK_REVISION }]);
    refuse(source, ['export', CAMPAIGN, file], /already exists/);

    assert.match(succeed(target, ['restore', file]), new RegExp(`Restored campaign ${CAMPAIGN}`));
    assert.deepEqual(readCampaignState(target, CAMPAIGN), saved);
    assert.deepEqual(pins(target, CAMPAIGN), savedPins);
    assert.ok(succeed(target, ['resume', CAMPAIGN]).includes(ACTION));
    refuse(target, ['restore', file], new RegExp(`campaign named ${CAMPAIGN} already exists`));

    const backup = succeed(source, ['backup', CAMPAIGN]);
    const [backupFile] = readdirSync(join(source, 'backups')).map((name) => join(source, 'backups', name));
    assert.ok(backupFile !== undefined && backup.includes(backupFile));
    succeed(source, ['play', CAMPAIGN], 'I leave the inn\n');
    succeed(source, ['delete', CAMPAIGN], `${CAMPAIGN}\n`);
    succeed(source, ['restore', backupFile]);
    assert.deepEqual(readCampaignState(source, CAMPAIGN), saved);
    assert.deepEqual(pins(source, CAMPAIGN), savedPins);
    assert.match(succeed(source, ['list']), new RegExp(`^Campaigns: ${CAMPAIGN}$`, 'm'));
    assert.deepEqual(
      listTree(source).filter((path) => path.endsWith(TEMP_SUFFIX)),
      [],
    );

    const odd = join(root, 'odd');
    for (const name of ENCODED_NAMES) {
      const oddFile = join(root, `${encodeURIComponent(name)}.json`);
      succeed(odd, ['new', name]);
      succeed(odd, ['export', name, oddFile]);
      succeed(target, ['restore', oddFile]);
      assert.deepEqual(readCampaignState(target, name), readCampaignState(odd, name));
    }
  }));

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const rewriteDatabase = (manifest: Record<string, unknown>, scratch: string, sql: string) => {
  const path = join(scratch, `rewrite-${Math.random()}.sqlite`);
  writeFileSync(path, Buffer.from(String(manifest.database), 'base64'));
  const database = new DatabaseSync(path);
  database.exec(sql);
  database.close();
  const bytes = readFileSync(path);
  return { ...manifest, database: bytes.toString('base64'), sha256: sha256(bytes) };
};

test('untrusted archives cannot write outside application data directory', () =>
  withRoot((root) => {
    const dataDir = join(root, DATA);
    const outside = join(root, OUTSIDE);
    const scratch = join(root, 'scratch');
    mkdirSync(outside);
    mkdirSync(scratch);
    const file = join(scratch, ARCHIVE);
    succeed(dataDir, ['new', CAMPAIGN]);
    pinRulepack(dataDir);
    succeed(dataDir, ['export', CAMPAIGN, file]);
    succeed(dataDir, ['delete', CAMPAIGN], `${CAMPAIGN}\n`);
    const valid = JSON.parse(readFileSync(file, 'utf8'));
    const renamed = (name: string) =>
      rewriteDatabase({ ...valid, campaign: name }, scratch, `UPDATE campaign SET name = '${name}'`);

    const hostile: [string, unknown, RegExp][] = [
      ['checksum', { ...valid, sha256: sha256(Buffer.from('tampered')) }, /checksum/],
      ['format', { ...valid, formatVersion: 99 }, /archive format/],
      ['schema', { ...valid, schemaVersion: 999 }, /schema version/],
      ['shape', { ...valid, rulesets: 'all' }, /rulesets/],
      ['pins', { ...valid, rulesets: [] }, /rulepack pins/],
      ['name mismatch', { ...valid, campaign: 'Other' }, /campaign name/],
      [
        'trigger',
        rewriteDatabase(valid, scratch, 'CREATE TRIGGER evil AFTER INSERT ON scene BEGIN SELECT 1; END;'),
        /schema/,
      ],
      ['not json', '{', /not a valid campaign archive/],
    ];
    for (const [label, content, reason] of hostile) {
      const path = join(scratch, `${label}.json`);
      writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
      refuse(dataDir, ['restore', path], reason);
    }

    refuse(dataDir, ['restore', scratch], /not a valid campaign archive/);

    for (const name of [`../${OUTSIDE}/escape`, join(outside, 'escape')]) {
      const path = join(scratch, `${encodeURIComponent(name)}.json`);
      writeFileSync(path, JSON.stringify(renamed(name)));
      succeed(dataDir, ['restore', path]);
      assert.ok(existsSync(campaignFile(dataDir, name)));
      rmSync(campaignFile(dataDir, name));
    }
    assert.throws(
      () => restoreArchive(file, dataDir, (name) => join(outside, `${name}.sqlite`)),
      /campaign name is not allowed/,
    );

    const oversize = join(scratch, 'oversize.json');
    writeFileSync(oversize, '');
    truncateSync(oversize, MAX_ARCHIVE_BYTES + 1);
    refuse(dataDir, ['restore', oversize], /too large/);

    const victim = join(outside, 'victim.sqlite');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, campaignFile(dataDir, CAMPAIGN));
    refuse(dataDir, ['restore', file], /already exists/);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    rmSync(campaignFile(dataDir, CAMPAIGN));

    assert.deepEqual(listTree(outside), ['victim.sqlite']);
    assert.deepEqual(listTree(dataDir), []);
    assert.ok(!existsSync(join(root, 'escape.sqlite')));
    assert.deepEqual(
      listTree(root).filter((path) => !path.startsWith(`${OUTSIDE}`) && !path.startsWith('scratch')),
      [DATA],
    );

    succeed(dataDir, ['restore', file]);
    assert.deepEqual(pins(dataDir, CAMPAIGN), [{ rulepack_id: RULEPACK, revision: RULEPACK_REVISION }]);
  }));
