import type { CharacterId } from '../../domain/src/campaign.ts';
import { isNonEmptyString, isRecord, type ManifestIssue, NON_EMPTY_STRING } from './rulepack.ts';

export const TRAIT_KINDS = ['trait', 'resource', 'tag', 'condition', 'derived'] as const;
export const DERIVED_OPS = ['sum', 'min', 'max'] as const;

export type TraitKind = (typeof TRAIT_KINDS)[number];
export type DerivedOp = (typeof DERIVED_OPS)[number];
export type TraitValue = string | number | boolean;

export type Trait =
  | { id: string; kind: 'trait'; value: TraitValue }
  | { id: string; kind: 'resource'; current: number; max: number }
  | { id: string; kind: 'tag' }
  | { id: string; kind: 'condition'; stacks?: number; remaining?: number }
  | { id: string; kind: 'derived'; op: DerivedOp; refs: string[]; offset: number };

export type TraitSheet = { characterId: CharacterId; traits: Trait[] };
export type TraitSheetResult = { ok: true; sheet: TraitSheet } | { ok: false; issues: ManifestIssue[] };

const FINITE_NUMBER = 'must be a finite number';
export const POSITIVE_INTEGER = 'must be a positive integer';
const CONDITION_COUNTERS = ['stacks', 'remaining'] as const;

export const isPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isTraitValue = (value: unknown): value is TraitValue =>
  typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

const isRefList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const parseTrait = (input: Record<string, unknown>, path: string, issues: ManifestIssue[]): Trait => {
  const at = (key: string, message: string) => issues.push({ path: `${path}.${key}`, message });
  const { id, kind, value, current, max, op, refs, offset } = input;
  if (!isNonEmptyString(id)) at('id', NON_EMPTY_STRING);
  const base = { id: id as string };
  switch (kind) {
    case 'trait':
      if (!isTraitValue(value)) at('value', 'must be a string, boolean or finite number');
      return { ...base, kind, value: value as TraitValue };
    case 'resource':
      if (!isFiniteNumber(current)) at('current', FINITE_NUMBER);
      if (!isFiniteNumber(max)) at('max', FINITE_NUMBER);
      else if (isFiniteNumber(current) && current > max) at('current', 'must not exceed max');
      return { ...base, kind, current: current as number, max: max as number };
    case 'tag':
      return { ...base, kind };
    case 'condition': {
      const counters = CONDITION_COUNTERS.filter((key) => Object.hasOwn(input, key));
      for (const key of counters) if (!isPositiveInteger(input[key])) at(key, POSITIVE_INTEGER);
      return { ...base, kind, ...Object.fromEntries(counters.map((key) => [key, input[key]])) };
    }
    case 'derived':
      if (!isOneOf(DERIVED_OPS, op)) at('op', `must be one of ${DERIVED_OPS.join(', ')}`);
      if (!isRefList(refs)) at('refs', 'must be a non-empty array of trait ids');
      if (!isFiniteNumber(offset)) at('offset', FINITE_NUMBER);
      return { ...base, kind, op: op as DerivedOp, refs: isRefList(refs) ? [...refs] : [], offset: offset as number };
    default:
      at('kind', `must be one of ${TRAIT_KINDS.join(', ')}`);
      return { ...base, kind: 'tag' };
  }
};

const isNumeric = (trait: Trait | undefined) =>
  trait !== undefined &&
  (trait.kind === 'resource' || trait.kind === 'derived' || (trait.kind === 'trait' && isFiniteNumber(trait.value)));

const derivedRefs = (trait: Trait | undefined) => (trait?.kind === 'derived' ? trait.refs : []);

const reachesSelf = (start: string, byId: Map<string, Trait>) => {
  const seen = new Set<string>();
  const pending = [...derivedRefs(byId.get(start))];
  while (pending.length > 0) {
    const next = pending.pop() as string;
    if (next === start) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...derivedRefs(byId.get(next)));
  }
  return false;
};

const referenceIssues = (traits: Trait[]): ManifestIssue[] => {
  const issues: ManifestIssue[] = [];
  const byId = new Map<string, Trait>();
  traits.forEach((trait, index) => {
    if (byId.has(trait.id)) issues.push({ path: `traits.${index}.id`, message: 'must be unique' });
    else byId.set(trait.id, trait);
  });
  traits.forEach((trait, index) => {
    if (trait.kind !== 'derived') return;
    trait.refs.forEach((ref, refIndex) => {
      const path = `traits.${index}.refs.${refIndex}`;
      if (!byId.has(ref)) issues.push({ path, message: 'must reference a declared trait' });
      else if (!isNumeric(byId.get(ref))) issues.push({ path, message: 'must reference a numeric trait' });
    });
    if (reachesSelf(trait.id, byId)) issues.push({ path: `traits.${index}.refs`, message: 'must not form a cycle' });
  });
  return issues;
};

export const validateTraitSheet = (input: unknown): TraitSheetResult => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  const { characterId, traits } = input;
  const issues: ManifestIssue[] = [];
  if (!isNonEmptyString(characterId)) issues.push({ path: 'characterId', message: NON_EMPTY_STRING });
  if (!Array.isArray(traits)) issues.push({ path: 'traits', message: 'must be an array' });
  const parsed: Trait[] = [];
  (Array.isArray(traits) ? traits : []).forEach((trait: unknown, index) => {
    if (isRecord(trait)) parsed.push(parseTrait(trait, `traits.${index}`, issues));
    else issues.push({ path: `traits.${index}`, message: 'must be an object' });
  });
  if (issues.length > 0) return { ok: false, issues };
  const references = referenceIssues(parsed);
  if (references.length > 0) return { ok: false, issues: references };
  return { ok: true, sheet: { characterId: characterId as CharacterId, traits: parsed } };
};

const APPLY: Record<DerivedOp, (values: number[]) => number> = {
  sum: (values) => values.reduce((total, value) => total + value, 0),
  min: (values) => Math.min(...values),
  max: (values) => Math.max(...values),
};

export const resolveDerived = (sheet: TraitSheet): Record<string, number> => {
  const byId = new Map(sheet.traits.map((trait) => [trait.id, trait]));
  const resolved = new Map<string, number>();
  const numberFor = (id: string): number => {
    const trait = byId.get(id);
    if (trait?.kind === 'resource') return trait.current;
    if (trait?.kind === 'trait') return trait.value as number;
    if (trait?.kind !== 'derived') return Number.NaN;
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    const result = APPLY[trait.op](trait.refs.map(numberFor)) + trait.offset;
    resolved.set(id, result);
    return result;
  };
  for (const trait of sheet.traits) if (trait.kind === 'derived') numberFor(trait.id);
  return Object.fromEntries(resolved);
};
