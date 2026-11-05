import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BUNDLE_FORMAT,
  finishUpdate,
  InvalidBundleError,
  installStaged,
  previousDir,
  stageBundle,
  stagedDir,
} from './apply.ts';

const VERSION = '1.3.0';
const OLD_BIN = 'old bin';
const NEW_BIN = 'new bin';
const BIN = join('apps', 'cli', 'src', 'bin.ts');
const BACKUP = { database: 'Ember.sqlite', archive: 'Ember-backup.rpg-archive.json' };
const MIGRATION_FAILED = 'migration 9 failed';

const bundle = (files: Record<string, string>, version = VERSION, format = BUNDLE_FORMAT) =>
  JSON.stringify({
    format,
    version,
    files: Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text).toString('base64') })),
  });

const setup = (t: { after: (fn: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-apply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installDir = join(root, 'rpg');
  mkdirSync(join(installDir, 'apps', 'cli', 'src'), { recursive: true });
  writeFileSync(join(installDir, BIN), OLD_BIN);
  const bundleFile = join(root, 'bundle.json');
  const stage = (text: string, version = VERSION) => {
    writeFileSync(bundleFile, text);
    stageBundle(bundleFile, installDir, version);
  };
  return { root, installDir, stage };
};

const readBin = (installDir: string) => readFileSync(join(installDir, BIN), 'utf8');

test('stages a bundle next to the install without touching it', (t) => {
  const { installDir, stage } = setup(t);
  stage(bundle({ [BIN]: NEW_BIN }));
  assert.equal(readBin(installDir), OLD_BIN);
  assert.equal(readBin(stagedDir(installDir)), NEW_BIN);
});

test('rejects bundles with unsafe paths, another version or format and leaves no files', (t) => {
  const { root, installDir, stage } = setup(t);
  const bad = [
    bundle({ '../escape.ts': 'x' }),
    bundle({ '/etc/passwd': 'x' }),
    bundle({ [BIN]: NEW_BIN }, '1.4.0'),
    bundle({ [BIN]: NEW_BIN }, VERSION, 'zip'),
    'not json',
  ];
  for (const text of bad) assert.throws(() => stage(text), InvalidBundleError);
  assert.deepEqual(readdirSync(root).sort(), ['bundle.json', 'rpg']);
  assert.equal(existsSync(join(root, 'escape.ts')), false);
  assert.equal(readBin(installDir), OLD_BIN);
});

test('installs the staged files and keeps the previous version', (t) => {
  const { installDir, stage } = setup(t);
  stage(bundle({ [BIN]: NEW_BIN }));
  installStaged(installDir);
  assert.equal(readBin(installDir), NEW_BIN);
  assert.equal(readBin(previousDir(installDir)), OLD_BIN);
  assert.equal(existsSync(stagedDir(installDir)), false);
});

test('finishes an update when migrations pass', (t) => {
  const { installDir, stage } = setup(t);
  stage(bundle({ [BIN]: NEW_BIN }));
  installStaged(installDir);
  const restored: unknown[] = [];
  const result = finishUpdate({
    installDir,
    applied: { from: '1.2.0', to: VERSION, installDir, backups: [BACKUP] },
    migrate: () => undefined,
    restore: (backup) => restored.push(backup),
  });
  assert.deepEqual(result, { status: 'updated', version: VERSION });
  assert.deepEqual(restored, []);
  assert.equal(existsSync(previousDir(installDir)), false);
});

test('rolls back files and campaign backups when a migration fails', (t) => {
  const { installDir, stage } = setup(t);
  stage(bundle({ [BIN]: NEW_BIN }));
  installStaged(installDir);
  const restored: unknown[] = [];
  const result = finishUpdate({
    installDir,
    applied: { from: '1.2.0', to: VERSION, installDir, backups: [BACKUP] },
    migrate: () => {
      throw new Error(MIGRATION_FAILED);
    },
    restore: (backup) => restored.push(backup),
  });
  assert.deepEqual(result, { status: 'rolled-back', version: '1.2.0', reason: MIGRATION_FAILED });
  assert.deepEqual(restored, [BACKUP]);
  assert.equal(readBin(installDir), OLD_BIN);
  assert.equal(existsSync(previousDir(installDir)), false);
});
