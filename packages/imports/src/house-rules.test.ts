import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRule } from '../../rules/src/compile.ts';
import { type NumberExpr, RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from '../../rules/src/rulepack.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import {
  applyHouseRule,
  baseEffectiveRules,
  type HouseRule,
  type RollRecord,
  recordRoll,
  undoHouseRule,
} from './house-rules.ts';

const SEED = 11;
const FOCUS_START = 20;
const FOCUS_MAX = 20;
const DIE_SIDES = 6;
const DOUBLE = 2;
const RULE_ID = 'strain';

const rulePack: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'pack',
  edition: 'lite',
  revision: '3',
  capabilities: { random: true, arithmetic: true, resourceCost: true, effects: true },
  sourceRefs: ['f'.repeat(64)],
};

const die: NumberExpr = { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 };

const rule = (amount: NumberExpr): RuleDsl => ({
  dslVersion: RULE_DSL_VERSION,
  id: RULE_ID,
  costs: [{ kind: 'cost', resource: 'focus', amount }],
  effects: [{ kind: 'emitEvent', event: 'strain.paid' }],
});

const compiled = (() => {
  const result = compileRule({ rule: rule(die), rulePack, sourceRefs: ['f'.repeat(64)] });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.rule;
})();

const houseRule = (overrides: Partial<HouseRule> = {}): HouseRule => ({
  id: 'double-strain',
  source: { kind: 'house_rule', author: 'table', note: 'Strain costs double.' },
  rule: rule({ kind: 'arith', op: 'mul', left: die, right: { kind: 'const', value: DOUBLE } }),
  ...overrides,
});

const sheet = (): TraitSheet => ({
  characterId: 'hero' as TraitSheet['characterId'],
  traits: [{ id: 'focus', kind: 'resource', current: FOCUS_START, max: FOCUS_MAX }],
});

const unwrap = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const roll = (effective: Parameters<typeof recordRoll>[0], actionId: string): RollRecord =>
  unwrap(recordRoll(effective, { ruleId: RULE_ID, actionId, sheet: sheet(), seed: SEED })).record;

test('apply user overrides to versioned effective rules without changing source docs', () => {
  const sourceRules = [compiled];
  const packBefore = structuredClone(rulePack);
  const rulesBefore = structuredClone(sourceRules);
  const base = unwrap(baseEffectiveRules(rulePack, sourceRules)).effective;
  const overlaid = unwrap(applyHouseRule(base, houseRule())).effective;

  assert.deepEqual(rulePack, packBefore);
  assert.deepEqual(sourceRules, rulesBefore);
  assert.deepEqual(base.rules, rulesBefore);
  assert.deepEqual(overlaid.version.base, { id: 'pack', edition: 'lite', revision: '3' });
  assert.equal(base.version.depth, 0);
  assert.equal(overlaid.version.depth, 1);
  assert.notEqual(overlaid.version.overlayHash, base.version.overlayHash);

  const [layer] = overlaid.layers;
  assert.deepEqual(layer?.source, houseRule().source);
  assert.equal(layer?.id, 'double-strain');
  assert.equal(layer?.replaced, true);
  const effectiveRule = overlaid.rules.find(({ rule: { id } }) => id === RULE_ID);
  assert.deepEqual(effectiveRule?.sourceRefs, [layer?.sourceHash]);
  assert.deepEqual(effectiveRule?.rule, houseRule().rule);
  assert.equal(overlaid.rules.length, 1);

  const baseCost = roll(base, 'a1').resolution;
  const overlaidCost = roll(overlaid, 'a1').resolution;
  assert.ok(baseCost.ok && overlaidCost.ok);
  assert.equal(
    FOCUS_START - (overlaidCost.changes[0]?.to as number),
    DOUBLE * (FOCUS_START - (baseCost.changes[0]?.to as number)),
  );
});

test('undo restores prior effective rule and never rewrites historical rolls', () => {
  const base = unwrap(baseEffectiveRules(rulePack, [compiled])).effective;
  const history: RollRecord[] = [roll(base, 'a1')];
  const overlaid = unwrap(applyHouseRule(base, houseRule())).effective;
  history.push(roll(overlaid, 'a2'));
  const snapshot = JSON.stringify(history);

  const restored = unwrap(undoHouseRule(overlaid)).effective;
  history.push(roll(restored, 'a3'));

  assert.deepEqual(restored, base);
  assert.equal(JSON.stringify(history.slice(0, 2)), snapshot);
  assert.deepEqual(history[0]?.version, base.version);
  assert.deepEqual(history[1]?.version, overlaid.version);
  assert.deepEqual(history[2]?.version, base.version);
  assert.ok(Object.isFrozen(history[1]));
  assert.deepEqual(undoHouseRule(restored), { ok: false, error: { code: 'NothingToUndo', issues: [] } });
});

test('reject house rules with unknown fields, invalid rules or disabled capabilities', () => {
  const base = unwrap(baseEffectiveRules(rulePack, [compiled])).effective;
  const codeOf = (input: unknown) => {
    const result = applyHouseRule(base, input);
    return result.ok ? 'ok' : result.error.code;
  };
  assert.equal(codeOf({ ...houseRule(), run: 'process.exit()' }), 'InvalidHouseRule');
  assert.equal(codeOf(houseRule({ id: '' })), 'InvalidHouseRule');
  assert.equal(codeOf({ ...houseRule(), source: { kind: 'pdf', author: 'x', note: '' } }), 'InvalidHouseRule');
  assert.equal(codeOf({ ...houseRule(), rule: () => 1 }), 'InvalidHouseRule');
  assert.equal(codeOf(houseRule({ rule: { ...rule(die), when: 'true' } })), 'InvalidRuleDsl');
  const noRandom = unwrap(
    baseEffectiveRules({ ...rulePack, capabilities: { resourceCost: true, effects: true } }, []),
  ).effective;
  const disabled = applyHouseRule(noRandom, houseRule());
  assert.equal(disabled.ok ? 'ok' : disabled.error.code, 'CapabilityDisabled');
  const overlaid = unwrap(applyHouseRule(base, houseRule())).effective;
  const duplicate = applyHouseRule(overlaid, houseRule());
  assert.equal(duplicate.ok ? 'ok' : duplicate.error.code, 'DuplicateHouseRule');
  const missing = recordRoll(base, { ruleId: 'missing', actionId: 'a', sheet: sheet(), seed: SEED });
  assert.equal(missing.ok ? 'ok' : missing.error.code, 'UnknownRule');
});

test('pin effective version to base rules and reject rules compiled for another pack', () => {
  const other = unwrap(compileRule({ rule: { ...rule(die), id: 'other' }, rulePack, sourceRefs: [] })).rule;
  const one = unwrap(baseEffectiveRules(rulePack, [compiled])).effective;
  const two = unwrap(baseEffectiveRules(rulePack, [compiled, other])).effective;
  assert.notEqual(one.version.overlayHash, two.version.overlayHash);
  const mismatched = baseEffectiveRules({ ...rulePack, revision: '4' }, [compiled]);
  assert.equal(mismatched.ok ? 'ok' : mismatched.error.code, 'RulePackMismatch');
});
