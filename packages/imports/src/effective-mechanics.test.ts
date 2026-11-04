import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRule } from '../../rules/src/compile.ts';
import { GM_ADJUDICATED, type NumberExpr, RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from '../../rules/src/rulepack.ts';
import { houseRuleMechanics } from './effective-mechanics.ts';
import { applyHouseRule, baseEffectiveRules, type EffectiveRules, type HouseRule } from './house-rules.ts';

const BASE_SECTION = 'core-chapter-2';
const RULE_ID = 'strain';
const OTHER_RULE_ID = 'focus';
const DIE_SIDES = 6;
const DOUBLE = 2;

const rulePack: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'pack',
  edition: 'lite',
  revision: '3',
  capabilities: { random: true, arithmetic: true, resourceCost: true, effects: true },
  sourceRefs: [BASE_SECTION],
};

const die: NumberExpr = { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 };

const rule = (id: string, amount: NumberExpr): RuleDsl => ({
  dslVersion: RULE_DSL_VERSION,
  id,
  costs: [{ kind: 'cost', resource: 'focus', amount }],
  effects: [{ kind: 'emitEvent', event: 'strain.paid' }],
});

const unwrap = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const compiled = (id: string) =>
  unwrap(compileRule({ rule: rule(id, die), rulePack, sourceRefs: [BASE_SECTION] })).rule;

const houseRule: HouseRule = {
  id: 'double-strain',
  source: { kind: 'house_rule', author: 'table', note: 'Strain costs double.' },
  rule: rule(RULE_ID, { kind: 'arith', op: 'mul', left: die, right: { kind: 'const', value: DOUBLE } }),
};

const base = (): EffectiveRules =>
  unwrap(baseEffectiveRules(rulePack, [compiled(RULE_ID), compiled(OTHER_RULE_ID)])).effective;

test('house rule mechanics cite the base section or the overlay source hash and pin the effective version', () => {
  const overlaid = unwrap(applyHouseRule(base(), houseRule)).effective;
  const { overlayHash, depth } = overlaid.version;
  const [house, other] = houseRuleMechanics(overlaid);

  assert.deepEqual(house?.source, {
    kind: 'house_rule',
    sourceRef: overlaid.layers[0]?.sourceHash,
    revision: rulePack.revision,
    overlayHash,
    depth,
  });
  assert.deepEqual(other?.source, {
    kind: 'rulepack',
    sourceRef: BASE_SECTION,
    revision: rulePack.revision,
    overlayHash,
    depth,
  });
  assert.deepEqual(house?.rulePack, { id: 'pack', edition: 'lite', revision: '3' });
  assert.equal(house?.ruleId, RULE_ID);
  assert.equal(house?.kind, 'deterministic');
  assert.equal(house?.kind === 'deterministic' && house.rule, overlaid.rules[0]);
});

test('house rule mechanics adjudicate rules that are not deterministic', () => {
  const effective = base();
  const nondeterministic = {
    ...effective,
    rules: [{ ...effective.rules[0], deterministic: false, adjudicated: ['narrative'] }],
  };
  const [mechanic] = houseRuleMechanics(nondeterministic as unknown as EffectiveRules);

  assert.equal(mechanic?.kind, GM_ADJUDICATED);
  assert.equal(mechanic?.kind === GM_ADJUDICATED && mechanic.reason, 'AdjudicatedCapability');
});
