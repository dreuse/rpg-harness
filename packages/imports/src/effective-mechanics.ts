import { compileRule, deepFreeze } from '../../rules/src/compile.ts';
import { type CompiledRule, type EffectiveMechanic, GM_ADJUDICATED, type RuleDsl } from '../../rules/src/dsl.ts';
import type { ManifestIssue, RulePackManifest } from '../../rules/src/rulepack.ts';
import type { EffectiveRules } from './house-rules.ts';
import type { ResolvedEntry, ResolvedLayers } from './layer-precedence.ts';

const PACK_KEYS = ['id', 'edition', 'revision'] as const;
const ADJUDICATED_CAPABILITY = 'AdjudicatedCapability';
const RULEPACK_SOURCE = 'rulepack';
const HOUSE_RULE_SOURCE = 'house_rule';

export type MechanicsResult =
  | { ok: true; mechanics: readonly EffectiveMechanic[] }
  | { ok: false; error: { code: 'RulePackMismatch'; issues: ManifestIssue[] } };

type MechanicBase = Pick<EffectiveMechanic, 'ruleId' | 'rulePack' | 'source'>;

const compiledMechanic = (base: MechanicBase, rule: CompiledRule): EffectiveMechanic => {
  if (rule.deterministic) return { ...base, kind: 'deterministic', rule };
  const issues = rule.adjudicated.map((primitive) => ({
    path: `capabilities.${primitive}`,
    message: `is adjudicated in rule pack ${base.rulePack.id}`,
  }));
  return { ...base, kind: GM_ADJUDICATED, reason: ADJUDICATED_CAPABILITY, issues };
};

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
  return compiledMechanic(base, compiled.rule);
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

export const houseRuleMechanics = (effective: EffectiveRules): readonly EffectiveMechanic[] => {
  const { overlayHash, depth } = effective.version;
  return effective.rules.map((rule) => {
    const sourceRef = rule.sourceRefs[0] as string;
    const layered = effective.layers.some(({ sourceHash }) => sourceHash === sourceRef);
    const kind = layered ? HOUSE_RULE_SOURCE : RULEPACK_SOURCE;
    const source = { kind, sourceRef, revision: effective.rulePack.revision, overlayHash, depth };
    return compiledMechanic({ ruleId: rule.rule.id, rulePack: rule.rulePack, source }, rule);
  });
};
