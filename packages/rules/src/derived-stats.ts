import {
  type ArithOp,
  isBounded,
  MAX_DSL_DEPTH,
  MAX_DSL_NODES,
  MAX_DSL_TEXT_LENGTH,
  MAX_DSL_VALUE,
  type NumberExpr,
} from './dsl.ts';
import {
  ISSUE_CODES,
  referenceIssues,
  type SheetField,
  type SheetProvenance,
  type SheetSchema,
  type WidgetType,
} from './sheet-schema.ts';

export const DERIVED_ISSUE_CODES = [...ISSUE_CODES, 'invalid_formula', 'out_of_range'] as const;
export const VIOLATION_MODES = ['clamp', 'report'] as const;
export const NUMERIC_WIDGETS: readonly WidgetType[] = ['number', 'resource'];

export type DerivedIssueCode = (typeof DERIVED_ISSUE_CODES)[number];
export type DerivedIssue = { path: string; code: DerivedIssueCode; message: string };
export type ViolationMode = (typeof VIOLATION_MODES)[number];
export type StatBonus = { source: string; targets: string[]; amount: number };
export type AppliedBonus = { source: string; target: string; amount: number };
export type StatConstraint = { field: string; min?: number; max?: number; onViolation: ViolationMode };
export type ConstraintResult = { field: string; status: 'ok' | 'clamped' | 'violated'; raw: number; value: number };
export type DerivedStatsInput = {
  schema: SheetSchema;
  base: Record<string, number>;
  bonuses: StatBonus[];
  constraints?: StatConstraint[];
};
export type DerivedStats = {
  ok: true;
  rulepack: SheetProvenance;
  order: string[];
  values: Record<string, number>;
  appliedBonuses: AppliedBonus[];
  constraints: ConstraintResult[];
};
export type DerivedStatsResult = DerivedStats | { ok: false; issues: DerivedIssue[] };

const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|([-+*(),]))/y;
const WHITESPACE = /^\s*$/;
const INFIX_OPS: Record<string, ArithOp> = { '+': 'add', '-': 'sub', '*': 'mul' };
const CALL_OPS: Record<string, ArithOp> = { min: 'min', max: 'max' };
const ADDITIVE = ['+', '-'];
const MULTIPLICATIVE = ['*'];
const NEGATE = '-';
const OPEN = '(';
const CLOSE = ')';
const COMMA = ',';
const ZERO: NumberExpr = { kind: 'const', value: 0 };
const OUT_OF_RANGE = `must be a finite number within ±${MAX_DSL_VALUE}`;
const NOT_NUMERIC = 'must reference a numeric field';

type Token = { number?: number; name?: string; symbol?: string };

const isNumeric = (field: SheetField | undefined) => field !== undefined && NUMERIC_WIDGETS.includes(field.widget);

const tokenize = (text: string): Token[] | undefined => {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length && !WHITESPACE.test(text.slice(TOKEN.lastIndex))) {
    const match = TOKEN.exec(text);
    if (match === null) return undefined;
    const [, number, name, symbol] = match;
    if (number !== undefined) tokens.push({ number: Number(number) });
    else if (name !== undefined) tokens.push({ name });
    else tokens.push({ symbol: symbol as string });
  }
  return tokens;
};

const parseFormula = (text: string): NumberExpr | undefined => {
  const tokens = text.length <= MAX_DSL_TEXT_LENGTH ? tokenize(text) : undefined;
  if (tokens === undefined) return undefined;
  let position = 0;
  let nodes = 0;
  const peek = (symbol: string) => tokens[position]?.symbol === symbol;
  const take = (symbol: string) => peek(symbol) && ++position > 0;
  const node = (expr: NumberExpr | undefined) => {
    nodes += 1;
    return nodes > MAX_DSL_NODES ? undefined : expr;
  };
  const arith = (op: ArithOp, left?: NumberExpr, right?: NumberExpr) =>
    left && right ? node({ kind: 'arith', op, left, right }) : undefined;
  const chain = (symbols: string[], next: (depth: number) => NumberExpr | undefined, depth: number) => {
    let left = next(depth);
    while (left && symbols.some(peek)) {
      const op = INFIX_OPS[tokens[position++]?.symbol as string] as ArithOp;
      left = arith(op, left, next(depth));
    }
    return left;
  };
  const expr = (depth: number): NumberExpr | undefined =>
    depth > MAX_DSL_DEPTH ? undefined : chain(ADDITIVE, term, depth + 1);
  const term = (depth: number) => chain(MULTIPLICATIVE, unary, depth);
  const unary = (depth: number): NumberExpr | undefined => {
    if (depth > MAX_DSL_DEPTH) return undefined;
    if (take(NEGATE)) return arith('sub', ZERO, unary(depth + 1));
    return primary(depth);
  };
  const primary = (depth: number): NumberExpr | undefined => {
    const token = tokens[position++];
    if (token?.number !== undefined)
      return isBounded(token.number) ? node({ kind: 'const', value: token.number }) : undefined;
    if (token?.symbol === OPEN) {
      const inner = expr(depth + 1);
      return take(CLOSE) ? inner : undefined;
    }
    if (token?.name === undefined) return undefined;
    const call = Object.hasOwn(CALL_OPS, token.name) ? CALL_OPS[token.name] : undefined;
    if (call === undefined) return peek(OPEN) ? undefined : node({ kind: 'ref', id: token.name });
    if (!take(OPEN)) return undefined;
    const left = expr(depth + 1);
    if (!take(COMMA)) return undefined;
    const right = expr(depth + 1);
    return take(CLOSE) ? arith(call, left, right) : undefined;
  };
  const result = expr(0);
  return position === tokens.length ? result : undefined;
};

const refsOf = (expr: NumberExpr): string[] => {
  if (expr.kind === 'ref') return [expr.id];
  return expr.kind === 'arith' ? [...refsOf(expr.left), ...refsOf(expr.right)] : [];
};

const APPLY: Record<ArithOp, (left: number, right: number) => number> = {
  add: (left, right) => left + right,
  sub: (left, right) => left - right,
  mul: (left, right) => left * right,
  min: Math.min,
  max: Math.max,
};

const evaluate = (expr: NumberExpr, values: Map<string, number>): number => {
  if (expr.kind === 'const') return expr.value;
  if (expr.kind === 'ref') return values.get(expr.id) ?? Number.NaN;
  if (expr.kind !== 'arith') return Number.NaN;
  const result = APPLY[expr.op](evaluate(expr.left, values), evaluate(expr.right, values));
  return isBounded(result) ? result : Number.NaN;
};

const topologicalOrder = (fields: SheetField[]) => {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const root of fields) {
    const stack: { field: SheetField; expanded: boolean }[] = [{ field: root, expanded: false }];
    while (stack.length > 0) {
      const top = stack.pop() as { field: SheetField; expanded: boolean };
      if (top.expanded) {
        if (top.field.derived) order.push(top.field.id);
        continue;
      }
      if (seen.has(top.field.id)) continue;
      seen.add(top.field.id);
      stack.push({ field: top.field, expanded: true });
      for (const ref of top.field.derived?.refs ?? []) {
        const target = byId.get(ref);
        if (target && !seen.has(ref)) stack.push({ field: target, expanded: false });
      }
    }
  }
  return order;
};

const checkInputs = (input: DerivedStatsInput, byId: Map<string, SheetField>, issues: DerivedIssue[]) => {
  const unknown = (path: string) =>
    issues.push({ path, code: 'unknown_reference', message: 'must reference a declared field' });
  const invalid = (path: string, message: string) => issues.push({ path, code: 'invalid', message });
  const range = (path: string) => issues.push({ path, code: 'out_of_range', message: OUT_OF_RANGE });
  for (const [id, value] of Object.entries(input.base)) {
    const field = byId.get(id);
    if (field === undefined) unknown(`base.${id}`);
    else if (!isNumeric(field)) invalid(`base.${id}`, NOT_NUMERIC);
    else if (field.derived) invalid(`base.${id}`, 'must not set a derived field');
    else if (!isBounded(value)) range(`base.${id}`);
  }
  input.bonuses.forEach((bonus, index) => {
    bonus.targets.forEach((target, targetIndex) => {
      const path = `bonuses.${index}.targets.${targetIndex}`;
      if (!byId.has(target)) unknown(path);
      else if (!isNumeric(byId.get(target))) invalid(path, NOT_NUMERIC);
    });
    if (!isBounded(bonus.amount)) range(`bonuses.${index}.amount`);
  });
  (input.constraints ?? []).forEach((constraint, index) => {
    const path = `constraints.${index}`;
    if (!byId.has(constraint.field)) unknown(`${path}.field`);
    else if (!isNumeric(byId.get(constraint.field))) invalid(`${path}.field`, NOT_NUMERIC);
    const { min, max } = constraint;
    for (const [key, limit] of [
      ['min', min],
      ['max', max],
    ] as const) {
      if (limit !== undefined && !isBounded(limit)) range(`${path}.${key}`);
    }
    if (min !== undefined && max !== undefined && min > max) invalid(path, 'min must not exceed max');
    if (!VIOLATION_MODES.includes(constraint.onViolation)) {
      invalid(`${path}.onViolation`, `must be one of ${VIOLATION_MODES.join(', ')}`);
    }
  });
};

const parseFields = (input: DerivedStatsInput, byId: Map<string, SheetField>, issues: DerivedIssue[]) => {
  const formulas = new Map<string, NumberExpr>();
  input.schema.fields.forEach((field, index) => {
    const path = `fields.${index}.derived`;
    if (!isNumeric(field)) return;
    if (!field.derived) {
      if (!Object.hasOwn(input.base, field.id))
        issues.push({ path: `base.${field.id}`, code: 'missing', message: 'must have a base value' });
      return;
    }
    field.derived.refs.forEach((ref, refIndex) => {
      if (!isNumeric(byId.get(ref)))
        issues.push({ path: `${path}.refs.${refIndex}`, code: 'invalid', message: NOT_NUMERIC });
    });
    const formula = parseFormula(field.derived.expression);
    if (formula === undefined) {
      issues.push({ path: `${path}.expression`, code: 'invalid_formula', message: 'must be a valid formula' });
      return;
    }
    if (refsOf(formula).some((ref) => !field.derived?.refs.includes(ref))) {
      issues.push({ path: `${path}.expression`, code: 'unknown_reference', message: 'must use only declared refs' });
      return;
    }
    formulas.set(field.id, formula);
  });
  return formulas;
};

const constrain = (constraint: StatConstraint, raw: number): ConstraintResult => {
  const low = constraint.min ?? -MAX_DSL_VALUE;
  const high = constraint.max ?? MAX_DSL_VALUE;
  const base = { field: constraint.field, raw };
  if (raw >= low && raw <= high) return { ...base, status: 'ok', value: raw };
  if (constraint.onViolation === 'report') return { ...base, status: 'violated', value: raw };
  return { ...base, status: 'clamped', value: Math.min(high, Math.max(low, raw)) };
};

export const computeDerivedStats = (input: DerivedStatsInput): DerivedStatsResult => {
  const references = referenceIssues(input.schema.fields);
  if (references.length > 0) return { ok: false, issues: references };
  const fields = input.schema.fields.filter(isNumeric);
  const byId = new Map(input.schema.fields.map((field) => [field.id, field]));
  const issues: DerivedIssue[] = [];
  checkInputs(input, byId, issues);
  const formulas = parseFields(input, byId, issues);
  if (issues.length > 0) return { ok: false, issues };
  const order = topologicalOrder(fields);
  const indexOf = new Map(input.schema.fields.map((field, index) => [field.id, index]));
  const values = new Map<string, number>();
  const appliedBonuses: AppliedBonus[] = [];
  const constraints: ConstraintResult[] = [];
  const settle = (id: string, raw: number) => {
    let value = raw;
    for (const bonus of input.bonuses) {
      if (!bonus.targets.includes(id)) continue;
      value += bonus.amount;
      appliedBonuses.push({ source: bonus.source, target: id, amount: bonus.amount });
    }
    for (const constraint of input.constraints ?? []) {
      if (constraint.field !== id) continue;
      const result = constrain(constraint, value);
      constraints.push(result);
      value = result.value;
    }
    values.set(id, value);
    return isBounded(value);
  };
  for (const field of fields) {
    if (field.derived || settle(field.id, input.base[field.id] as number)) continue;
    issues.push({ path: `base.${field.id}`, code: 'out_of_range', message: OUT_OF_RANGE });
  }
  for (const id of order) {
    const path = `fields.${indexOf.get(id)}.derived.expression`;
    if (!settle(id, evaluate(formulas.get(id) as NumberExpr, values)))
      issues.push({ path, code: 'out_of_range', message: OUT_OF_RANGE });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    rulepack: structuredClone(input.schema.rulepack),
    order,
    values: Object.fromEntries(values),
    appliedBonuses,
    constraints,
  };
};
