import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDerivedStats, type DerivedStatsInput } from './derived-stats.ts';
import { MAX_DSL_VALUE } from './dsl.ts';
import { SHEET_SCHEMA_VERSION, type SheetField, type SheetSchema } from './sheet-schema.ts';

const rulepack = { id: 'any-pack', edition: '1', revision: 'r2', sourceRefs: ['srd:p1'] };

const number = (id: string, expression?: string, refs: string[] = []): SheetField => ({
  id,
  widget: 'number',
  custom: false,
  visibility: 'public',
  ...(expression === undefined ? {} : { derived: { expression, refs } }),
});

const schemaOf = (fields: SheetField[]): SheetSchema => ({ schemaVersion: SHEET_SCHEMA_VERSION, rulepack, fields });

const issuesOf = (input: DerivedStatsInput) => {
  const result = computeDerivedStats(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
};

test('recompute modifiers, bonuses and constraints from referenced attributes and equipment', () => {
  const schema = schemaOf([
    number('defense', 'max(guard, agility) + 2', ['guard', 'agility']),
    number('might'),
    number('agility'),
    number('guard', 'might * 2 - (agility - 1)', ['might', 'agility']),
    number('load', '-might + 20', ['might']),
  ]);
  const input: DerivedStatsInput = {
    schema,
    base: { might: 3, agility: 4 },
    bonuses: [
      { source: 'item:ring', targets: ['might'], amount: 1 },
      { source: 'item:shield', targets: ['defense', 'guard'], amount: 2 },
    ],
    constraints: [
      { field: 'defense', max: 10, onViolation: 'clamp' },
      { field: 'load', min: 18, onViolation: 'report' },
    ],
  };
  const frozen = structuredClone(input);
  const result = computeDerivedStats(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(input, frozen);
  assert.deepEqual(result.rulepack, rulepack);
  assert.deepEqual(result.order, ['guard', 'defense', 'load']);
  assert.deepEqual(result.values, { might: 4, agility: 4, guard: 7, defense: 10, load: 16 });
  assert.deepEqual(result.appliedBonuses, [
    { source: 'item:ring', target: 'might', amount: 1 },
    { source: 'item:shield', target: 'guard', amount: 2 },
    { source: 'item:shield', target: 'defense', amount: 2 },
  ]);
  assert.deepEqual(result.constraints, [
    { field: 'defense', status: 'clamped', raw: 11, value: 10 },
    { field: 'load', status: 'violated', raw: 16, value: 16 },
  ]);
  assert.deepEqual(computeDerivedStats(input), result);
});

test('cycles, unknown fields or invalid formulas are rejected', () => {
  const cycle = issuesOf({
    schema: schemaOf([number('a', 'b', ['b']), number('b', 'a + 1', ['a'])]),
    base: {},
    bonuses: [],
  });
  assert.ok(cycle.some((issue) => issue.code === 'cycle'));

  const unknown = issuesOf({
    schema: schemaOf([number('a'), number('b', 'a + ghost', ['a'])]),
    base: { a: 1, nope: 2 },
    bonuses: [{ source: 'item:x', targets: ['phantom'], amount: 1 }],
    constraints: [{ field: 'void', min: 0, onViolation: 'clamp' }],
  });
  assert.deepEqual(
    unknown.map((issue) => [issue.path, issue.code]),
    [
      ['base.nope', 'unknown_reference'],
      ['bonuses.0.targets.0', 'unknown_reference'],
      ['constraints.0.field', 'unknown_reference'],
      ['fields.1.derived.expression', 'unknown_reference'],
    ],
  );

  for (const expression of ['a +', 'a ** 2', 'a / 2', '(a', 'eval(a)', 'min(a)', 'a; 1', '', '1e5']) {
    const issues = issuesOf({
      schema: schemaOf([number('a'), number('b', expression, ['a'])]),
      base: { a: 1 },
      bonuses: [],
    });
    assert.deepEqual(
      issues.map((issue) => issue.code),
      ['invalid_formula'],
      expression,
    );
  }

  const deep = `${'('.repeat(40)}a${')'.repeat(40)}`;
  assert.equal(
    issuesOf({ schema: schemaOf([number('a'), number('b', deep, ['a'])]), base: { a: 1 }, bonuses: [] })[0]?.code,
    'invalid_formula',
  );
});

test('missing, non-finite or out-of-range numbers are rejected', () => {
  const schema = schemaOf([number('a'), number('b', 'a * a', ['a']), number('c')]);
  assert.deepEqual(
    issuesOf({ schema, base: { a: Number.NaN }, bonuses: [{ source: 's', targets: ['a'], amount: Infinity }] }).map(
      (issue) => [issue.path, issue.code],
    ),
    [
      ['base.a', 'out_of_range'],
      ['bonuses.0.amount', 'out_of_range'],
      ['base.c', 'missing'],
    ],
  );
  assert.deepEqual(
    issuesOf({ schema, base: { a: MAX_DSL_VALUE, c: 0 }, bonuses: [] }).map((issue) => [issue.path, issue.code]),
    [['fields.1.derived.expression', 'out_of_range']],
  );
  assert.deepEqual(
    issuesOf({ schema, base: { a: 1, b: 2, c: 0 }, bonuses: [] }).map((issue) => [issue.path, issue.code]),
    [['base.b', 'invalid']],
  );
});

test('bonuses that push a base field out of range are rejected', () => {
  const schema = schemaOf([number('a'), number('b', 'a', ['a'])]);
  const issues = issuesOf({
    schema,
    base: { a: MAX_DSL_VALUE },
    bonuses: [{ source: 's', targets: ['a'], amount: 1 }],
  });
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.code]),
    [
      ['base.a', 'out_of_range'],
      ['fields.1.derived.expression', 'out_of_range'],
    ],
  );
});

test('duplicate field ids are rejected', () => {
  const issues = issuesOf({ schema: schemaOf([number('a'), number('a')]), base: { a: 1 }, bonuses: [] });
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.code]),
    [['fields.1.id', 'duplicate']],
  );
});

test('a long dependency chain resolves without stack overflow', () => {
  const length = 20_000;
  const fields = [number('f0')];
  for (let index = 1; index < length; index += 1) {
    const previous = `f${index - 1}`;
    fields.push(number(`f${index}`, `${previous} + 0`, [previous]));
  }
  const result = computeDerivedStats({ schema: schemaOf(fields.reverse()), base: { f0: 1 }, bonuses: [] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.values[`f${length - 1}`], 1);
});

test('only numeric widgets take part in derived stats', () => {
  const text: SheetField = { id: 'name', widget: 'text', custom: false, visibility: 'public' };
  const schema = schemaOf([text, number('a'), { ...number('b', 'a', ['a']), widget: 'resource' }]);
  const result = computeDerivedStats({ schema, base: { a: 2 }, bonuses: [] });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.values, { a: 2, b: 2 });
  const issues = issuesOf({
    schema: schemaOf([text, number('a'), number('b', 'a + name', ['a', 'name'])]),
    base: { a: 2, name: 3 },
    bonuses: [{ source: 's', targets: ['name'], amount: 1 }],
  });
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.code]),
    [
      ['base.name', 'invalid'],
      ['bonuses.0.targets.0', 'invalid'],
      ['fields.2.derived.refs.1', 'invalid'],
    ],
  );
});

test('constraints with min above max or an unknown mode are rejected', () => {
  const issues = issuesOf({
    schema: schemaOf([number('a')]),
    base: { a: 1 },
    bonuses: [],
    constraints: [
      { field: 'a', min: 5, max: 1, onViolation: 'clamp' },
      { field: 'a', onViolation: 'explode' as 'clamp' },
    ],
  });
  assert.deepEqual(
    issues.map((issue) => [issue.path, issue.code]),
    [
      ['constraints.0', 'invalid'],
      ['constraints.1.onViolation', 'invalid'],
    ],
  );
});
