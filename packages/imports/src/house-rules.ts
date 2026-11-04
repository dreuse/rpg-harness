import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compileRule, deepFreeze, runCompiledRule } from '../../rules/src/compile.ts';
import { type CapabilityDisabled, type CompiledRule, type InvalidRuleDsl, parseRuleDsl } from '../../rules/src/dsl.ts';
import type { ActionResolution } from '../../rules/src/resolve.ts';
import {
  isNonEmptyString,
  isRecord,
  type ManifestIssue,
  NON_EMPTY_STRING,
  type RulePackManifest,
} from '../../rules/src/rulepack.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import type { RulePackRef } from './preview.ts';

const HOUSE_RULE_KIND = 'house_rule';
const HOUSE_RULE_KEYS = ['id', 'source', 'rule'];
const SOURCE_KEYS = ['kind', 'author', 'note'];
const HASH_ALGORITHM = 'sha256';
const HASH_ENCODING = 'hex';
const PATH_SEPARATOR = '.';

export type HouseRuleSource = {
  readonly kind: typeof HOUSE_RULE_KIND;
  readonly author: string;
  readonly note: string;
};
export type HouseRule = { readonly id: string; readonly source: HouseRuleSource; readonly rule: unknown };

export type OverlayLayer = Readonly<{
  id: string;
  source: HouseRuleSource;
  sourceHash: string;
  replaced: boolean;
  rule: CompiledRule;
}>;
export type EffectiveVersion = Readonly<{ base: RulePackRef; depth: number; overlayHash: string }>;
export type EffectiveRules = Readonly<{
  rulePack: RulePackManifest;
  baseRules: readonly CompiledRule[];
  layers: readonly OverlayLayer[];
  rules: readonly CompiledRule[];
  version: EffectiveVersion;
}>;

export type HouseRuleErrorCode =
  | 'InvalidHouseRule'
  | 'DuplicateHouseRule'
  | 'RulePackMismatch'
  | 'NothingToUndo'
  | 'UnknownRule';
export type HouseRuleError =
  | { code: HouseRuleErrorCode; issues: ManifestIssue[] }
  | InvalidRuleDsl
  | CapabilityDisabled;
export type EffectiveResult = { ok: true; effective: EffectiveRules } | { ok: false; error: HouseRuleError };

export type RollRecord = Readonly<{
  version: EffectiveVersion;
  ruleId: string;
  actionId: string;
  seed: number;
  resolution: ActionResolution;
}>;
export type RollInput = { ruleId: string; actionId: string; sheet: TraitSheet; seed: number };

const hash = (value: unknown) => createHash(HASH_ALGORITHM).update(JSON.stringify(value)).digest(HASH_ENCODING);

const fail = (code: HouseRuleErrorCode, issues: ManifestIssue[] = []) => ({
  ok: false as const,
  error: { code, issues },
});

const overlay = (rules: readonly CompiledRule[], rule: CompiledRule) =>
  rules.some((existing) => existing.rule.id === rule.rule.id)
    ? rules.map((existing) => (existing.rule.id === rule.rule.id ? rule : existing))
    : [...rules, rule];

const compose = (
  rulePack: RulePackManifest,
  baseRules: readonly CompiledRule[],
  layers: readonly OverlayLayer[],
): EffectiveRules => {
  const base = { id: rulePack.id, edition: rulePack.edition, revision: rulePack.revision };
  return deepFreeze({
    rulePack,
    baseRules,
    layers,
    rules: layers.reduce((rules, layer) => overlay(rules, layer.rule), baseRules),
    version: {
      base,
      depth: layers.length,
      overlayHash: hash([
        base,
        baseRules.map(({ rule, sourceRefs }) => [rule, sourceRefs]),
        ...layers.map(({ sourceHash }) => sourceHash),
      ]),
    },
  });
};

export const baseEffectiveRules = (rulePack: RulePackManifest, rules: readonly CompiledRule[]): EffectiveResult => {
  const pinned = { id: rulePack.id, edition: rulePack.edition, revision: rulePack.revision };
  const issues = rules.flatMap(({ rule, rulePack: ref }, index) =>
    isDeepStrictEqual(ref, pinned)
      ? []
      : [
          {
            path: `rules.${index}.rulePack`,
            message: `${rule.id} is not pinned to ${pinned.id} revision ${pinned.revision}`,
          },
        ],
  );
  if (issues.length > 0) return fail('RulePackMismatch', issues);
  return { ok: true, effective: compose(structuredClone(rulePack), structuredClone(rules), []) };
};

const unknownKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string): ManifestIssue[] =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ path: path ? `${path}${PATH_SEPARATOR}${key}` : key, message: 'is not allowed' }));

const shapeIssues = (input: unknown): ManifestIssue[] => {
  if (!isRecord(input)) return [{ path: '', message: 'must be an object' }];
  const { id, source } = input;
  const issues = [
    ...unknownKeys(input, HOUSE_RULE_KEYS, ''),
    ...(isNonEmptyString(id) ? [] : [{ path: 'id', message: NON_EMPTY_STRING }]),
  ];
  if (!isRecord(source)) return [...issues, { path: 'source', message: 'must be an object' }];
  return [
    ...issues,
    ...unknownKeys(source, SOURCE_KEYS, 'source'),
    ...(source.kind === HOUSE_RULE_KIND ? [] : [{ path: 'source.kind', message: `must be '${HOUSE_RULE_KIND}'` }]),
    ...(isNonEmptyString(source.author) ? [] : [{ path: 'source.author', message: NON_EMPTY_STRING }]),
    ...(typeof source.note === 'string' ? [] : [{ path: 'source.note', message: 'must be a string' }]),
  ];
};

const cloneData = (input: unknown): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: structuredClone(input) };
  } catch {
    return { ok: false };
  }
};

export const applyHouseRule = (effective: EffectiveRules, input: unknown): EffectiveResult => {
  const cloned = cloneData(input);
  if (!cloned.ok) return fail('InvalidHouseRule', [{ path: '', message: 'must be plain data' }]);
  const issues = shapeIssues(cloned.value);
  if (issues.length > 0) return fail('InvalidHouseRule', issues);
  const { id, source, rule } = cloned.value as HouseRule;
  if (effective.layers.some((layer) => layer.id === id)) {
    return fail('DuplicateHouseRule', [{ path: 'id', message: `${id} is already applied` }]);
  }
  const parsed = parseRuleDsl(rule);
  if (!parsed.ok) return parsed;
  const sourceHash = hash({ id, source, rule: parsed.rule });
  const compiled = compileRule({ rule: parsed.rule, rulePack: effective.rulePack, sourceRefs: [sourceHash] });
  if (!compiled.ok) return compiled;
  const replaced = effective.rules.some((existing) => existing.rule.id === parsed.rule.id);
  const layer: OverlayLayer = { id, source, sourceHash, replaced, rule: compiled.rule };
  return { ok: true, effective: compose(effective.rulePack, effective.baseRules, [...effective.layers, layer]) };
};

export const undoHouseRule = (effective: EffectiveRules): EffectiveResult =>
  effective.layers.length === 0
    ? fail('NothingToUndo')
    : { ok: true, effective: compose(effective.rulePack, effective.baseRules, effective.layers.slice(0, -1)) };

export const recordRoll = (
  effective: EffectiveRules,
  { ruleId, actionId, sheet, seed }: RollInput,
): { ok: true; record: RollRecord } | { ok: false; error: HouseRuleError } => {
  const compiled = effective.rules.find(({ rule }) => rule.id === ruleId);
  if (!compiled) return fail('UnknownRule', [{ path: 'ruleId', message: `${ruleId} is not an effective rule` }]);
  const resolution = runCompiledRule(compiled, { actionId, sheet, seed });
  return {
    ok: true,
    record: deepFreeze(structuredClone({ version: effective.version, ruleId, actionId, seed, resolution })),
  };
};
