import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MAX_DICE_COUNT,
  MAX_DICE_SIDES,
  MAX_DSL_DEPTH,
  MAX_DSL_NODES,
  MAX_DSL_VALUE,
  parseRuleDsl,
  RULE_DSL_VERSION,
  type RuleCompileInput,
  type RuleDsl,
} from './dsl.ts';

const INVALID = 'InvalidRuleDsl';

const rule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  dslVersion: RULE_DSL_VERSION,
  id: 'pick-lock',
  effects: [{ kind: 'emitEvent', event: 'lock.opened' }],
  ...overrides,
});

const issuesOf = (input: unknown) => {
  const result = parseRuleDsl(input);
  assert.equal(result.ok, false);
  if (result.ok) return [];
  assert.equal(result.error.code, INVALID);
  return result.error.issues;
};

const paths = (input: unknown) => issuesOf(input).map((issue) => issue.path);

const nested = (depth: number): unknown =>
  depth === 0 ? { kind: 'const', value: 1 } : { kind: 'arith', op: 'add', left: nested(depth - 1), right: nested(0) };

test('define typed expressions for dice, comparisons, resources, conditions and rule effects', () => {
  const full: RuleDsl = {
    dslVersion: RULE_DSL_VERSION,
    id: 'pick-lock',
    when: {
      kind: 'and',
      all: [
        {
          kind: 'compare',
          op: 'gte',
          left: {
            kind: 'arith',
            op: 'add',
            left: { kind: 'dice', count: 3, sides: 6, modifier: 1, keep: { which: 'highest', count: 2 } },
            right: { kind: 'ref', id: 'skill.lockpicking' },
          },
          right: { kind: 'const', value: 12 },
        },
        {
          kind: 'not',
          condition: {
            kind: 'or',
            any: [
              { kind: 'compare', op: 'eq', left: { kind: 'ref', id: 'stress' }, right: { kind: 'const', value: 0 } },
            ],
          },
        },
      ],
    },
    costs: [{ kind: 'cost', resource: 'stamina', amount: { kind: 'const', value: 2 } }],
    effects: [
      {
        kind: 'adjustResource',
        resource: 'stamina',
        amount: {
          kind: 'arith',
          op: 'max',
          left: { kind: 'const', value: -1 },
          right: { kind: 'dice', count: 1, sides: 4, modifier: 0 },
        },
      },
      { kind: 'setTrait', trait: 'door.state', value: 'open' },
      { kind: 'setTrait', trait: 'alert', value: false },
      { kind: 'setTrait', trait: 'noise', value: { kind: 'const', value: 3 } },
      { kind: 'emitEvent', event: 'lock.opened' },
    ],
  };
  assert.deepEqual(parseRuleDsl(JSON.parse(JSON.stringify(full))), { ok: true, rule: full });

  const input: RuleCompileInput = {
    rule: full,
    rulePack: { id: 'pack', edition: 'lite', revision: '1', capabilities: {} },
    sourceRefs: ['srd#1'],
  };
  assert.equal(input.rule.dslVersion, RULE_DSL_VERSION);

  const minimal = rule();
  assert.deepEqual(parseRuleDsl(minimal), { ok: true, rule: minimal });
  assert.deepEqual(paths(rule({ dslVersion: RULE_DSL_VERSION + 1 })), ['dslVersion']);
  assert.deepEqual(
    paths(rule({ effects: [{ kind: 'adjustResource', resource: '', amount: { kind: 'ref', id: 'x' } }] })),
    ['effects.0.resource'],
  );
  assert.deepEqual(
    paths(
      rule({
        when: { kind: 'compare', op: '===', left: { kind: 'const', value: 1 }, right: { kind: 'const', value: 1 } },
      }),
    ),
    ['when.op'],
  );
  assert.deepEqual(
    paths(
      rule({
        effects: [{ kind: 'emitEvent', event: 'x' }],
        costs: [
          {
            kind: 'cost',
            resource: 'hp',
            amount: { kind: 'dice', count: 2, sides: 6, modifier: 0, keep: { which: 'highest', count: 3 } },
          },
        ],
      }),
    ),
    ['costs.0.amount.keep.count'],
  );
});

test('no arbitrary js/python execution from user-authored rulebooks', () => {
  assert.deepEqual(paths(rule({ effects: [{ kind: 'eval', code: 'process.exit(1)' }] })), ['effects.0.kind']);
  assert.deepEqual(paths(rule({ effects: [{ kind: 'js', code: 'require("child_process")' }] })), ['effects.0.kind']);
  assert.deepEqual(paths(rule({ when: { kind: 'python', source: 'import os' } })), ['when.kind']);
  assert.deepEqual(paths(rule({ effects: [{ kind: 'shell', command: 'rm -rf /' }] })), ['effects.0.kind']);
  assert.deepEqual(paths(rule({ effects: [{ kind: 'emitEvent', event: 'x', code: 'alert(1)' }] })), ['effects.0.code']);
  assert.deepEqual(paths(rule({ when: { kind: 'ref', id: 'x' } })), ['when.kind']);
  assert.deepEqual(paths(rule({ effects: [{ kind: 'emitEvent', event: 'require("fs")' }] })), ['effects.0.event']);

  assert.deepEqual(
    paths(JSON.parse(`{"dslVersion":${RULE_DSL_VERSION},"id":"r","effects":[],"__proto__":{"polluted":true}}`)),
    ['__proto__'],
  );
  assert.deepEqual(paths(rule({ constructor: { prototype: { polluted: true } } })), ['constructor']);
  assert.deepEqual(paths({ __proto__: { dslVersion: RULE_DSL_VERSION }, id: 'r', effects: [] }), ['']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  let getterRan = false;
  const withGetter = rule();
  Object.defineProperty(withGetter, 'id', {
    enumerable: true,
    get: () => {
      getterRan = true;
      return 'r';
    },
  });
  assert.deepEqual(paths(withGetter), ['id']);
  assert.equal(getterRan, false);

  const tooDeep = paths(rule({ effects: [{ kind: 'adjustResource', resource: 'hp', amount: nested(MAX_DSL_DEPTH) }] }));
  assert.ok(tooDeep.length > 0);
  assert.ok(tooDeep.every((path) => path.startsWith('effects.0.amount')));
  const tooMany = Array.from({ length: MAX_DSL_NODES }, () => ({ kind: 'emitEvent', event: 'x' }));
  assert.deepEqual(paths(rule({ effects: tooMany })), [`effects.${MAX_DSL_NODES - 1}`]);

  const dice = (overrides: Record<string, unknown>) =>
    rule({
      effects: [
        {
          kind: 'adjustResource',
          resource: 'hp',
          amount: { kind: 'dice', count: 1, sides: 6, modifier: 0, ...overrides },
        },
      ],
    });
  assert.deepEqual(paths(dice({ count: MAX_DICE_COUNT + 1 })), ['effects.0.amount.count']);
  assert.deepEqual(paths(dice({ count: 1e300 })), ['effects.0.amount.count']);
  assert.deepEqual(paths(dice({ sides: MAX_DICE_SIDES + 1 })), ['effects.0.amount.sides']);
  assert.deepEqual(paths(dice({ sides: 1.5 })), ['effects.0.amount.sides']);
  assert.deepEqual(paths(dice({ modifier: Number.NaN })), ['effects.0.amount.modifier']);
  assert.deepEqual(
    paths(
      rule({
        when: {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'const', value: MAX_DSL_VALUE + 1 },
          right: { kind: 'const', value: Number.POSITIVE_INFINITY },
        },
      }),
    ),
    ['when.left.value', 'when.right.value'],
  );

  assert.deepEqual(paths('function () { return 1 }'), ['']);
  assert.deepEqual(paths([rule()]), ['']);

  const source = readFileSync(new URL('./dsl.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\b|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(/);
});
