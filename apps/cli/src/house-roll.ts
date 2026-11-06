import type { EffectiveRulesVersion } from '../../../packages/engine/src/turn.ts';
import { applyHouseRule, baseEffectiveRules } from '../../../packages/imports/src/house-rules.ts';
import { compileRule } from '../../../packages/rules/src/compile.ts';
import type { CompiledRule, RuleDsl } from '../../../packages/rules/src/dsl.ts';
import type { RulePackManifest } from '../../../packages/rules/src/rulepack.ts';

export type StoredHouseRules = readonly Readonly<Record<string, unknown>>[];
export type RollTable = { readonly table: RuleDsl[]; readonly version?: EffectiveRulesVersion };

export const NO_HOUSE_RULES: StoredHouseRules = [];
const NO_STORED_RULES: readonly CompiledRule[] = [];
const unbuildable = (id: string) => new Error(`Installed ruleset ${id} cannot build its roll table.`);
const BUILT_IN_TABLE_SOURCE = 'built-in-table';

export const rollTableOf = (
  pack: RulePackManifest,
  table: readonly RuleDsl[],
  houseRules: StoredHouseRules,
  installedRules?: readonly CompiledRule[],
): RollTable => {
  const stored = installedRules ?? NO_STORED_RULES;
  const unchanged = { table: [...table] };
  if (houseRules.length === 0 && installedRules === undefined) return unchanged;
  const compiled = table.map((rule) => compileRule({ rule, rulePack: pack, sourceRefs: [BUILT_IN_TABLE_SOURCE] }));
  const tableRules = compiled.flatMap((result) => (result.ok ? [result.rule] : []));
  const base = baseEffectiveRules(pack, [
    ...tableRules.filter(({ rule }) => !stored.some((own) => own.rule.id === rule.id)),
    ...stored,
  ]);
  if (!base.ok || compiled.some(({ ok }) => !ok)) {
    if (installedRules !== undefined) throw unbuildable(pack.id);
    return unchanged;
  }
  let { effective } = base;
  for (const input of houseRules) {
    const next = applyHouseRule(effective, input);
    if (next.ok) effective = next.effective;
  }
  if (effective.version.depth === 0 && installedRules === undefined) return unchanged;
  return {
    table: table.map((rule) => {
      const replacement = effective.rules.find((candidate) => candidate.rule.id === rule.id);
      return replacement?.deterministic === true ? replacement.rule : rule;
    }),
    version: effective.version,
  };
};
