import { createSeededRng } from './dice.ts';
import {
  type CompiledRule,
  type CompileRule,
  type Condition,
  type NumberExpr,
  parseRuleDsl,
  type RuleDsl,
  type RuleEffect,
} from './dsl.ts';
import { type ActionInput, resolveAction } from './resolve.ts';
import { capabilityState, type Primitive, SUPPORTED_PRIMITIVES } from './rulepack.ts';

const CAPABILITY_DISABLED = 'CapabilityDisabled';

const exprPrimitives = (expr: NumberExpr): Primitive[] => {
  if (expr.kind === 'dice') return ['random'];
  if (expr.kind === 'arith') return ['arithmetic', ...exprPrimitives(expr.left), ...exprPrimitives(expr.right)];
  return [];
};

const conditionPrimitives = (condition: Condition): Primitive[] => {
  switch (condition.kind) {
    case 'compare':
      return ['comparison', ...exprPrimitives(condition.left), ...exprPrimitives(condition.right)];
    case 'and':
      return condition.all.flatMap(conditionPrimitives);
    case 'or':
      return condition.any.flatMap(conditionPrimitives);
    default:
      return conditionPrimitives(condition.condition);
  }
};

const effectPrimitives = (effect: RuleEffect): Primitive[] => {
  if (effect.kind === 'adjustResource') return exprPrimitives(effect.amount);
  if (effect.kind === 'setTrait' && typeof effect.value === 'object') return exprPrimitives(effect.value);
  return [];
};

const rulePrimitives = ({ when, costs = [], effects }: RuleDsl): Primitive[] => {
  const used: Primitive[] = [
    ...(when ? ['condition' as const, ...conditionPrimitives(when)] : []),
    ...(costs.length ? ['resourceCost' as const, ...costs.flatMap((cost) => exprPrimitives(cost.amount))] : []),
    ...(effects.length ? ['effects' as const, ...effects.flatMap(effectPrimitives)] : []),
  ];
  return SUPPORTED_PRIMITIVES.filter((primitive) => used.includes(primitive));
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export const compileRule: CompileRule = ({ rule, rulePack, sourceRefs }) => {
  const parsed = parseRuleDsl(rule);
  if (!parsed.ok) return parsed;
  const primitives = rulePrimitives(parsed.rule);
  const state = (primitive: Primitive) => capabilityState(rulePack, primitive);
  const disabled = primitives.filter((primitive) => state(primitive) === 'disabled');
  if (disabled.length > 0) {
    const issues = disabled.map((primitive) => ({
      path: `capabilities.${primitive}`,
      message: `is disabled in rule pack ${rulePack.id}`,
    }));
    return { ok: false, error: { code: CAPABILITY_DISABLED, issues } };
  }
  const adjudicated = primitives.filter((primitive) => state(primitive) === 'adjudicated');
  const compiled: CompiledRule = {
    rule: parsed.rule,
    rulePack: { id: rulePack.id, edition: rulePack.edition, revision: rulePack.revision },
    sourceRefs: [...sourceRefs],
    primitives,
    adjudicated,
    deterministic: adjudicated.length === 0,
  };
  return { ok: true, rule: deepFreeze(compiled) };
};

export const runCompiledRule = (
  compiled: CompiledRule,
  { seed, ...input }: Omit<ActionInput, 'rule' | 'rng'> & { seed: number },
) => resolveAction({ ...input, rule: compiled.rule, rng: createSeededRng(seed) });
