import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileRule, runCompiledRule } from './compile.ts';
import { RULE_DSL_VERSION, type RuleCompileInput, type RuleDsl } from './dsl.ts';
import type { CapabilityValue } from './rulepack.ts';
import type { TraitSheet } from './traits.ts';

const SEED = 7;
const OTHER_SEED = 8;
const ACTION_ID = 'action-1';
const SOURCE_REF = 'srd#focus';
const FOCUS_START = 3;
const FOCUS_MAX = 5;
const COST = 1;
const DICE_COUNT = 2;
const DICE_SIDES = 6;
const SKILL = 2;

const ALL_ENABLED: Record<string, CapabilityValue> = {
  random: true,
  comparison: true,
  arithmetic: true,
  resourceCost: true,
  condition: true,
  effects: true,
};

const constant = (value: number) => ({ kind: 'const', value });

const rule = (): RuleDsl =>
  ({
    dslVersion: RULE_DSL_VERSION,
    id: 'focused-strike',
    when: { kind: 'compare', op: 'gte', left: { kind: 'ref', id: 'focus' }, right: constant(COST) },
    costs: [{ kind: 'cost', resource: 'focus', amount: constant(COST) }],
    effects: [
      {
        kind: 'setTrait',
        trait: 'outcome',
        value: {
          kind: 'arith',
          op: 'add',
          left: { kind: 'dice', count: DICE_COUNT, sides: DICE_SIDES, modifier: 0 },
          right: { kind: 'ref', id: 'skill' },
        },
      },
    ],
  }) as RuleDsl;

const input = (capabilities = ALL_ENABLED, compiled: unknown = rule()): RuleCompileInput => ({
  rule: compiled as RuleDsl,
  rulePack: { id: 'pack', edition: 'lite', revision: '3', capabilities },
  sourceRefs: [SOURCE_REF],
});

const sheet = (): TraitSheet => ({
  characterId: 'hero' as TraitSheet['characterId'],
  traits: [
    { id: 'skill', kind: 'trait', value: SKILL },
    { id: 'focus', kind: 'resource', current: FOCUS_START, max: FOCUS_MAX },
    { id: 'outcome', kind: 'trait', value: 0 },
  ],
});

const isDeepFrozen = (value: unknown): boolean =>
  value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(isDeepFrozen));

test('compile supported primitives to deterministic validated mechanics and test hooks', () => {
  const first = compileRule(input());
  const second = compileRule(input());
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.rule.rule, rule());
  assert.deepEqual(first.rule.rulePack, { id: 'pack', edition: 'lite', revision: '3' });
  assert.deepEqual(first.rule.sourceRefs, [SOURCE_REF]);
  assert.deepEqual(first.rule.primitives, [
    'random',
    'comparison',
    'arithmetic',
    'resourceCost',
    'condition',
    'effects',
  ]);
  assert.equal(first.rule.deterministic, true);
  assert.deepEqual(first.rule.adjudicated, []);

  const run = (seed: number) => runCompiledRule(first.rule, { actionId: ACTION_ID, sheet: sheet(), seed });
  const resolved = run(SEED);
  assert.deepEqual(resolved, run(SEED));
  assert.equal(resolved.ok, true);
  assert.notDeepEqual(resolved.rolls, run(OTHER_SEED).rolls);
});

test('adjudicated capabilities compile but are flagged as not deterministic', () => {
  const result = compileRule(input({ ...ALL_ENABLED, random: 'adjudicated' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rule.deterministic, false);
  assert.deepEqual(result.rule.adjudicated, ['random']);
});

test('disabled capabilities are rejected with a structured error', () => {
  const { random: _random, ...withoutRandom } = ALL_ENABLED;
  const result = compileRule(input({ ...withoutRandom, resourceCost: false }));
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'CapabilityDisabled',
      issues: [
        { path: 'capabilities.random', message: 'is disabled in rule pack pack' },
        { path: 'capabilities.resourceCost', message: 'is disabled in rule pack pack' },
      ],
    },
  });
});

test('invalid DSL is rejected', () => {
  const result = compileRule(input(ALL_ENABLED, { ...rule(), dslVersion: RULE_DSL_VERSION + 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, 'InvalidRuleDsl');
});

test('function-valued and getter fields are rejected without running code', () => {
  let called = false;
  const withGetter = { ...rule() };
  Object.defineProperty(withGetter, 'id', {
    enumerable: true,
    get: () => {
      called = true;
      return 'focused-strike';
    },
  });
  const withFunction = { ...rule(), effects: [{ kind: 'emitEvent', event: () => 'x' }] };
  for (const unsafe of [withGetter, withFunction]) {
    const result = compileRule(input(ALL_ENABLED, unsafe));
    assert.equal(result.ok ? undefined : result.error.code, 'InvalidRuleDsl');
  }
  assert.equal(called, false);
});

test('compiled output is deeply frozen and detached from the input', () => {
  const source = input();
  const result = compileRule(source);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isDeepFrozen(result.rule), true);
  source.sourceRefs.push('later');
  assert.deepEqual(result.rule.sourceRefs, [SOURCE_REF]);
});
