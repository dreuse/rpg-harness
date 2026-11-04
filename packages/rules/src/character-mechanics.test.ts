import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceEffects,
  applyTimedEffect,
  type CharacterMechanics,
  checkMortality,
  effectModifiers,
  gainProgress,
  recover,
  resurrect,
  validateMechanics,
} from './character-mechanics.ts';
import type { Rng } from './dice.ts';
import { RULE_DSL_VERSION } from './dsl.ts';
import { type Trait, type TraitSheet, validateTraitSheet } from './traits.ts';

const CAUSE = 'evt-1';
const RULEPACK = { id: 'ember-tales', edition: 'original', revision: '2' };
const VIGOR_MAX = 5;
const WOUNDED = 2;
const FULL_REST = 100;
const INSPIRED_EDGE = 1;
const RALLIED_EDGE = 2;
const BLEED = -1;
const INSPIRED_TURNS = 2;
const REVIVED_VIGOR = 1;
const RENOWN_GAIN = 35;
const SECOND_RANK = 10;
const THIRD_RANK = 30;
const THIRD = 3;
const HALF = 0.5;
const DIE_SIDES = 4;
const OVERDRAW = -100;

const noRolls: Rng = () => Number.NaN;
const midRoll: Rng = () => HALF;

const declared = {
  rulepack: RULEPACK,
  effects: {
    inspired: { modifiers: { edge: INSPIRED_EDGE }, stacking: 'highest', group: 'morale', duration: INSPIRED_TURNS },
    rallied: { modifiers: { edge: RALLIED_EDGE }, stacking: 'highest', group: 'morale' },
    bleeding: { modifiers: { toughness: BLEED }, stacking: 'stack', duration: 1 },
    guarded: { modifiers: { guard: 1 }, stacking: 'replace', group: 'stance' },
    reckless: { modifiers: { edge: 1 }, stacking: 'replace', group: 'stance' },
    shaken: { modifiers: {}, stacking: 'replace', duration: INSPIRED_TURNS },
  },
  recovery: {
    rest: {
      rule: {
        dslVersion: RULE_DSL_VERSION,
        id: 'rest',
        effects: [
          { kind: 'adjustResource', resource: 'vigor', amount: { kind: 'const', value: FULL_REST } },
          { kind: 'emitEvent', event: 'rested' },
        ],
      },
      clears: ['shaken'],
    },
  },
  mortality: {
    resource: 'vigor',
    threshold: 0,
    condition: 'fallen',
    resurrection: { restore: REVIVED_VIGOR, clears: ['bleeding'] },
  },
  progression: { xp: 'renown', level: 'rank', firstLevel: 1, thresholds: [SECOND_RANK, THIRD_RANK] },
};

const load = (input: unknown): CharacterMechanics => {
  const result = validateMechanics(input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.mechanics;
};

const wanderer = (vigor = WOUNDED): TraitSheet => ({
  characterId: 'wanderer' as TraitSheet['characterId'],
  traits: [
    { id: 'vigor', kind: 'resource', current: vigor, max: VIGOR_MAX },
    { id: 'renown', kind: 'trait', value: 0 },
    { id: 'rank', kind: 'trait', value: 1 },
  ],
});

const unwrap = <T extends { ok: boolean }>(result: T) => {
  assert.ok(result.ok, JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const codeOf = (result: { ok: boolean; error?: { code: string } }) => {
  assert.equal(result.ok, false);
  return result.error?.code;
};

const traitOf = (sheet: TraitSheet, id: string): Trait | undefined => sheet.traits.find((trait) => trait.id === id);
const names = (result: { events: { event: string }[] }) => result.events.map(({ event }) => event);

test('apply temporary modifiers, conditions, recovery, mortality and progression per rulepack', () => {
  const mechanics = load(declared);
  let sheet = wanderer();
  const step = (result: ReturnType<typeof applyTimedEffect>) => {
    const ok = unwrap(result);
    for (const event of ok.events) {
      assert.equal(event.cause, CAUSE);
      assert.deepEqual(event.rulepack, RULEPACK);
    }
    sheet = ok.sheet;
    return ok;
  };
  const apply = (effectId: string) => step(applyTimedEffect({ sheet, mechanics, cause: CAUSE, effectId }));

  apply('inspired');
  apply('rallied');
  assert.deepEqual(effectModifiers(sheet, mechanics), { edge: RALLIED_EDGE });

  assert.deepEqual(names(apply('bleeding')), ['effect.applied']);
  assert.deepEqual(names(apply('bleeding')), ['effect.stacked']);
  assert.deepEqual(traitOf(sheet, 'bleeding'), { id: 'bleeding', kind: 'condition', stacks: 2, remaining: 1 });
  assert.deepEqual(effectModifiers(sheet, mechanics), { edge: RALLIED_EDGE, toughness: 2 * BLEED });

  const ticked = step(advanceEffects({ sheet, mechanics, cause: CAUSE }));
  assert.deepEqual(ticked.events, [{ event: 'effect.expired', subject: 'bleeding', cause: CAUSE, rulepack: RULEPACK }]);
  assert.deepEqual(traitOf(sheet, 'inspired'), { id: 'inspired', kind: 'condition', remaining: 1 });
  assert.equal(traitOf(sheet, 'bleeding'), undefined);

  apply('guarded');
  assert.deepEqual(names(apply('reckless')), ['effect.replaced', 'effect.applied']);
  assert.equal(traitOf(sheet, 'guarded'), undefined);

  apply('shaken');
  const rested = step(recover({ sheet, mechanics, cause: CAUSE, kind: 'rest', rng: noRolls }));
  assert.deepEqual(rested.changes, [{ id: 'vigor', from: WOUNDED, to: VIGOR_MAX }]);
  assert.deepEqual(names(rested), ['rested', 'effect.ended']);
  assert.equal(traitOf(sheet, 'shaken'), undefined);

  const promoted = step(gainProgress({ sheet, mechanics, cause: CAUSE, amount: RENOWN_GAIN }));
  assert.deepEqual(promoted.changes, [
    { id: 'renown', from: 0, to: RENOWN_GAIN },
    { id: 'rank', from: 1, to: THIRD },
  ]);
  assert.deepEqual(names(promoted), ['progression.gained', 'progression.levelled']);
  assert.ok(validateTraitSheet(sheet).ok);
});

test('death/resurrection and effect stacking honor configured mechanics', () => {
  const mechanics = load(declared);
  const input = { mechanics, cause: CAUSE };
  const fell = unwrap(checkMortality({ ...input, sheet: wanderer(0) }));
  assert.deepEqual(fell.events, [{ event: 'character.died', subject: 'fallen', cause: CAUSE, rulepack: RULEPACK }]);
  assert.deepEqual(unwrap(checkMortality({ ...input, sheet: fell.sheet })).events, []);
  assert.deepEqual(unwrap(checkMortality({ ...input, sheet: wanderer() })).events, []);

  assert.equal(codeOf(recover({ ...input, sheet: fell.sheet, kind: 'rest', rng: noRolls })), 'PreconditionFailed');
  const bled = unwrap(applyTimedEffect({ ...input, sheet: fell.sheet, effectId: 'bleeding' })).sheet;
  const revived = unwrap(resurrect({ ...input, sheet: bled }));
  assert.deepEqual(revived.sheet, wanderer(REVIVED_VIGOR));
  assert.deepEqual(names(revived), ['character.resurrected', 'effect.ended']);
  assert.equal(codeOf(resurrect({ ...input, sheet: revived.sheet })), 'PreconditionFailed');

  const permadeath = load({ ...declared, mortality: { ...declared.mortality, resurrection: undefined } });
  const final = unwrap(checkMortality({ mechanics: permadeath, cause: CAUSE, sheet: wanderer(0) })).sheet;
  assert.equal(codeOf(resurrect({ mechanics: permadeath, cause: CAUSE, sheet: final })), 'CapabilityDisabled');

  const deathless = load({ rulepack: RULEPACK });
  const spared = unwrap(checkMortality({ mechanics: deathless, cause: CAUSE, sheet: wanderer(0) }));
  assert.deepEqual(spared.sheet, wanderer(0));
  assert.deepEqual(spared.events, []);
  assert.equal(codeOf(resurrect({ mechanics: deathless, cause: CAUSE, sheet: wanderer(0) })), 'CapabilityDisabled');
  assert.equal(
    codeOf(applyTimedEffect({ mechanics: deathless, cause: CAUSE, sheet: wanderer(), effectId: 'inspired' })),
    'CapabilityDisabled',
  );
  assert.equal(
    codeOf(recover({ mechanics: deathless, cause: CAUSE, sheet: wanderer(), kind: 'rest', rng: noRolls })),
    'CapabilityDisabled',
  );
  assert.equal(
    codeOf(gainProgress({ mechanics: deathless, cause: CAUSE, sheet: wanderer(), amount: 1 })),
    'CapabilityDisabled',
  );
  const marked: TraitSheet = { ...wanderer(), traits: [...wanderer().traits, { id: 'inspired', kind: 'condition' }] };
  assert.deepEqual(effectModifiers(marked, deathless), {});

  let sheet = unwrap(applyTimedEffect({ ...input, sheet: wanderer(), effectId: 'inspired' })).sheet;
  sheet = unwrap(advanceEffects({ ...input, sheet })).sheet;
  const refreshed = unwrap(applyTimedEffect({ ...input, sheet, effectId: 'inspired' }));
  assert.deepEqual(names(refreshed), ['effect.refreshed']);
  assert.deepEqual(traitOf(refreshed.sheet, 'inspired'), {
    id: 'inspired',
    kind: 'condition',
    remaining: INSPIRED_TURNS,
  });
  assert.deepEqual(effectModifiers(refreshed.sheet, mechanics), { edge: INSPIRED_EDGE });

  assert.equal(codeOf(applyTimedEffect({ ...input, sheet, effectId: '__proto__' })), 'CapabilityDisabled');
  assert.equal(codeOf(applyTimedEffect({ ...input, cause: '', sheet, effectId: 'inspired' })), 'InvalidAction');
  assert.equal(codeOf(gainProgress({ ...input, sheet, amount: -1 })), 'InvalidAmount');
  assert.equal(codeOf(checkMortality({ ...input, sheet: { ...sheet, traits: [] } })), 'UnknownReference');
  assert.equal(codeOf(gainProgress({ ...input, sheet: { ...sheet, traits: [] }, amount: 1 })), 'UnknownReference');
});

test('rejects malformed rulepack mechanics with structured paths', () => {
  const paths = (input: unknown) => {
    const result = validateMechanics(input);
    assert.equal(result.ok, false);
    return result.ok ? [] : result.issues.map(({ path }) => path);
  };
  assert.deepEqual(paths(null), ['']);
  assert.deepEqual(paths({ rulepack: { id: 'x' } }), ['rulepack.edition', 'rulepack.revision']);
  assert.deepEqual(
    paths({
      rulepack: RULEPACK,
      effects: {
        a: { modifiers: { edge: Number.POSITIVE_INFINITY }, stacking: 'sometimes', duration: 0 },
        b: { modifiers: {}, stacking: 'stack', group: 'g' },
        c: { modifiers: {}, stacking: 'highest', group: 'g' },
      },
    }),
    ['effects.a.modifiers.edge', 'effects.a.stacking', 'effects.a.duration', 'effects.c.group'],
  );
  assert.deepEqual(
    paths({
      ...declared,
      recovery: { rest: { rule: { id: 'rest' }, clears: [''] } },
      mortality: { ...declared.mortality, resurrection: { restore: 0 } },
      progression: { ...declared.progression, thresholds: [THIRD_RANK, SECOND_RANK] },
    }),
    [
      'recovery.rest.rule.dslVersion',
      'recovery.rest.rule.effects',
      'recovery.rest.clears.0',
      'mortality.resurrection.restore',
      'progression.thresholds',
    ],
  );
});

test('keeps rolls on failure and guards resurrection, progression and death ids', () => {
  const surge = load({
    ...declared,
    recovery: {
      surge: {
        rule: {
          dslVersion: RULE_DSL_VERSION,
          id: 'surge',
          effects: [
            {
              kind: 'adjustResource',
              resource: 'vigor',
              amount: { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 },
            },
            { kind: 'adjustResource', resource: 'vigor', amount: { kind: 'const', value: OVERDRAW } },
          ],
        },
      },
    },
  });
  const failed = recover({ mechanics: surge, cause: CAUSE, sheet: wanderer(), kind: 'surge', rng: midRoll });
  assert.equal(codeOf(failed), 'InsufficientResource');
  assert.equal(failed.rolls.length, 1);

  const mechanics = load(declared);
  const input = { mechanics, cause: CAUSE };
  const fallen = { id: 'fallen', kind: 'condition' } as const;
  const hollow: TraitSheet = {
    ...wanderer(0),
    traits: [{ id: 'vigor', kind: 'resource', current: 0, max: 0 }, ...wanderer().traits.slice(1), fallen],
  };
  assert.equal(codeOf(resurrect({ ...input, sheet: hollow })), 'PreconditionFailed');
  const steady: TraitSheet = { ...wanderer(REVIVED_VIGOR), traits: [...wanderer(REVIVED_VIGOR).traits, fallen] };
  assert.deepEqual(unwrap(resurrect({ ...input, sheet: steady })).changes, []);

  const saturated: TraitSheet = {
    ...wanderer(),
    traits: wanderer().traits.map((trait) =>
      trait.id === 'renown' ? { ...trait, value: Number.MAX_SAFE_INTEGER } : trait,
    ),
  };
  const overflow = gainProgress({ ...input, sheet: saturated, amount: 1 });
  assert.equal(codeOf(overflow), 'InvalidAmount');
  assert.deepEqual(overflow.ok ? [] : overflow.error.issues.map(({ path }) => path), ['progression.xp']);

  const clash = validateMechanics({
    ...declared,
    mortality: { ...declared.mortality, condition: 'inspired' },
    progression: { ...declared.progression, level: 'renown' },
  });
  assert.equal(clash.ok, false);
  assert.deepEqual(clash.ok ? [] : clash.issues.map(({ path }) => path), ['mortality.condition', 'progression.level']);
});
