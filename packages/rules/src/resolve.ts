import {
  RESOLUTION_ERROR_CODES,
  type ResolutionError,
  type ResolutionErrorCode,
  type RuleEvent,
  type TraitChange,
} from '../../domain/src/rule-shapes.ts';
import { createRoller, type Rng, type TrustedRoll } from './dice.ts';
import { type Condition, MAX_DSL_VALUE, type NumberExpr, parseRuleDsl, type RuleDsl, type RuleEffect } from './dsl.ts';
import { isNonEmptyString, isRecord, type ManifestIssue, NON_EMPTY_STRING } from './rulepack.ts';
import { resolveDerived, type Trait, type TraitSheet, type TraitValue, validateTraitSheet } from './traits.ts';

export { RESOLUTION_ERROR_CODES, type ResolutionError, type ResolutionErrorCode, type RuleEvent, type TraitChange };
export type ActionInput = {
  actionId: string;
  rule: unknown;
  sheet: TraitSheet;
  rng: Rng;
  modifiers?: Readonly<Record<string, number>>;
};
export type ActionResolution =
  | { ok: true; sheet: TraitSheet; changes: TraitChange[]; events: RuleEvent[]; rolls: TrustedRoll[] }
  | { ok: false; error: ResolutionError; rolls: TrustedRoll[] };

class ResolutionFailure extends Error {
  readonly error: ResolutionError;
  constructor(code: ResolutionErrorCode, path: string, message: string) {
    super(message);
    this.error = { code, issues: [{ path, message }] };
  }
}

const fail = (code: ResolutionErrorCode, path: string, message: string): never => {
  throw new ResolutionFailure(code, path, message);
};

const ROLL_SEPARATOR = ':roll:';

const ARITH = {
  add: (left: number, right: number) => left + right,
  sub: (left: number, right: number) => left - right,
  mul: (left: number, right: number) => left * right,
  min: Math.min,
  max: Math.max,
};

const COMPARE = {
  eq: (left: number, right: number) => left === right,
  ne: (left: number, right: number) => left !== right,
  lt: (left: number, right: number) => left < right,
  lte: (left: number, right: number) => left <= right,
  gt: (left: number, right: number) => left > right,
  gte: (left: number, right: number) => left >= right,
};

type Transaction = {
  actionId: string;
  characterId: TraitSheet['characterId'];
  rule: RuleDsl;
  traits: Map<string, Trait>;
  modifiers: Readonly<Record<string, number>>;
  roll: ReturnType<typeof createRoller>;
  rolls: TrustedRoll[];
  changes: TraitChange[];
  events: RuleEvent[];
};

const lookup = (tx: Transaction, id: string, path: string): number => {
  const trait = tx.traits.get(id);
  const hasModifier = Object.hasOwn(tx.modifiers, id);
  if (trait !== undefined && hasModifier) return fail('UnknownReference', path, `${id} is ambiguous`);
  if (hasModifier) return tx.modifiers[id] as number;
  if (trait?.kind === 'resource') return trait.current;
  if (trait?.kind === 'trait' && typeof trait.value === 'number') return trait.value;
  if (trait?.kind === 'derived') {
    return resolveDerived({ characterId: tx.characterId, traits: [...tx.traits.values()] })[id] as number;
  }
  return fail('UnknownReference', path, `${id} must reference a numeric trait or modifier`);
};

const rollDice = (tx: Transaction, expr: Extract<NumberExpr, { kind: 'dice' }>, path: string) => {
  const result = tx.roll(`${tx.actionId}${ROLL_SEPARATOR}${tx.rolls.length}`, {
    dice: [{ count: expr.count, sides: expr.sides }],
    modifier: expr.modifier,
  });
  if (!result.ok) return fail('RollFailed', path, result.issues.map((issue) => issue.message).join('; '));
  tx.rolls.push(result.roll);
  if (expr.keep === undefined) return result.roll.total;
  const sorted = [...result.roll.draws.flat()].sort((left, right) =>
    expr.keep?.which === 'highest' ? right - left : left - right,
  );
  return sorted.slice(0, expr.keep.count).reduce((sum, face) => sum + face, expr.modifier);
};

const compute = (tx: Transaction, expr: NumberExpr, path: string): number => {
  switch (expr.kind) {
    case 'const':
      return expr.value;
    case 'ref':
      return lookup(tx, expr.id, path);
    case 'dice':
      return rollDice(tx, expr, path);
    default:
      return ARITH[expr.op](evaluate(tx, expr.left, `${path}.left`), evaluate(tx, expr.right, `${path}.right`));
  }
};

const evaluate = (tx: Transaction, expr: NumberExpr, path: string): number => {
  const value = compute(tx, expr, path);
  return Number.isFinite(value) ? value : fail('InvalidAmount', path, 'must be a finite number');
};

const holds = (tx: Transaction, condition: Condition, path: string): boolean => {
  switch (condition.kind) {
    case 'compare':
      return COMPARE[condition.op](
        evaluate(tx, condition.left, `${path}.left`),
        evaluate(tx, condition.right, `${path}.right`),
      );
    case 'and':
      return condition.all.every((item, index) => holds(tx, item, `${path}.all.${index}`));
    case 'or':
      return condition.any.some((item, index) => holds(tx, item, `${path}.any.${index}`));
    default:
      return !holds(tx, condition.condition, `${path}.condition`);
  }
};

const record = (tx: Transaction, next: Trait, from: TraitValue, to: TraitValue) => {
  tx.traits.set(next.id, next);
  tx.changes.push({ id: next.id, from, to });
};

const adjust = (tx: Transaction, resource: string, delta: number, path: string) => {
  const trait = tx.traits.get(resource);
  if (trait?.kind !== 'resource') return fail('UnknownReference', path, `${resource} must reference a resource`);
  const current = Math.min(trait.current + delta, trait.max);
  if (delta < 0 && current < 0)
    return fail('InsufficientResource', path, `${resource} has ${trait.current}, needs ${-delta}`);
  record(tx, { ...trait, current }, trait.current, current);
};

const setTrait = (tx: Transaction, effect: Extract<RuleEffect, { kind: 'setTrait' }>, path: string) => {
  const trait = tx.traits.get(effect.trait);
  if (trait?.kind !== 'trait')
    return fail('UnknownReference', `${path}.trait`, `${effect.trait} must reference a trait`);
  const value = typeof effect.value === 'object' ? evaluate(tx, effect.value, `${path}.value`) : effect.value;
  record(tx, { ...trait, value }, trait.value, value);
};

const apply = (tx: Transaction, effect: RuleEffect, path: string) => {
  switch (effect.kind) {
    case 'adjustResource':
      return adjust(tx, effect.resource, evaluate(tx, effect.amount, `${path}.amount`), `${path}.resource`);
    case 'setTrait':
      return setTrait(tx, effect, path);
    default:
      tx.events.push({ actionId: tx.actionId, ruleId: tx.rule.id, event: effect.event });
  }
};

const execute = (tx: Transaction) => {
  const { when, costs = [], effects } = tx.rule;
  if (when !== undefined && !holds(tx, when, 'when')) fail('PreconditionFailed', 'when', 'precondition is not met');
  costs.forEach((cost, index) => {
    const path = `costs.${index}`;
    const amount = evaluate(tx, cost.amount, `${path}.amount`);
    if (amount < 0) fail('InvalidAmount', `${path}.amount`, 'must not be negative');
    adjust(tx, cost.resource, -amount, `${path}.resource`);
  });
  effects.forEach((effect, index) => {
    apply(tx, effect, `effects.${index}`);
  });
};

const BOUNDED_NUMBER = `must be a finite number within ±${MAX_DSL_VALUE}`;

const isBounded = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DSL_VALUE;

const modifierIssues = (modifiers: unknown): ManifestIssue[] => {
  if (modifiers === undefined) return [];
  if (!isRecord(modifiers)) return [{ path: 'modifiers', message: 'must be an object' }];
  return Reflect.ownKeys(modifiers).flatMap((key) => {
    const path = `modifiers.${String(key)}`;
    const descriptor = Object.getOwnPropertyDescriptor(modifiers, key);
    if (typeof key === 'symbol' || descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return [{ path, message: 'must be a plain data property' }];
    }
    return isBounded(descriptor.value) ? [] : [{ path, message: BOUNDED_NUMBER }];
  });
};

export const resolveAction = (input: ActionInput): ActionResolution => {
  const rule = parseRuleDsl(input.rule);
  const sheet = validateTraitSheet(input.sheet);
  const issues = [
    ...(isNonEmptyString(input.actionId) ? [] : [{ path: 'actionId', message: NON_EMPTY_STRING }]),
    ...(rule.ok ? [] : rule.error.issues),
    ...(sheet.ok ? [] : sheet.issues),
    ...modifierIssues(input.modifiers),
  ];
  if (!rule.ok || !sheet.ok || issues.length > 0) {
    return { ok: false, error: { code: 'InvalidAction', issues }, rolls: [] };
  }
  const tx: Transaction = {
    actionId: input.actionId,
    characterId: sheet.sheet.characterId,
    rule: rule.rule,
    traits: new Map(sheet.sheet.traits.map((trait) => [trait.id, trait])),
    modifiers: { ...input.modifiers },
    roll: createRoller(input.rng),
    rolls: [],
    changes: [],
    events: [],
  };
  try {
    execute(tx);
  } catch (failure) {
    if (failure instanceof ResolutionFailure) return { ok: false, error: failure.error, rolls: tx.rolls };
    throw failure;
  }
  const traits = sheet.sheet.traits.map((trait) => tx.traits.get(trait.id) as Trait);
  return {
    ok: true,
    sheet: { characterId: sheet.sheet.characterId, traits },
    changes: tx.changes,
    events: tx.events,
    rolls: tx.rolls,
  };
};
