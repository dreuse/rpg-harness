import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RulePackLink } from '../../domain/src/character.ts';
import { appendRevision, type CharacterRevision, type RevisionInput } from './character-audit.ts';

const RULEPACK: RulePackLink = { id: 'd20-lite', edition: '1', revision: 'r1' };
const FULL_HP = 10;
const WOUNDED_HP = 7;
const CRITICAL_HP = 3;
const ORIGINAL_STORY = 'Raised by wolves.';
const FIXED_TYPO = 'Raised by monks.';
const GROWN_STORY = 'Raised by monks; swore vengeance after the fire.';

const revision = (overrides: Partial<RevisionInput> = {}): RevisionInput => ({
  characterId: 'hero',
  kind: 'resource',
  targetId: 'hp',
  origin: 'in-world',
  cause: 'evt-1',
  source: 'act-1',
  rulepack: RULEPACK,
  previous: FULL_HP,
  next: WOUNDED_HP,
  ...overrides,
});

const appendAll = (inputs: readonly RevisionInput[]): readonly CharacterRevision[] =>
  inputs.reduce<readonly CharacterRevision[]>((log, input) => {
    const result = appendRevision(log, input);
    assert.ok(result.ok);
    return result.log;
  }, []);

test('track every resource, backstory and equipment revision with cause and source', () => {
  const inputs = [
    revision(),
    revision({ kind: 'backstory', targetId: 'background', previous: ORIGINAL_STORY, next: GROWN_STORY }),
    revision({
      kind: 'equipment',
      targetId: 'longsword',
      cause: 'evt-2',
      source: 'act-2',
      previous: false,
      next: true,
    }),
  ];
  const log = appendAll(inputs);
  assert.deepEqual(log, inputs);
  assert.ok(Object.isFrozen(log));
  assert.ok(log.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.rulepack)));
});

test('appending leaves the previous log unchanged', () => {
  const first = appendAll([revision()]);
  const result = appendRevision(first, revision({ cause: 'evt-2', previous: WOUNDED_HP, next: CRITICAL_HP }));
  assert.ok(result.ok);
  assert.equal(first.length, 1);
  assert.equal(result.log.length, 2);
});

test('manual backstory correction is distinguishable from in-world character development', () => {
  const log = appendAll([
    revision({
      kind: 'backstory',
      targetId: 'background',
      origin: 'manual-correction',
      cause: 'edit-1',
      source: 'player',
      previous: ORIGINAL_STORY,
      next: FIXED_TYPO,
    }),
    revision({ kind: 'backstory', targetId: 'background', previous: FIXED_TYPO, next: GROWN_STORY }),
  ]);
  const [correction, development] = log;
  assert.equal(correction?.origin, 'manual-correction');
  assert.equal(development?.origin, 'in-world');
  assert.notEqual(correction?.cause, development?.cause);
});

for (const field of ['cause', 'source'] as const)
  test(`rejects a revision without a ${field}`, () => {
    for (const value of [undefined, '']) {
      const result = appendRevision([], { ...revision(), [field]: value });
      assert.deepEqual(result, {
        ok: false,
        error: { code: 'InvalidAction', issues: [{ path: field, message: 'must be a non-empty string' }] },
      });
    }
  });

test('rejects unknown kinds, origins and an incomplete rulepack', () => {
  const result = appendRevision([], {
    ...revision(),
    kind: 'hit-points',
    origin: 'retcon',
    rulepack: { id: 'd20-lite', edition: '', revision: 'r1' },
  });
  assert.ok(!result.ok);
  assert.deepEqual(
    result.error.issues.map(({ path }) => path),
    ['kind', 'origin', 'rulepack.edition'],
  );
});

test('rejects values that do not match the revision kind', () => {
  const cases: readonly RevisionInput[] = [
    revision({ next: 'seven' }),
    revision({ kind: 'backstory', previous: ORIGINAL_STORY, next: FULL_HP }),
    revision({ kind: 'equipment', previous: false, next: 'yes' }),
  ];
  for (const input of cases) {
    const result = appendRevision([], input);
    assert.ok(!result.ok);
    assert.deepEqual(
      result.error.issues.map(({ path }) => path),
      ['next'],
    );
  }
});

test('rejects a revision that changes nothing', () => {
  const result = appendRevision([], revision({ next: FULL_HP }));
  assert.ok(!result.ok);
  assert.deepEqual(result.error.issues, [{ path: 'next', message: 'must differ from previous' }]);
});

test('accepts a chain where each previous equals the latest recorded value', () => {
  const log = appendAll([revision(), revision({ cause: 'evt-2', previous: WOUNDED_HP, next: CRITICAL_HP })]);
  assert.equal(log.length, 2);
});

test('accepts a first entry for a new target', () => {
  const log = appendAll([revision(), revision({ targetId: 'mana', previous: FULL_HP, next: CRITICAL_HP })]);
  assert.equal(log.length, 2);
});

test('rejects a previous that does not equal the latest recorded value', () => {
  const log = appendAll([revision()]);
  const result = appendRevision(log, revision({ cause: 'evt-2', previous: FULL_HP, next: CRITICAL_HP }));
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'InvalidAction', issues: [{ path: 'previous', message: 'must equal the latest recorded value' }] },
  });
});

test('rejects a kind that differs from the latest entry for the same target', () => {
  const log = appendAll([revision()]);
  const result = appendRevision(log, revision({ kind: 'backstory', previous: ORIGINAL_STORY, next: GROWN_STORY }));
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'InvalidAction', issues: [{ path: 'kind', message: 'must equal the latest recorded kind' }] },
  });
});

test('reads each input field once', () => {
  let reads = 0;
  const input = {
    ...revision(),
    get next() {
      reads += 1;
      return reads === 1 ? WOUNDED_HP : 'seven';
    },
  };
  const result = appendRevision([], input);
  assert.ok(result.ok);
  assert.equal(result.log[0]?.next, WOUNDED_HP);
});
