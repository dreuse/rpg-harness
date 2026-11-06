import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CampaignEvent } from '../../../packages/domain/src/campaign.ts';
import { campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { compileRule } from '../../../packages/rules/src/compile.ts';
import { type CompiledRule, parseRuleDsl } from '../../../packages/rules/src/dsl.ts';
import { isRecord, type RulePackManifest, validateManifest } from '../../../packages/rules/src/rulepack.ts';

export const INSTALLED_DIR = 'rulesets';
export const MAX_INSTALLED_BYTES = 4 * 1024 * 1024;
export const MAX_INSTALLED_RULES = 1000;
export const MAX_INSTALLED_RULESETS = 64;
const FILE_EXTENSION = '.json';
const TEXT = 'utf8';
const HASH_ALGORITHM = 'sha256';
const HASH_LENGTH = 12;
const IMPORT_SEPARATOR = '-import-';
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const TEMP_SUFFIX = '.tmp';

type Stored = { manifest: RulePackManifest; rules: readonly CompiledRule[] };

export type InstalledRuleset = { manifest: RulePackManifest; rules: readonly CompiledRule[] };

const rejected = (id: string, reason: string) => new Error(`Installed ruleset ${id} rejected: ${reason}.`);

const folderOf = (dataDir: string) => join(dataDir, INSTALLED_DIR);

const pathOf = (dataDir: string, id: string) => {
  if (!ID_PATTERN.test(id)) throw rejected(id, 'the id is not a plain name');
  return join(folderOf(dataDir), `${id}${FILE_EXTENSION}`);
};

const contentHash = (base: RulePackManifest, rules: readonly CompiledRule[]) =>
  createHash(HASH_ALGORITHM)
    .update(
      JSON.stringify([base.id, base.edition, base.revision, rules.map(({ rule, sourceRefs }) => [rule, sourceRefs])]),
    )
    .digest('hex')
    .slice(0, HASH_LENGTH);

const recompile = (id: string, manifest: RulePackManifest, entry: unknown): CompiledRule => {
  if (
    !isRecord(entry) ||
    !Array.isArray(entry.sourceRefs) ||
    !entry.sourceRefs.every((ref) => typeof ref === 'string')
  ) {
    throw rejected(id, 'a rule entry is malformed');
  }
  const parsed = parseRuleDsl(entry.rule);
  if (!parsed.ok) throw rejected(id, 'a rule is not valid rule data');
  const compiled = compileRule({ rule: parsed.rule, rulePack: manifest, sourceRefs: entry.sourceRefs });
  if (!compiled.ok) throw rejected(id, 'a rule needs a disabled capability');
  return compiled.rule;
};

export const installRuleset = (dataDir: string, base: RulePackManifest, rules: readonly CompiledRule[]) => {
  if (rules.length > MAX_INSTALLED_RULES) throw rejected(base.id, `more than ${MAX_INSTALLED_RULES} rules`);
  const id = `${base.id}${IMPORT_SEPARATOR}${contentHash(base, rules)}`;
  const path = pathOf(dataDir, id);
  const manifest: RulePackManifest = {
    ...base,
    id,
    sourceRefs: [...new Set(rules.flatMap(({ sourceRefs }) => sourceRefs))],
  };
  mkdirSync(folderOf(dataDir), { recursive: true });
  const temporary = `${path}${TEMP_SUFFIX}`;
  writeFileSync(temporary, JSON.stringify({ manifest, rules } satisfies Stored));
  renameSync(temporary, path);
  return manifest;
};

export const loadInstalledRuleset = (dataDir: string, id: string): InstalledRuleset => {
  const path = pathOf(dataDir, id);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw rejected(id, 'the file is missing');
  }
  if (size > MAX_INSTALLED_BYTES) throw rejected(id, 'the file is too large');
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(path, TEXT));
  } catch {
    throw rejected(id, 'the file is not valid JSON');
  }
  if (!isRecord(stored) || !Array.isArray(stored.rules)) throw rejected(id, 'the file has the wrong shape');
  if (stored.rules.length > MAX_INSTALLED_RULES) throw rejected(id, `more than ${MAX_INSTALLED_RULES} rules`);
  const checked = validateManifest(stored.manifest);
  if (!checked.ok) throw rejected(id, 'the manifest is invalid');
  if (checked.manifest.id !== id) throw rejected(id, 'the manifest id does not match the file name');
  const { manifest } = checked;
  return { manifest, rules: stored.rules.map((entry) => recompile(id, manifest, entry)) };
};

export const installedRulesets = (dataDir: string): RulePackManifest[] => {
  let names: string[];
  try {
    names = readdirSync(folderOf(dataDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(FILE_EXTENSION))
    .sort()
    .slice(0, MAX_INSTALLED_RULESETS)
    .flatMap((name) => {
      try {
        return [loadInstalledRuleset(dataDir, name.slice(0, -FILE_EXTENSION.length)).manifest];
      } catch {
        return [];
      }
    });
};

export const baseIdOf = (id: string) => {
  const at = id.lastIndexOf(IMPORT_SEPARATOR);
  return at < 0 ? id : id.slice(0, at);
};

export const installedRulesetIn = (dataDir: string, events: readonly CampaignEvent[]): InstalledRuleset | undefined => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  const pinned = saved.ok ? saved.config.rulepack : null;
  if (pinned === null || baseIdOf(pinned.id) === pinned.id) return undefined;
  const installed = loadInstalledRuleset(dataDir, pinned.id);
  const { edition, revision } = installed.manifest;
  if (edition !== pinned.edition || revision !== pinned.revision)
    throw rejected(pinned.id, 'its edition or revision differs from the campaign pin');
  return installed;
};
