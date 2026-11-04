import { compileRule, deepFreeze } from '../../rules/src/compile.ts';
import { type EffectiveMechanic, GM_ADJUDICATED, type RuleDsl } from '../../rules/src/dsl.ts';
import type { ManifestIssue, RulePackManifest } from '../../rules/src/rulepack.ts';
import type { ResolvedEntry, ResolvedLayers } from './layer-precedence.ts';

const PACK_KEYS = ['id', 'edition', 'revision'] as const;
const ADJUDICATED_CAPABILITY = 'AdjudicatedCapability';

export type MechanicsResult =
  | { ok: true; mechanics: readonly EffectiveMechanic[] }
  | { ok: false; error: { code: 'RulePackMismatch'; issues: ManifestIssue[] } };

const toMechanic = (entry: ResolvedEntry, manifest: RulePackManifest): EffectiveMechanic => {
  const { id, edition, revision } = manifest;
  const base = { ruleId: entry.id, rulePack: { id, edition, revision }, source: entry.source };
  const compiled = compileRule({
    rule: entry.value as RuleDsl,
    rulePack: manifest,
    sourceRefs: [entry.source.sourceRef],
  });
  if (!compiled.ok)
    return { ...base, kind: GM_ADJUDICATED, reason: compiled.error.code, issues: compiled.error.issues };
  if (compiled.rule.deterministic) return { ...base, kind: 'deterministic', rule: compiled.rule };
  const issues = compiled.rule.adjudicated.map((primitive) => ({
    path: `capabilities.${primitive}`,
    message: `is adjudicated in rule pack ${id}`,
  }));
  return { ...base, kind: GM_ADJUDICATED, reason: ADJUDICATED_CAPABILITY, issues };
};

export const effectiveMechanics = (resolved: ResolvedLayers, manifest: RulePackManifest): MechanicsResult => {
  const issues = PACK_KEYS.flatMap((key) =>
    manifest[key] === resolved.rulePack[key]
      ? []
      : [{ path: `rulePack.${key}`, message: `must be ${resolved.rulePack[key]}` }],
  );
  if (issues.length > 0) return { ok: false, error: { code: 'RulePackMismatch', issues } };
  return { ok: true, mechanics: deepFreeze(resolved.entries.map((entry) => toMechanic(entry, manifest))) };
};
