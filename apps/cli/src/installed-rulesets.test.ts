import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CampaignEvent } from '../../../packages/domain/src/campaign.ts';
import { CAMPAIGN_CONFIGURED } from '../../../packages/domain/src/campaign.ts';
import { generateCampaignConfig } from '../../../packages/intent/src/config.ts';
import { createCampaignIntent } from '../../../packages/intent/src/intent.ts';
import { compileRule } from '../../../packages/rules/src/compile.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { RULE_DSL_VERSION, type RuleDsl } from '../../../packages/rules/src/dsl.ts';
import type { RulePackManifest } from '../../../packages/rules/src/rulepack.ts';
import { BUILT_IN_PACKS } from './import-gateway.ts';
import {
  INSTALLED_DIR,
  installedRulesetIn,
  installedRulesets,
  installRuleset,
  loadInstalledRuleset,
} from './installed-rulesets.ts';

const SOURCE_HASH = 'sha256-house-rules';
const RULE: RuleDsl = { dslVersion: RULE_DSL_VERSION, id: 'house-rule', effects: [] };
const ESCAPING_ID = '../escape';
const OVERSIZED_RULE_COUNT = 5000;

const compiled = (id = RULE.id) => {
  const result = compileRule({
    rule: { ...RULE, id },
    rulePack: D20_LITE_MANIFEST,
    sourceRefs: [SOURCE_HASH],
  });
  assert.ok(result.ok);
  return result.rule;
};

const withDataDir = (run: (dataDir: string) => void) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-installed-'));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const fileOf = (dataDir: string, id: string) => join(dataDir, INSTALLED_DIR, `${id}.json`);

test('rpg-42a.122 an installed ruleset keeps the base mechanics under its own id and survives a restart', () =>
  withDataDir((dataDir) => {
    const manifest = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    assert.notEqual(manifest.id, D20_LITE_MANIFEST.id);
    assert.equal(manifest.edition, D20_LITE_MANIFEST.edition);
    assert.deepEqual(manifest.capabilities, D20_LITE_MANIFEST.capabilities);
    assert.deepEqual(manifest.sourceRefs, [SOURCE_HASH]);
    assert.deepEqual(installedRulesets(dataDir), [manifest]);
    const loaded = loadInstalledRuleset(dataDir, manifest.id);
    assert.deepEqual(loaded.manifest, manifest);
    assert.equal(loaded.rules[0]?.rule.id, RULE.id);
    assert.deepEqual(loaded.rules[0]?.rulePack, {
      id: manifest.id,
      edition: manifest.edition,
      revision: manifest.revision,
    });
  }));

test('rpg-42a.122 installing the same import twice keeps one ruleset and different rules get another', () =>
  withDataDir((dataDir) => {
    const first = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    assert.deepEqual(installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]), first);
    const other = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled('other-rule')]);
    assert.notEqual(other.id, first.id);
    assert.equal(installedRulesets(dataDir).length, 2);
  }));

test('rpg-42a.122 nothing is listed before anything is installed', () =>
  withDataDir((dataDir) => assert.deepEqual(installedRulesets(dataDir), [])));

test('rpg-42a.122 a tampered file is dropped from the list and refused on load', () =>
  withDataDir((dataDir) => {
    const { id } = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    const path = fileOf(dataDir, id);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.rules[0].rule.effects = [{ kind: 'shell', command: 'rm -rf /' }];
    writeFileSync(path, JSON.stringify(stored));
    assert.deepEqual(installedRulesets(dataDir), []);
    assert.throws(() => loadInstalledRuleset(dataDir, id), /rejected/);
  }));

test('rpg-42a.122 a file whose manifest id differs from its name is refused', () =>
  withDataDir((dataDir) => {
    const { id } = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    const stored = JSON.parse(readFileSync(fileOf(dataDir, id), 'utf8'));
    writeFileSync(fileOf(dataDir, 'renamed'), JSON.stringify(stored));
    assert.throws(() => loadInstalledRuleset(dataDir, 'renamed'), /rejected/);
  }));

test('rpg-42a.122 ruleset ids cannot escape the installed folder', () =>
  withDataDir((dataDir) => {
    mkdirSync(join(dataDir, INSTALLED_DIR), { recursive: true });
    writeFileSync(join(dataDir, 'escape.json'), '{}');
    assert.throws(() => loadInstalledRuleset(dataDir, ESCAPING_ID), /rejected/);
    assert.throws(() => installRuleset(dataDir, { ...D20_LITE_MANIFEST, id: ESCAPING_ID }, [compiled()]), /rejected/);
  }));

test('rpg-42a.122 oversized or corrupt files are skipped without hiding good rulesets', () =>
  withDataDir((dataDir) => {
    const good = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    writeFileSync(fileOf(dataDir, 'corrupt'), '{not json');
    writeFileSync(fileOf(dataDir, 'huge'), 'x'.repeat(OVERSIZED_RULE_COUNT * 1024));
    assert.deepEqual(installedRulesets(dataDir), [good]);
    assert.ok(readdirSync(join(dataDir, INSTALLED_DIR)).length >= 3);
  }));

test('rpg-42a.122 too many rules are refused at install time', () =>
  withDataDir((dataDir) => {
    const rules = Array.from({ length: OVERSIZED_RULE_COUNT }, () => compiled());
    assert.throws(() => installRuleset(dataDir, D20_LITE_MANIFEST, rules), /rejected/);
    assert.deepEqual(installedRulesets(dataDir), []);
  }));

const campaignOn = (rulepacks: readonly RulePackManifest[], id: string): CampaignEvent[] => {
  const intent = createCampaignIntent({
    ruleset: { value: { id, edition: D20_LITE_MANIFEST.edition }, provenance: 'explicit' },
  });
  const generated = generateCampaignConfig(intent, { rulepacks, genres: [] });
  assert.ok(generated.ok, JSON.stringify(generated));
  return [{ type: CAMPAIGN_CONFIGURED, payload: { config: generated.config } }] as unknown as CampaignEvent[];
};

test('rpg-42a.123 a campaign pinned to an installed ruleset resolves its stored rules and base-pack campaigns do not', () =>
  withDataDir((dataDir) => {
    const manifest = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    const packs = [...BUILT_IN_PACKS, manifest];
    const resolved = installedRulesetIn(dataDir, campaignOn(packs, manifest.id));
    assert.deepEqual(resolved?.manifest, manifest);
    assert.equal(resolved?.rules[0]?.rule.id, RULE.id);
    assert.equal(installedRulesetIn(dataDir, campaignOn(packs, D20_LITE_MANIFEST.id)), undefined);
    assert.equal(installedRulesetIn(dataDir, []), undefined);
  }));

test('rpg-42a.123 a missing or corrupt stored ruleset is a clear error, never the base pack', () =>
  withDataDir((dataDir) => {
    const manifest = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    const events = campaignOn([...BUILT_IN_PACKS, manifest], manifest.id);
    writeFileSync(fileOf(dataDir, manifest.id), '{not json');
    assert.throws(() => installedRulesetIn(dataDir, events), /rejected: the file is not valid JSON/);
    rmSync(fileOf(dataDir, manifest.id));
    assert.throws(() => installedRulesetIn(dataDir, events), /rejected: the file is missing/);
    assert.throws(() => loadInstalledRuleset(dataDir, manifest.id), /rejected: the file is missing/);
  }));

test('rpg-42a.123 a stored file whose edition or revision differs from the campaign pin is refused', () =>
  withDataDir((dataDir) => {
    const manifest = installRuleset(dataDir, D20_LITE_MANIFEST, [compiled()]);
    const events = campaignOn([...BUILT_IN_PACKS, manifest], manifest.id);
    const original = readFileSync(fileOf(dataDir, manifest.id), 'utf8');
    for (const change of [{ edition: 'other-edition' }, { revision: 'other-revision' }]) {
      const stored = JSON.parse(original);
      writeFileSync(fileOf(dataDir, manifest.id), JSON.stringify({ ...stored, manifest: { ...manifest, ...change } }));
      assert.throws(() => installedRulesetIn(dataDir, events), /rejected: its edition or revision differs/);
    }
  }));
