import { isRecord, type ManifestIssue, type Primitive, type RulePackManifest } from './rulepack.ts';

export const RULE_DSL_VERSION = 1;
export const MAX_DSL_DEPTH = 16;
export const MAX_DSL_NODES = 256;
export const MAX_DSL_VALUE = 1_000_000;
export const MAX_DSL_TEXT_LENGTH = 256;
export const MIN_DICE_COUNT = 1;
export const MAX_DICE_COUNT = 100;
export const MIN_DICE_SIDES = 1;
export const MAX_DICE_SIDES = 1000;

export const ARITH_OPS = ['add', 'sub', 'mul', 'min', 'max'] as const;
export const COMPARE_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
export const KEEP_WHICH = ['highest', 'lowest'] as const;

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
const INVALID_RULE_DSL = 'InvalidRuleDsl';
const KIND = 'kind';

export type ArithOp = (typeof ARITH_OPS)[number];
export type CompareOp = (typeof COMPARE_OPS)[number];
export type KeepWhich = (typeof KEEP_WHICH)[number];

export type DiceKeep = { which: KeepWhich; count: number };

export type NumberExpr =
  | { kind: 'const'; value: number }
  | { kind: 'dice'; count: number; sides: number; modifier: number; keep?: DiceKeep }
  | { kind: 'ref'; id: string }
  | { kind: 'arith'; op: ArithOp; left: NumberExpr; right: NumberExpr };

export type Condition =
  | { kind: 'compare'; op: CompareOp; left: NumberExpr; right: NumberExpr }
  | { kind: 'and'; all: Condition[] }
  | { kind: 'or'; any: Condition[] }
  | { kind: 'not'; condition: Condition };

export type ResourceCost = { kind: 'cost'; resource: string; amount: NumberExpr };

export type RuleEffect =
  | { kind: 'adjustResource'; resource: string; amount: NumberExpr }
  | { kind: 'setTrait'; trait: string; value: string | boolean | NumberExpr }
  | { kind: 'emitEvent'; event: string };

export type RuleDsl = {
  dslVersion: typeof RULE_DSL_VERSION;
  id: string;
  when?: Condition;
  costs?: ResourceCost[];
  effects: RuleEffect[];
};

export type InvalidRuleDsl = { code: typeof INVALID_RULE_DSL; issues: ManifestIssue[] };
export type RuleDslResult = { ok: true; rule: RuleDsl } | { ok: false; error: InvalidRuleDsl };

export type RuleCompileInput = {
  rule: RuleDsl;
  rulePack: Pick<RulePackManifest, 'id' | 'edition' | 'revision' | 'capabilities'>;
  sourceRefs: string[];
};
export type CompiledRule = Readonly<{
  rule: RuleDsl;
  rulePack: Pick<RulePackManifest, 'id' | 'edition' | 'revision'>;
  sourceRefs: readonly string[];
  primitives: readonly Primitive[];
  adjudicated: readonly Primitive[];
  deterministic: boolean;
}>;
export type CapabilityDisabled = { code: 'CapabilityDisabled'; issues: ManifestIssue[] };
export const GM_ADJUDICATED = 'gm-adjudicated';
export type AdjudicationReason = 'AdjudicatedCapability' | CapabilityDisabled['code'] | InvalidRuleDsl['code'];
export type MechanicSource = Readonly<{ kind: string; sourceRef: string; revision: string }>;
export type EffectiveMechanic = Readonly<{
  ruleId: string;
  rulePack: CompiledRule['rulePack'];
  source: MechanicSource;
}> &
  (
    | Readonly<{ kind: 'deterministic'; rule: CompiledRule }>
    | Readonly<{ kind: typeof GM_ADJUDICATED; reason: AdjudicationReason; issues: readonly ManifestIssue[] }>
  );
export type CompileRule = (
  input: RuleCompileInput,
) => { ok: true; rule: CompiledRule } | { ok: false; error: InvalidRuleDsl | CapabilityDisabled };

const EXPR_KEYS = {
  const: ['value'],
  dice: ['count', 'sides', 'modifier', 'keep'],
  ref: ['id'],
  arith: ['op', 'left', 'right'],
};
const CONDITION_KEYS = { compare: ['op', 'left', 'right'], and: ['all'], or: ['any'], not: ['condition'] };
const EFFECT_KEYS = { adjustResource: ['resource', 'amount'], setTrait: ['trait', 'value'], emitEvent: ['event'] };
const COST_KEYS = { cost: ['resource', 'amount'] };
const RULE_KEYS = ['dslVersion', 'id', 'when', 'costs', 'effects'];
const KEEP_KEYS = ['which', 'count'];

type Fields = Record<string, unknown>;
type Context = { issues: ManifestIssue[]; nodes: number };

const join = (path: string, key: string | number) => (path ? `${path}.${key}` : `${key}`);
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.includes(value as T);
const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
export const isBounded = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DSL_VALUE;
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value);

const enter = (path: string, depth: number, context: Context) => {
  context.nodes += 1;
  if (context.nodes === MAX_DSL_NODES + 1) context.issues.push({ path, message: `exceeds ${MAX_DSL_NODES} nodes` });
  if (context.nodes > MAX_DSL_NODES) return false;
  if (depth <= MAX_DSL_DEPTH) return true;
  context.issues.push({ path, message: `exceeds depth ${MAX_DSL_DEPTH}` });
  return false;
};

const dataFields = (input: object, path: string, context: Context): Fields | undefined => {
  const fields: Fields = Object.create(null);
  let valid = true;
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key === 'symbol' || descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      context.issues.push({ path: join(path, String(key)), message: 'must be a plain data property' });
      valid = false;
    } else fields[key] = descriptor.value;
  }
  return valid ? fields : undefined;
};

const readNode = (
  input: unknown,
  path: string,
  depth: number,
  context: Context,
  shape: Record<string, string[]> | string[],
): Fields | undefined => {
  if (!enter(path, depth, context)) return undefined;
  if (!isRecord(input)) {
    context.issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const fields = dataFields(input, path, context);
  if (fields === undefined) return undefined;
  let allowed: string[];
  if (Array.isArray(shape)) allowed = shape;
  else {
    const kind = fields[KIND];
    if (typeof kind !== 'string' || !Object.hasOwn(shape, kind)) {
      context.issues.push({ path: join(path, KIND), message: `must be one of ${Object.keys(shape).join(', ')}` });
      return undefined;
    }
    allowed = [KIND, ...(shape[kind] as string[])];
  }
  const unknown = Object.keys(fields).filter((key) => !allowed.includes(key));
  for (const key of unknown) context.issues.push({ path: join(path, key), message: 'is not allowed' });
  return unknown.length === 0 ? fields : undefined;
};

const readList = <T>(
  input: unknown,
  path: string,
  depth: number,
  context: Context,
  parse: (item: unknown, path: string, depth: number, context: Context) => T | undefined,
  minLength = 0,
): T[] | undefined => {
  if (!Array.isArray(input) || input.length < minLength) {
    context.issues.push({ path, message: minLength > 0 ? 'must be a non-empty array' : 'must be an array' });
    return undefined;
  }
  const fields = dataFields(input, path, context);
  if (fields === undefined) return undefined;
  const items = Array.from({ length: input.length }, (_, index) =>
    parse(fields[index], join(path, index), depth + 1, context),
  );
  return items.every((item) => item !== undefined) ? (items as T[]) : undefined;
};

const check = (context: Context, path: string, valid: boolean, message: string) => {
  if (!valid) context.issues.push({ path, message });
  return valid;
};

const parseKeep = (input: unknown, path: string, depth: number, context: Context, dice: number) => {
  const fields = readNode(input, path, depth, context, KEEP_KEYS);
  if (fields === undefined) return undefined;
  const { which, count } = fields;
  const valid = [
    check(context, join(path, 'which'), isOneOf(KEEP_WHICH, which), `must be one of ${KEEP_WHICH.join(', ')}`),
    check(
      context,
      join(path, 'count'),
      isIntegerIn(count, MIN_DICE_COUNT, dice),
      `must be an integer from ${MIN_DICE_COUNT} to the dice count`,
    ),
  ];
  return valid.every(Boolean) ? { which: which as KeepWhich, count: count as number } : undefined;
};

const parseExpr = (input: unknown, path: string, depth: number, context: Context): NumberExpr | undefined => {
  const fields = readNode(input, path, depth, context, EXPR_KEYS);
  if (fields === undefined) return undefined;
  const at = (key: string) => join(path, key);
  switch (fields[KIND]) {
    case 'const': {
      const { value } = fields;
      return check(context, at('value'), isBounded(value), `must be a finite number within ±${MAX_DSL_VALUE}`)
        ? { kind: 'const', value: value as number }
        : undefined;
    }
    case 'dice': {
      const { count, sides, modifier, keep } = fields;
      const countValid = check(
        context,
        at('count'),
        isIntegerIn(count, MIN_DICE_COUNT, MAX_DICE_COUNT),
        `must be an integer from ${MIN_DICE_COUNT} to ${MAX_DICE_COUNT}`,
      );
      const valid = [
        countValid,
        check(
          context,
          at('sides'),
          isIntegerIn(sides, MIN_DICE_SIDES, MAX_DICE_SIDES),
          `must be an integer from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}`,
        ),
        check(
          context,
          at('modifier'),
          isIntegerIn(modifier, -MAX_DSL_VALUE, MAX_DSL_VALUE),
          `must be an integer within ±${MAX_DSL_VALUE}`,
        ),
      ];
      const hasKeep = Object.hasOwn(fields, 'keep');
      const parsedKeep =
        hasKeep && countValid ? parseKeep(keep, at('keep'), depth + 1, context, count as number) : undefined;
      if (!valid.every(Boolean) || (hasKeep && parsedKeep === undefined)) return undefined;
      const base = {
        kind: 'dice' as const,
        count: count as number,
        sides: sides as number,
        modifier: modifier as number,
      };
      return parsedKeep ? { ...base, keep: parsedKeep } : base;
    }
    case 'ref':
      return check(context, at('id'), isIdentifier(fields.id), 'must be an identifier')
        ? { kind: 'ref', id: fields.id as string }
        : undefined;
    default: {
      const { op } = fields;
      const opValid = check(context, at('op'), isOneOf(ARITH_OPS, op), `must be one of ${ARITH_OPS.join(', ')}`);
      const left = parseExpr(fields.left, at('left'), depth + 1, context);
      const right = parseExpr(fields.right, at('right'), depth + 1, context);
      return opValid && left && right ? { kind: 'arith', op: op as ArithOp, left, right } : undefined;
    }
  }
};

const parseCondition = (input: unknown, path: string, depth: number, context: Context): Condition | undefined => {
  const fields = readNode(input, path, depth, context, CONDITION_KEYS);
  if (fields === undefined) return undefined;
  const at = (key: string) => join(path, key);
  switch (fields[KIND]) {
    case 'compare': {
      const { op } = fields;
      const opValid = check(context, at('op'), isOneOf(COMPARE_OPS, op), `must be one of ${COMPARE_OPS.join(', ')}`);
      const left = parseExpr(fields.left, at('left'), depth + 1, context);
      const right = parseExpr(fields.right, at('right'), depth + 1, context);
      return opValid && left && right ? { kind: 'compare', op: op as CompareOp, left, right } : undefined;
    }
    case 'and': {
      const all = readList(fields.all, at('all'), depth, context, parseCondition, 1);
      return all && { kind: 'and', all };
    }
    case 'or': {
      const any = readList(fields.any, at('any'), depth, context, parseCondition, 1);
      return any && { kind: 'or', any };
    }
    default: {
      const condition = parseCondition(fields.condition, at('condition'), depth + 1, context);
      return condition && { kind: 'not', condition };
    }
  }
};

const parseAmount = (fields: Fields, path: string, depth: number, context: Context) => {
  const resourceValid = check(context, join(path, 'resource'), isIdentifier(fields.resource), 'must be an identifier');
  const amount = parseExpr(fields.amount, join(path, 'amount'), depth + 1, context);
  return resourceValid && amount ? { resource: fields.resource as string, amount } : undefined;
};

const parseCost = (input: unknown, path: string, depth: number, context: Context): ResourceCost | undefined => {
  const fields = readNode(input, path, depth, context, COST_KEYS);
  const parsed = fields && parseAmount(fields, path, depth, context);
  return parsed && { kind: 'cost', ...parsed };
};

const parseTraitValue = (value: unknown, path: string, depth: number, context: Context) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return parseExpr(value, path, depth + 1, context);
  return check(context, path, value.length <= MAX_DSL_TEXT_LENGTH, `must be at most ${MAX_DSL_TEXT_LENGTH} characters`)
    ? value
    : undefined;
};

const parseEffect = (input: unknown, path: string, depth: number, context: Context): RuleEffect | undefined => {
  const fields = readNode(input, path, depth, context, EFFECT_KEYS);
  if (fields === undefined) return undefined;
  const at = (key: string) => join(path, key);
  switch (fields[KIND]) {
    case 'adjustResource': {
      const parsed = parseAmount(fields, path, depth, context);
      return parsed && { kind: 'adjustResource', ...parsed };
    }
    case 'setTrait': {
      const traitValid = check(context, at('trait'), isIdentifier(fields.trait), 'must be an identifier');
      const value = parseTraitValue(fields.value, at('value'), depth, context);
      return traitValid && value !== undefined ? { kind: 'setTrait', trait: fields.trait as string, value } : undefined;
    }
    default:
      return check(context, at('event'), isIdentifier(fields.event), 'must be an identifier')
        ? { kind: 'emitEvent', event: fields.event as string }
        : undefined;
  }
};

const invalid = (issues: ManifestIssue[]): RuleDslResult => ({ ok: false, error: { code: INVALID_RULE_DSL, issues } });

export const parseRuleDsl = (input: unknown): RuleDslResult => {
  const context: Context = { issues: [], nodes: 0 };
  const fields = readNode(input, '', 0, context, RULE_KEYS);
  if (fields === undefined) return invalid(context.issues);
  check(context, 'dslVersion', fields.dslVersion === RULE_DSL_VERSION, `must be ${RULE_DSL_VERSION}`);
  check(context, 'id', isIdentifier(fields.id), 'must be an identifier');
  const hasWhen = Object.hasOwn(fields, 'when');
  const hasCosts = Object.hasOwn(fields, 'costs');
  const when = hasWhen ? parseCondition(fields.when, 'when', 1, context) : undefined;
  const costs = hasCosts ? readList(fields.costs, 'costs', 0, context, parseCost) : undefined;
  const effects = readList(fields.effects, 'effects', 0, context, parseEffect);
  if (context.issues.length > 0 || effects === undefined) return invalid(context.issues);
  return {
    ok: true,
    rule: {
      dslVersion: RULE_DSL_VERSION,
      id: fields.id as string,
      ...(when ? { when } : {}),
      ...(costs ? { costs } : {}),
      effects,
    },
  };
};
