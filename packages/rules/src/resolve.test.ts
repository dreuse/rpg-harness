import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeededRng, ROLL_EVENT_TYPE } from './dice.ts';
import { MAX_DSL_VALUE, RULE_DSL_VERSION } from './dsl.ts';
import { type ActionResolution, resolveAction } from './resolve.ts';
import type { TraitSheet } from './traits.ts';

const SEED = 42;
const ACTION_ID = 'action-1';
const FOCUS_MAX = 5;
const FOCUS_START = 3;
const VIGOR_START = 2;
const VIGOR_MAX = 10;
const SKILL = 4;
const SITUATION_BONUS = 1;
const COST = 2;
const GAIN = 1;
const DICE_SIDES = 6;
const DICE_COUNT = 2;

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const sheet = (): TraitSheet =>
  deepFreeze({
    characterId: 'hero' as TraitSheet['characterId'],
    traits: [
      { id: 'skill', kind: 'trait', value: SKILL },
      { id: 'focus', kind: 'resource', current: FOCUS_START, max: FOCUS_MAX },
      { id: 'vigor', kind: 'resource', current: VIGOR_START, max: VIGOR_MAX },
      { id: 'outcome', kind: 'trait', value: 0 },
      { id: 'mood', kind: 'trait', value: 'calm' },
    ],
  });

const constant = (value: number) => ({ kind: 'const', value });
const ref = (id: string) => ({ kind: 'ref', id });

const action = (overrides: Record<string, unknown> = {}) => ({
  dslVersion: RULE_DSL_VERSION,
  id: 'focused-strike',
  when: { kind: 'compare', op: 'gte', left: ref('focus'), right: constant(COST) },
  costs: [{ kind: 'cost', resource: 'focus', amount: constant(COST) }],
  effects: [
    {
      kind: 'setTrait',
      trait: 'outcome',
      value: {
        kind: 'arith',
        op: 'add',
        left: { kind: 'dice', count: DICE_COUNT, sides: DICE_SIDES, modifier: 0 },
        right: { kind: 'arith', op: 'add', left: ref('skill'), right: ref('situation') },
      },
    },
    { kind: 'adjustResource', resource: 'vigor', amount: constant(GAIN) },
    { kind: 'setTrait', trait: 'mood', value: 'tense' },
    { kind: 'emitEvent', event: 'strike.landed' },
  ],
  ...overrides,
});

const DEFAULT_MODIFIERS: Record<string, unknown> = { situation: SITUATION_BONUS };

const run = (rule: unknown, input = sheet(), modifiers = DEFAULT_MODIFIERS) =>
  resolveAction({
    actionId: ACTION_ID,
    rule,
    sheet: input,
    rng: createSeededRng(SEED),
    modifiers: modifiers as Record<string, number>,
  });

const traitOf = (resolution: ActionResolution, id: string) => {
  assert.equal(resolution.ok, true);
  return resolution.ok ? resolution.sheet.traits.find((trait) => trait.id === id) : undefined;
};

const assertUnchangedFailure = (rule: unknown, code: string, input = sheet(), modifiers = DEFAULT_MODIFIERS) => {
  const snapshot = structuredClone(input);
  const result = run(rule, input, modifiers);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.code, code);
  assert.deepEqual(input, snapshot);
  return result;
};

test('R04 executes typed preconditions, modifiers, resource costs and consequences as deterministic transactions', () => {
  const input = sheet();
  const snapshot = structuredClone(input);
  const first = run(action(), input);
  const second = run(action(), input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const [roll] = first.rolls;
  assert.equal(first.rolls.length, 1);
  assert.equal(roll?.type, ROLL_EVENT_TYPE);
  assert.equal(roll?.rollId, `${ACTION_ID}:roll:0`);
  assert.deepEqual(traitOf(first, 'outcome'), {
    id: 'outcome',
    kind: 'trait',
    value: (roll?.total ?? 0) + SKILL + SITUATION_BONUS,
  });
  assert.deepEqual(traitOf(first, 'focus'), {
    id: 'focus',
    kind: 'resource',
    current: FOCUS_START - COST,
    max: FOCUS_MAX,
  });
  assert.deepEqual(traitOf(first, 'vigor'), {
    id: 'vigor',
    kind: 'resource',
    current: VIGOR_START + GAIN,
    max: VIGOR_MAX,
  });
  assert.deepEqual(traitOf(first, 'mood'), { id: 'mood', kind: 'trait', value: 'tense' });
  assert.deepEqual(
    first.changes.map((change) => change.id),
    ['focus', 'outcome', 'vigor', 'mood'],
  );
  assert.deepEqual(first.events, [{ actionId: ACTION_ID, ruleId: 'focused-strike', event: 'strike.landed' }]);
});

test('R04 keeps the highest dice when a keep clause is present', () => {
  const rule = action({
    effects: [
      {
        kind: 'setTrait',
        trait: 'outcome',
        value: {
          kind: 'dice',
          count: DICE_COUNT,
          sides: DICE_SIDES,
          modifier: 0,
          keep: { which: 'highest', count: 1 },
        },
      },
    ],
  });
  const result = run(rule);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(traitOf(result, 'outcome'), {
    id: 'outcome',
    kind: 'trait',
    value: Math.max(...(result.rolls[0]?.draws.flat() ?? [])),
  });
});

test('R04 failed precondition leaves all state unchanged', () => {
  assertUnchangedFailure(
    action({ when: { kind: 'compare', op: 'gt', left: ref('focus'), right: constant(FOCUS_MAX) } }),
    'PreconditionFailed',
  );
});

test('R04 insufficient resources leave all state unchanged', () => {
  assertUnchangedFailure(
    action({ costs: [{ kind: 'cost', resource: 'focus', amount: constant(FOCUS_MAX) }] }),
    'InsufficientResource',
  );
});

test('R04 unknown resource or reference leaves all state unchanged', () => {
  assertUnchangedFailure(
    action({ costs: [{ kind: 'cost', resource: 'mana', amount: constant(COST) }] }),
    'UnknownReference',
  );
  assertUnchangedFailure(
    action({ when: { kind: 'compare', op: 'gte', left: ref('luck'), right: constant(COST) } }),
    'UnknownReference',
  );
});

test('R04 invalid action leaves all state unchanged', () => {
  const result = assertUnchangedFailure({ ...action(), effects: 'run arbitrary code' }, 'InvalidAction');
  assert.equal(result.ok ? undefined : result.error.issues[0]?.path, 'effects');
});

test('R04 does not deduct a cost when a later effect fails', () => {
  const input = sheet();
  const result = assertUnchangedFailure(
    action({
      effects: [
        { kind: 'adjustResource', resource: 'vigor', amount: constant(GAIN) },
        { kind: 'adjustResource', resource: 'vigor', amount: constant(-VIGOR_MAX * 2) },
      ],
    }),
    'InsufficientResource',
    input,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(
    input.traits.find((trait) => trait.id === 'focus'),
    { id: 'focus', kind: 'resource', current: FOCUS_START, max: FOCUS_MAX },
  );
});

const BAD_MODIFIERS = [Number.NaN, Number.POSITIVE_INFINITY, 'two', MAX_DSL_VALUE + 1];
const LARGE = Number.MAX_VALUE;
const NEGATIVE_START = -2;

const ruleUsing = (placement: 'cost' | 'setTrait' | 'adjust') => {
  const amount = ref('bonus');
  if (placement === 'cost') return action({ costs: [{ kind: 'cost', resource: 'focus', amount }] });
  if (placement === 'setTrait') return action({ effects: [{ kind: 'setTrait', trait: 'outcome', value: amount }] });
  return action({ effects: [{ kind: 'adjustResource', resource: 'vigor', amount }] });
};

const outcomeOf = (rule: unknown, input = sheet(), modifiers = DEFAULT_MODIFIERS) => {
  const result = run(rule, input, modifiers);
  const trait = traitOf(result, 'outcome');
  return trait?.kind === 'trait' ? trait.value : undefined;
};

const setOutcome = (value: unknown) => action({ effects: [{ kind: 'setTrait', trait: 'outcome', value }] });

const withTraits = (...extra: unknown[]) =>
  deepFreeze({ ...sheet(), traits: [...structuredClone(sheet().traits), ...extra] }) as TraitSheet;

test('R04 rejects non-finite, out-of-range or non-number modifiers as invalid actions', () => {
  for (const bad of BAD_MODIFIERS) {
    for (const placement of ['cost', 'setTrait', 'adjust'] as const) {
      const result = assertUnchangedFailure(ruleUsing(placement), 'InvalidAction', sheet(), { bonus: bad });
      assert.equal(result.ok ? undefined : result.error.issues[0]?.path, 'modifiers.bonus');
    }
  }
});

test('R04 rejects a non-finite derived value as an invalid amount', () => {
  const input = withTraits(
    { id: 'huge', kind: 'trait', value: LARGE },
    { id: 'overflow', kind: 'derived', op: 'sum', refs: ['huge', 'huge'], offset: 0 },
  );
  assertUnchangedFailure(setOutcome(ref('overflow')), 'InvalidAmount', input);
});

test('R04 rejects a reference that names both a trait and a modifier', () => {
  assertUnchangedFailure(setOutcome(ref('skill')), 'UnknownReference', sheet(), { skill: SITUATION_BONUS });
});

test('R04 rejects a negative cost as an invalid amount', () => {
  assertUnchangedFailure(
    action({ costs: [{ kind: 'cost', resource: 'focus', amount: constant(-COST) }] }),
    'InvalidAmount',
  );
});

test('R04 reports dice the roller cannot roll as a failed roll', () => {
  assertUnchangedFailure(setOutcome({ kind: 'dice', count: 1, sides: 1, modifier: 0 }), 'RollFailed');
});

test('R04 evaluates or and not conditions', () => {
  const failing = { kind: 'compare', op: 'lt', left: ref('skill'), right: constant(0) };
  assert.equal(run(action({ when: { kind: 'or', any: [failing, { kind: 'not', condition: failing }] } })).ok, true);
  assertUnchangedFailure(action({ when: { kind: 'or', any: [failing, failing] } }), 'PreconditionFailed');
});

test('R04 reads a derived trait through a reference', () => {
  const input = withTraits({ id: 'total', kind: 'derived', op: 'sum', refs: ['skill', 'focus'], offset: GAIN });
  assert.equal(outcomeOf(setOutcome(ref('total')), input), SKILL + FOCUS_START - COST + GAIN);
});

test('R04 keeps the lowest dice when a keep clause asks for it', () => {
  const rule = setOutcome({
    kind: 'dice',
    count: DICE_COUNT,
    sides: DICE_SIDES,
    modifier: 0,
    keep: { which: 'lowest', count: 1 },
  });
  const result = run(rule);
  assert.equal(result.ok, true);
  assert.equal(outcomeOf(rule), Math.min(...(result.ok ? (result.rolls[0]?.draws.flat() ?? []) : [])));
});

test('R04 lets a resource below zero still gain', () => {
  const input = deepFreeze({
    ...sheet(),
    traits: sheet().traits.map((trait) =>
      trait.id === 'vigor' ? { ...trait, current: NEGATIVE_START } : structuredClone(trait),
    ),
  }) as TraitSheet;
  const result = run(
    action({ effects: [{ kind: 'adjustResource', resource: 'vigor', amount: constant(GAIN) }] }),
    input,
  );
  assert.deepEqual(traitOf(result, 'vigor'), {
    id: 'vigor',
    kind: 'resource',
    current: NEGATIVE_START + GAIN,
    max: VIGOR_MAX,
  });
});
