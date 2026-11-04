import type { EventId } from '../../domain/src/campaign.ts';
import type { RulePackLink } from '../../domain/src/character.ts';
import type { Rng, TrustedRoll } from './dice.ts';
import { type CapabilityDisabled, isBounded, MAX_DSL_VALUE, parseRuleDsl, type RuleDsl } from './dsl.ts';
import { type ResolutionErrorCode, resolveAction, type TraitChange } from './resolve.ts';
import { isNonEmptyString, isRecord, type ManifestIssue, NON_EMPTY_STRING } from './rulepack.ts';
import { isPositiveInteger, POSITIVE_INTEGER, type Trait, type TraitSheet } from './traits.ts';

export const STACKING_POLICIES = ['stack', 'replace', 'highest'] as const;
export const MECHANIC_EVENTS = {
  applied: 'effect.applied',
  stacked: 'effect.stacked',
  refreshed: 'effect.refreshed',
  replaced: 'effect.replaced',
  expired: 'effect.expired',
  ended: 'effect.ended',
  died: 'character.died',
  resurrected: 'character.resurrected',
  gained: 'progression.gained',
  levelled: 'progression.levelled',
} as const;

export type StackingPolicy = (typeof STACKING_POLICIES)[number];
export type EffectDefinition = Readonly<{
  modifiers: Readonly<Record<string, number>>;
  stacking: StackingPolicy;
  group?: string;
  duration?: number;
}>;
export type RecoveryDefinition = Readonly<{ rule: RuleDsl; clears: readonly string[] }>;
export type Resurrection = Readonly<{ restore: number; clears: readonly string[] }>;
export type MortalityDefinition = Readonly<{
  resource: string;
  threshold: number;
  condition: string;
  resurrection?: Resurrection;
}>;
export type ProgressionDefinition = Readonly<{
  xp: string;
  level: string;
  firstLevel: number;
  thresholds: readonly number[];
}>;
export type CharacterMechanics = Readonly<{
  rulepack: RulePackLink;
  effects: Readonly<Record<string, EffectDefinition>>;
  recovery: Readonly<Record<string, RecoveryDefinition>>;
  mortality?: MortalityDefinition;
  progression?: ProgressionDefinition;
}>;
export type MechanicsResult = { ok: true; mechanics: CharacterMechanics } | { ok: false; issues: ManifestIssue[] };

export type MechanicEvent = Readonly<{ event: string; subject: string; cause: EventId; rulepack: RulePackLink }>;
export type MechanicError = { code: ResolutionErrorCode; issues: ManifestIssue[] } | CapabilityDisabled;
export type MechanicResult =
  | { ok: true; sheet: TraitSheet; changes: TraitChange[]; events: MechanicEvent[]; rolls: TrustedRoll[] }
  | { ok: false; error: MechanicError; rolls: TrustedRoll[] };
export type MechanicInput = { sheet: TraitSheet; mechanics: CharacterMechanics; cause: EventId };

type ConditionTrait = Extract<Trait, { kind: 'condition' }>;
type Outcome = { sheet: TraitSheet; events: MechanicEvent[] };

const OBJECT = 'must be an object';
const ARRAY = 'must be an array';
const BOUNDED = `must be a finite number within ±${MAX_DSL_VALUE}`;
const NOT_DECLARED = 'is not declared by the rulepack';
const RULEPACK_KEYS = ['id', 'edition', 'revision'] as const;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);

const declaredIn = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const failWith = (code: MechanicError['code'], path: string, message: string): MechanicResult =>
  ({ ok: false, error: { code, issues: [{ path, message }] }, rolls: [] }) as MechanicResult;

const disabled = (path: string) => failWith('CapabilityDisabled', path, NOT_DECLARED);

const succeed = (sheet: TraitSheet, events: MechanicEvent[], changes: TraitChange[] = [], rolls: TrustedRoll[] = []) =>
  ({ ok: true, sheet, changes, events, rolls }) as MechanicResult;

const emit = ({ cause, mechanics }: MechanicInput, event: string, subject: string): MechanicEvent => ({
  event,
  subject,
  cause,
  rulepack: mechanics.rulepack,
});

const withCause =
  <T extends MechanicInput>(run: (input: T) => MechanicResult) =>
  (input: T): MechanicResult =>
    isNonEmptyString(input.cause) ? run(input) : failWith('InvalidAction', 'cause', NON_EMPTY_STRING);

const conditionOf = (sheet: TraitSheet, id: string) =>
  sheet.traits.find((trait): trait is ConditionTrait => trait.id === id && trait.kind === 'condition');

const replaceTrait = (sheet: TraitSheet, next: Trait): TraitSheet => ({
  ...sheet,
  traits: sheet.traits.map((trait) => (trait.id === next.id ? next : trait)),
});

const withoutConditions = (sheet: TraitSheet, ids: readonly string[]): TraitSheet => ({
  ...sheet,
  traits: sheet.traits.filter((trait) => trait.kind !== 'condition' || !ids.includes(trait.id)),
});

const endConditions = (input: MechanicInput, sheet: TraitSheet, ids: readonly string[], event: string): Outcome => {
  const active = ids.filter((id) => conditionOf(sheet, id) !== undefined);
  return { sheet: withoutConditions(sheet, active), events: active.map((id) => emit(input, event, id)) };
};

const groupOf = (definition: EffectDefinition, id: string) => definition.group ?? id;

export const applyTimedEffect = withCause((input: MechanicInput & { effectId: string }) => {
  const { sheet, mechanics, effectId } = input;
  const definition = declaredIn(mechanics.effects, effectId);
  if (definition === undefined) return disabled(`effects.${effectId}`);
  const timer = definition.duration === undefined ? {} : { remaining: definition.duration };
  const stacks = definition.stacking === 'stack';
  const existing = conditionOf(sheet, effectId);
  if (existing !== undefined) {
    const next = { ...existing, ...timer, ...(stacks ? { stacks: (existing.stacks ?? 1) + 1 } : {}) };
    return succeed(replaceTrait(sheet, next), [
      emit(input, stacks ? MECHANIC_EVENTS.stacked : MECHANIC_EVENTS.refreshed, effectId),
    ]);
  }
  if (sheet.traits.some((trait) => trait.id === effectId))
    return failWith('PreconditionFailed', effectId, 'is already present');
  const group = groupOf(definition, effectId);
  const rivals =
    definition.stacking === 'replace'
      ? sheet.traits
          .filter(({ id, kind }) => kind === 'condition' && id !== effectId)
          .filter(({ id }) => {
            const other = declaredIn(mechanics.effects, id);
            return other !== undefined && groupOf(other, id) === group;
          })
          .map(({ id }) => id)
      : [];
  const replaced = endConditions(input, sheet, rivals, MECHANIC_EVENTS.replaced);
  const added: ConditionTrait = { id: effectId, kind: 'condition', ...(stacks ? { stacks: 1 } : {}), ...timer };
  return succeed({ ...replaced.sheet, traits: [...replaced.sheet.traits, added] }, [
    ...replaced.events,
    emit(input, MECHANIC_EVENTS.applied, effectId),
  ]);
});

export const effectModifiers = (sheet: TraitSheet, mechanics: CharacterMechanics): Record<string, number> => {
  const groups = new Map<string, Map<string, number>>();
  for (const trait of sheet.traits) {
    const definition = trait.kind === 'condition' ? declaredIn(mechanics.effects, trait.id) : undefined;
    if (trait.kind !== 'condition' || definition === undefined) continue;
    const group = groupOf(definition, trait.id);
    const totals = groups.get(group) ?? new Map<string, number>();
    groups.set(group, totals);
    for (const [key, value] of Object.entries(definition.modifiers)) {
      const scaled = value * (trait.stacks ?? 1);
      const prior = totals.get(key);
      totals.set(
        key,
        prior !== undefined && definition.stacking === 'highest' ? Math.max(prior, scaled) : (prior ?? 0) + scaled,
      );
    }
  }
  const result = new Map<string, number>();
  for (const totals of groups.values())
    for (const [key, value] of totals) result.set(key, (result.get(key) ?? 0) + value);
  return Object.fromEntries(result);
};

export const advanceEffects = withCause((input: MechanicInput) => {
  const ticked = input.sheet.traits.map((trait) =>
    trait.kind === 'condition' && trait.remaining !== undefined ? { ...trait, remaining: trait.remaining - 1 } : trait,
  );
  const expired = ticked.filter((trait) => trait.kind === 'condition' && trait.remaining === 0).map(({ id }) => id);
  const outcome = endConditions(input, { ...input.sheet, traits: ticked }, expired, MECHANIC_EVENTS.expired);
  return succeed(outcome.sheet, outcome.events);
});

const isDead = (sheet: TraitSheet, mechanics: CharacterMechanics) =>
  mechanics.mortality !== undefined && conditionOf(sheet, mechanics.mortality.condition) !== undefined;

export const recover = withCause((input: MechanicInput & { kind: string; rng: Rng }) => {
  const { sheet, mechanics, cause, kind, rng } = input;
  const definition = declaredIn(mechanics.recovery, kind);
  if (definition === undefined) return disabled(`recovery.${kind}`);
  if (isDead(sheet, mechanics))
    return failWith('PreconditionFailed', mechanics.mortality?.condition ?? kind, 'must not be active');
  const resolved = resolveAction({ actionId: cause, rule: definition.rule, sheet, rng });
  if (!resolved.ok) return { ok: false, error: resolved.error, rolls: resolved.rolls };
  const cleared = endConditions(input, resolved.sheet, definition.clears, MECHANIC_EVENTS.ended);
  const events = [...resolved.events.map(({ event }) => emit(input, event, kind)), ...cleared.events];
  return succeed(cleared.sheet, events, resolved.changes, resolved.rolls);
});

const resourceOf = (sheet: TraitSheet, id: string) =>
  sheet.traits.find(
    (trait): trait is Extract<Trait, { kind: 'resource' }> => trait.id === id && trait.kind === 'resource',
  );

const missing = (id: string, kind: string) => failWith('UnknownReference', id, `must reference a ${kind}`);

export const checkMortality = withCause((input: MechanicInput) => {
  const { sheet, mechanics } = input;
  const { mortality } = mechanics;
  if (mortality === undefined) return succeed(sheet, []);
  const resource = resourceOf(sheet, mortality.resource);
  if (resource === undefined) return missing(mortality.resource, 'resource');
  if (isDead(sheet, mechanics) || resource.current > mortality.threshold) return succeed(sheet, []);
  if (sheet.traits.some(({ id }) => id === mortality.condition))
    return failWith('PreconditionFailed', mortality.condition, 'is already present');
  const fallen: ConditionTrait = { id: mortality.condition, kind: 'condition' };
  return succeed({ ...sheet, traits: [...sheet.traits, fallen] }, [
    emit(input, MECHANIC_EVENTS.died, mortality.condition),
  ]);
});

export const resurrect = withCause((input: MechanicInput) => {
  const { sheet, mechanics } = input;
  const { mortality } = mechanics;
  if (mortality?.resurrection === undefined) return disabled('mortality.resurrection');
  if (!isDead(sheet, mechanics)) return failWith('PreconditionFailed', mortality.condition, 'must be active');
  const resource = resourceOf(sheet, mortality.resource);
  if (resource === undefined) return missing(mortality.resource, 'resource');
  const current = Math.min(mortality.resurrection.restore, resource.max);
  if (current <= mortality.threshold)
    return failWith('PreconditionFailed', mortality.resource, 'must be able to rise above the threshold');
  const revived = withoutConditions(replaceTrait(sheet, { ...resource, current }), [mortality.condition]);
  const cleared = endConditions(input, revived, mortality.resurrection.clears, MECHANIC_EVENTS.ended);
  return succeed(
    cleared.sheet,
    [emit(input, MECHANIC_EVENTS.resurrected, mortality.condition), ...cleared.events],
    [{ id: resource.id, from: resource.current, to: current }].filter(({ from, to }) => from !== to),
  );
});

const numericTrait = (sheet: TraitSheet, id: string) =>
  sheet.traits.find(
    (trait): trait is Extract<Trait, { kind: 'trait' }> & { value: number } =>
      trait.id === id && trait.kind === 'trait' && typeof trait.value === 'number',
  );

export const gainProgress = withCause((input: MechanicInput & { amount: number }) => {
  const { sheet, mechanics, amount } = input;
  const { progression } = mechanics;
  if (progression === undefined) return disabled('progression');
  if (!Number.isSafeInteger(amount) || amount < 0)
    return failWith('InvalidAmount', 'amount', 'must be a non-negative integer');
  const xpTrait = numericTrait(sheet, progression.xp);
  const levelTrait = numericTrait(sheet, progression.level);
  if (xpTrait === undefined) return missing(progression.xp, 'numeric trait');
  if (levelTrait === undefined) return missing(progression.level, 'numeric trait');
  const xp = xpTrait.value + amount;
  if (!Number.isSafeInteger(xp)) return failWith('InvalidAmount', 'progression.xp', 'must stay a safe integer');
  const reached = progression.firstLevel + progression.thresholds.filter((threshold) => xp >= threshold).length;
  const level = Math.max(levelTrait.value, reached);
  const changes = [
    { id: xpTrait.id, from: xpTrait.value, to: xp },
    { id: levelTrait.id, from: levelTrait.value, to: level },
  ].filter(({ from, to }) => from !== to);
  const events = [
    ...(amount > 0 ? [emit(input, MECHANIC_EVENTS.gained, progression.xp)] : []),
    ...(level > levelTrait.value ? [emit(input, MECHANIC_EVENTS.levelled, progression.level)] : []),
  ];
  const next = replaceTrait(replaceTrait(sheet, { ...xpTrait, value: xp }), { ...levelTrait, value: level });
  return succeed(next, events, changes);
});

type At = (path: string, message: string) => void;

const stringList = (value: unknown, path: string, at: At): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    at(path, ARRAY);
    return [];
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) at(`${path}.${index}`, NON_EMPTY_STRING);
  });
  return [...value];
};

const recordEntries = (value: unknown, path: string, at: At): [string, unknown][] => {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    at(path, OBJECT);
    return [];
  }
  return Object.entries(value);
};

const parseEffect = (id: string, input: unknown, at: At, policies: Map<string, unknown>) => {
  const path = `effects.${id}`;
  if (!isRecord(input)) return at(path, OBJECT);
  const { modifiers, stacking, group, duration } = input;
  const entries = recordEntries(modifiers, `${path}.modifiers`, at);
  if (modifiers === undefined) at(`${path}.modifiers`, OBJECT);
  for (const [key, value] of entries) if (!isBounded(value)) at(`${path}.modifiers.${key}`, BOUNDED);
  if (!isOneOf(STACKING_POLICIES, stacking)) at(`${path}.stacking`, `must be one of ${STACKING_POLICIES.join(', ')}`);
  if (group !== undefined && !isNonEmptyString(group)) at(`${path}.group`, NON_EMPTY_STRING);
  if (duration !== undefined && !isPositiveInteger(duration)) at(`${path}.duration`, POSITIVE_INTEGER);
  const key = isNonEmptyString(group) ? group : id;
  if (policies.has(key) && policies.get(key) !== stacking) at(`${path}.group`, 'must share one stacking policy');
  policies.set(key, policies.get(key) ?? stacking);
  return {
    modifiers: Object.fromEntries(entries),
    stacking,
    ...(group === undefined ? {} : { group }),
    ...(duration === undefined ? {} : { duration }),
  };
};

const parseRecovery = (kind: string, input: unknown, at: At) => {
  const path = `recovery.${kind}`;
  if (!isRecord(input)) return at(path, OBJECT);
  const parsed = parseRuleDsl(input.rule);
  if (!parsed.ok)
    for (const issue of parsed.error.issues)
      at(issue.path === '' ? `${path}.rule` : `${path}.rule.${issue.path}`, issue.message);
  return { rule: parsed.ok ? parsed.rule : input.rule, clears: stringList(input.clears, `${path}.clears`, at) };
};

const parseMortality = (input: unknown, at: At, effectIds: readonly string[]) => {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return at('mortality', OBJECT);
  const { resource, threshold, condition, resurrection } = input;
  if (!isNonEmptyString(resource)) at('mortality.resource', NON_EMPTY_STRING);
  if (!isBounded(threshold)) at('mortality.threshold', BOUNDED);
  if (!isNonEmptyString(condition)) at('mortality.condition', NON_EMPTY_STRING);
  else if (effectIds.includes(condition)) at('mortality.condition', 'must not be a declared effect id');
  const base = { resource, threshold, condition };
  if (resurrection === undefined) return base;
  if (!isRecord(resurrection)) return at('mortality.resurrection', OBJECT);
  const { restore } = resurrection;
  if (!isBounded(restore) || !isBounded(threshold) || restore <= threshold)
    at('mortality.resurrection.restore', 'must be a bounded number above the threshold');
  return {
    ...base,
    resurrection: { restore, clears: stringList(resurrection.clears, 'mortality.resurrection.clears', at) },
  };
};

const isAscending = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item, index) => isPositiveInteger(item) && (index === 0 || item > value[index - 1]));

const parseProgression = (input: unknown, at: At) => {
  if (input === undefined) return undefined;
  if (!isRecord(input)) return at('progression', OBJECT);
  const { xp, level, firstLevel, thresholds } = input;
  if (!isNonEmptyString(xp)) at('progression.xp', NON_EMPTY_STRING);
  if (!isNonEmptyString(level)) at('progression.level', NON_EMPTY_STRING);
  else if (level === xp) at('progression.level', 'must differ from progression.xp');
  if (!Number.isSafeInteger(firstLevel)) at('progression.firstLevel', 'must be an integer');
  if (!isAscending(thresholds)) at('progression.thresholds', 'must be a non-empty ascending list of positive integers');
  return { xp, level, firstLevel, thresholds: Array.isArray(thresholds) ? [...thresholds] : [] };
};

export const validateMechanics = (input: unknown): MechanicsResult => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: OBJECT }] };
  const issues: ManifestIssue[] = [];
  const at: At = (path, message) => {
    issues.push({ path, message });
  };
  const { rulepack } = input;
  if (!isRecord(rulepack)) at('rulepack', OBJECT);
  else for (const key of RULEPACK_KEYS) if (!isNonEmptyString(rulepack[key])) at(`rulepack.${key}`, NON_EMPTY_STRING);
  const policies = new Map<string, unknown>();
  const effects = recordEntries(input.effects, 'effects', at).map(([id, value]) => [
    id,
    parseEffect(id, value, at, policies),
  ]);
  const recovery = recordEntries(input.recovery, 'recovery', at).map(([kind, value]) => [
    kind,
    parseRecovery(kind, value, at),
  ]);
  const mortality = parseMortality(
    input.mortality,
    at,
    effects.map(([id]) => id as string),
  );
  const progression = parseProgression(input.progression, at);
  if (issues.length > 0 || !isRecord(rulepack)) return { ok: false, issues };
  return {
    ok: true,
    mechanics: {
      rulepack: {
        id: rulepack.id as string,
        edition: rulepack.edition as string,
        revision: rulepack.revision as string,
      },
      effects: Object.fromEntries(effects),
      recovery: Object.fromEntries(recovery),
      ...(mortality === undefined ? {} : { mortality }),
      ...(progression === undefined ? {} : { progression }),
    } as CharacterMechanics,
  };
};
