import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDerived, TRAIT_KINDS, validateTraitSheet } from './traits.ts';

const PROTO_KEY = '__proto__';

const sheet = (traits: unknown[]) => ({ characterId: 'hero', traits });

const issuePaths = (input: unknown) => {
  const result = validateTraitSheet(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

test('model typed traits, resources, tags, conditions and derived fields without hardcoded game stats', () => {
  const input = sheet([
    { id: 'grit', kind: 'trait', value: 3 },
    { id: 'calling', kind: 'trait', value: 'cartographer' },
    { id: 'sworn', kind: 'trait', value: true },
    { id: 'stamina', kind: 'resource', current: 4, max: 6 },
    { id: 'outlaw', kind: 'tag' },
    { id: 'shaken', kind: 'condition' },
    { id: 'resolve', kind: 'derived', op: 'sum', refs: ['grit', 'stamina'], offset: 1 },
    { id: 'peak', kind: 'derived', op: 'max', refs: ['grit', 'resolve'], offset: 0 },
  ]);
  const result = validateTraitSheet(input);
  assert.ok(result.ok);
  assert.deepEqual(result.sheet, input);
  assert.deepEqual(resolveDerived(result.sheet), { resolve: 8, peak: 8 });
  assert.deepEqual([...TRAIT_KINDS], ['trait', 'resource', 'tag', 'condition', 'derived']);
});

test('narrative-only characters work with zero numerical attributes', () => {
  const input = sheet([
    { id: 'background', kind: 'trait', value: 'exiled scribe' },
    { id: 'haunted', kind: 'tag' },
    { id: 'grieving', kind: 'condition' },
  ]);
  const result = validateTraitSheet(input);
  assert.ok(result.ok);
  assert.deepEqual(resolveDerived(result.sheet), {});
  assert.ok(validateTraitSheet(sheet([])).ok);
});

test('rejects malformed and unknown trait input at the boundary', () => {
  assert.deepEqual(issuePaths(null), ['']);
  assert.deepEqual(issuePaths({ characterId: '', traits: {} }), ['characterId', 'traits']);
  assert.deepEqual(
    issuePaths(
      sheet([
        { id: 'a', kind: 'stat', value: 1 },
        { id: 'b', kind: 'trait', value: { nested: true } },
        { id: 'c', kind: 'resource', current: 7, max: 6 },
        { id: 'd', kind: 'resource', current: '1', max: Number.POSITIVE_INFINITY },
        { id: 'e', kind: 'derived', op: 'eval', refs: ['a'], offset: 0 },
        { id: 'f', kind: 'derived', op: 'sum', refs: 'a+b', offset: 'x' },
        { kind: 'tag' },
        'shaken',
        { id: 'g', kind: 'trait', value: Number.NaN },
        [{ id: 'h', kind: 'tag' }],
        new (class {
          id = 'i';
          kind = 'tag';
        })(),
      ]),
    ),
    [
      'traits.0.kind',
      'traits.1.value',
      'traits.2.current',
      'traits.3.current',
      'traits.3.max',
      'traits.4.op',
      'traits.5.refs',
      'traits.5.offset',
      'traits.6.id',
      'traits.7',
      'traits.8.value',
      'traits.9',
      'traits.10',
    ],
  );
});

test('rejects duplicate ids, dangling or non-numeric references and derivation cycles', () => {
  assert.deepEqual(
    issuePaths(
      sheet([
        { id: 'a', kind: 'tag' },
        { id: 'a', kind: 'condition' },
        { id: 'name', kind: 'trait', value: 'x' },
        { id: 'b', kind: 'derived', op: 'sum', refs: ['missing', 'name', 'a'], offset: 0 },
      ]),
    ),
    ['traits.1.id', 'traits.3.refs.0', 'traits.3.refs.1', 'traits.3.refs.2'],
  );
  assert.deepEqual(
    issuePaths(
      sheet([
        { id: 'x', kind: 'derived', op: 'sum', refs: ['y'], offset: 0 },
        { id: 'y', kind: 'derived', op: 'min', refs: ['x'], offset: 0 },
        { id: 'self', kind: 'derived', op: 'sum', refs: ['self'], offset: 0 },
      ]),
    ),
    ['traits.0.refs', 'traits.1.refs', 'traits.2.refs'],
  );
});

test('treats a __proto__ trait id as plain data', () => {
  const result = validateTraitSheet(
    sheet([
      { id: 'base', kind: 'trait', value: 2 },
      { id: PROTO_KEY, kind: 'derived', op: 'sum', refs: ['base'], offset: 0 },
    ]),
  );
  assert.ok(result.ok);
  const resolved = resolveDerived(result.sheet);
  assert.ok(Object.hasOwn(resolved, PROTO_KEY));
  assert.equal(Object.getPrototypeOf(resolved), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(resolved, PROTO_KEY)?.value, 2);
});
