import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { importRules } from './import-gateway.ts';
import { INSTALLED_DIR, installedRulesets } from './installed-rulesets.ts';

const RULE_FILE = 'reroll.json';
const PROSE_FILE = 'notes.md';
const PDF_FILE = 'core.pdf';
const HOUSE_FILE = 'house.json';
const HOUSE_RULE = { dslVersion: 1, id: 'house-rule', effects: [] };
const RULE = {
  dslVersion: 1,
  id: 'focus-reroll',
  costs: [{ kind: 'cost', resource: 'focus', amount: { kind: 'const', value: 1 } }],
  effects: [{ kind: 'emitEvent', event: 'check.rerolled' }],
};

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), 'rpg-import-'));
  try {
    writeFileSync(join(root, RULE_FILE), JSON.stringify(RULE, null, 2));
    writeFileSync(join(root, PROSE_FILE), 'Roll when unsure.\n\nRest to recover.');
    writeFileSync(join(root, PDF_FILE), '%PDF-1.7 book');
    writeFileSync(join(root, HOUSE_FILE), JSON.stringify(HOUSE_RULE));
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const withDataDir = async (run: (dataDir: string) => Promise<void>) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-import-data-'));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const collect = async (root: string, files: readonly string[], replies: readonly string[], dataDir = root) => {
  const out: string[] = [];
  const lines = (async function* () {
    yield* replies;
  })();
  for await (const text of importRules(root, files, lines, dataDir)) out.push(text);
  return out.join('\n');
};

test('cli import reads the named files, lists every gap and lets the player decline', () =>
  withRoot(async (root) => {
    const text = await collect(root, [RULE_FILE, PROSE_FILE, PDF_FILE], ['use d20-lite', 'activate', 'decline']);
    assert.match(text, /d20-lite/);
    assert.match(text, /unsupported_mechanic in reroll\.json: compile_failed; capabilities\.resourceCost is disabled/);
    assert.match(text, /unsupported_mechanic in notes\.md: flagged/);
    assert.match(text, /extraction_failed in core\.pdf/);
    assert.match(text, /Activation refused/);
    assert.match(text, /Import declined/);
  }));

test('cli import fails when the conversation ends with gaps left', () =>
  withRoot(async (root) => {
    await assert.rejects(collect(root, [PROSE_FILE], ['use d20-lite']), /Import not completed/);
  }));

test('cli import only reads files inside the import folder', () =>
  withRoot(async (root) => {
    const outside = mkdtempSync(join(tmpdir(), 'rpg-outside-'));
    try {
      writeFileSync(join(outside, PROSE_FILE), 'Secret.');
      symlinkSync(join(outside, PROSE_FILE), join(root, 'link.md'));
      for (const file of [join('..', basename(outside), PROSE_FILE), join(outside, PROSE_FILE), 'link.md']) {
        await assert.rejects(collect(root, [file], []), /outside the import folder/, file);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

test('rpg-42a.122 an activated import is installed and listed after a restart', () =>
  withRoot((root) =>
    withDataDir(async (dataDir) => {
      const text = await collect(root, [HOUSE_FILE], ['use d20-lite', 'activate'], dataDir);
      const [installed, ...others] = installedRulesets(dataDir);
      assert.ok(installed !== undefined && others.length === 0);
      assert.match(text, new RegExp(`Installed ruleset ${installed.id}`));
      assert.equal(installed.edition, 'original');
    }),
  ));

test('rpg-42a.122 declining or leaving gaps installs nothing and replaces no pack', () =>
  withRoot((root) =>
    withDataDir(async (dataDir) => {
      const text = await collect(root, [HOUSE_FILE, PROSE_FILE], ['use d20-lite', 'activate', 'decline'], dataDir);
      assert.match(text, /Activation refused/);
      assert.match(text, /Import declined/);
      await assert.rejects(collect(root, [PROSE_FILE], ['use d20-lite'], dataDir), /Import not completed/);
      assert.equal(existsSync(join(dataDir, INSTALLED_DIR)), false);
      assert.deepEqual(installedRulesets(dataDir), []);
    }),
  ));
