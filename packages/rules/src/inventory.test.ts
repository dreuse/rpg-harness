import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptCheck, createSheet, D20_LITE_RULES, DRAUGHT, levelUp, MAX_LEVEL, XP_PER_LEVEL } from './d20-lite.ts';
import type { Rng } from './dice.ts';
import { activeModifiers, applyEffect, endEffect, equip, type ModifierSource, unequip } from './inventory.ts';
import { resolveAction } from './resolve.ts';
import type { Trait, TraitSheet } from './traits.ts';

const HALF = 0.5;
const D20 = 20;
const AVERAGE = 5;
const ACTION_ID = 'act-1';
const CHECK_FACE = 10;
const CHECK_DC = 13;
const SWORD_EDGE = 2;
const BLESSING_EDGE = 1;
const WOUNDED_HP = 2;
const DRAUGHTS = 1;
const DRAUGHT_STOCK = 3;
const SECOND_LEVEL = 2;

const sword: ModifierSource = { id: 'longsword', modifiers: { edge: SWORD_EDGE } };
const blessing: ModifierSource = { id: 'blessed', modifiers: { edge: BLESSING_EDGE } };
const lantern: ModifierSource = { id: 'lantern', modifiers: {} };

const d20 = (face: number): Rng => {
  const queue = [(face - 1 + HALF) / D20];
  return () => queue.shift() ?? Number.NaN;
};

const hero = () =>
  createSheet({
    characterId: 'hero' as TraitSheet['characterId'],
    attributes: { might: AVERAGE, agility: AVERAGE, wits: AVERAGE, presence: AVERAGE },
  });

const withTrait = (sheet: TraitSheet, next: Trait): TraitSheet => ({
  ...sheet,
  traits: sheet.traits.some((trait) => trait.id === next.id)
    ? sheet.traits.map((trait) => (trait.id === next.id ? next : trait))
    : [...sheet.traits, next],
});

const unwrap = <T extends { ok: boolean }>(result: T) => {
  assert.ok(result.ok, JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};

const check = (sheet: TraitSheet, edge = 0) =>
  attemptCheck({ actionId: ACTION_ID, sheet, attribute: 'wits', dc: CHECK_DC, rng: d20(CHECK_FACE), edge });

const outcome = (result: ReturnType<typeof check>) => (result.ok ? result.events.map(({ event }) => event) : []);

const traitOf = (sheet: TraitSheet, id: string) => sheet.traits.find((trait) => trait.id === id);

test('track equipment, resources, effects and progression through ruleset-specific actions', () => {
  const armed = unwrap(equip(hero(), sword.id)).sheet;
  const blessed = unwrap(applyEffect(armed, blessing.id)).sheet;
  const modifiers = activeModifiers(blessed, [sword], [blessing]);
  assert.deepEqual(modifiers, { edge: SWORD_EDGE + BLESSING_EDGE });
  assert.deepEqual(outcome(check(blessed, modifiers.edge)), ['check.success']);

  const wounded = withTrait(withTrait(blessed, { id: 'hp', kind: 'resource', current: WOUNDED_HP, max: 8 }), {
    id: DRAUGHT,
    kind: 'resource',
    current: DRAUGHTS,
    max: DRAUGHT_STOCK,
  });
  const drunk = unwrap(
    resolveAction({ actionId: ACTION_ID, rule: D20_LITE_RULES.drinkDraught, sheet: wounded, rng: d20(1) }),
  );
  assert.deepEqual(traitOf(drunk.sheet, DRAUGHT), { id: DRAUGHT, kind: 'resource', current: 0, max: DRAUGHT_STOCK });
  assert.ok((traitOf(drunk.sheet, 'hp') as { current: number }).current > WOUNDED_HP);
  assert.deepEqual(
    drunk.events.map(({ event }) => event),
    ['draught.drunk'],
  );

  const ready = withTrait(drunk.sheet, { id: 'xp', kind: 'trait', value: XP_PER_LEVEL });
  const promoted = unwrap(levelUp(ready)).sheet;
  assert.deepEqual(traitOf(promoted, 'level'), { id: 'level', kind: 'trait', value: SECOND_LEVEL });

  const narrative: TraitSheet = { characterId: 'scribe' as TraitSheet['characterId'], traits: [] };
  const lit = unwrap(applyEffect(unwrap(equip(narrative, lantern.id)).sheet, 'haunted')).sheet;
  assert.deepEqual(activeModifiers(lit, [lantern], []), {});
  assert.deepEqual(
    lit.traits.map(({ kind }) => kind),
    ['tag', 'condition'],
  );
});

test('unequipped modifiers disappear; impossible item spend and illegal level-up are rejected', () => {
  const geared = unwrap(applyEffect(unwrap(equip(hero(), sword.id)).sheet, blessing.id)).sheet;
  const stripped = unwrap(endEffect(unwrap(unequip(geared, sword.id)).sheet, blessing.id)).sheet;
  assert.deepEqual(activeModifiers(stripped, [sword], [blessing]), {});
  assert.deepEqual(stripped, hero());
  assert.deepEqual(outcome(check(stripped, activeModifiers(stripped, [sword], [blessing]).edge)), ['check.failure']);

  const rejected = (result: { ok: boolean; error?: { code: string } }) => {
    assert.equal(result.ok, false);
    return result.error?.code;
  };
  assert.equal(rejected(unequip(hero(), sword.id)), 'PreconditionFailed');
  assert.equal(rejected(equip(geared, sword.id)), 'PreconditionFailed');
  assert.equal(rejected(endEffect(hero(), blessing.id)), 'PreconditionFailed');
  assert.equal(rejected(applyEffect(geared, blessing.id)), 'PreconditionFailed');

  const empty = withTrait(hero(), { id: DRAUGHT, kind: 'resource', current: 0, max: DRAUGHT_STOCK });
  const spend = resolveAction({ actionId: ACTION_ID, rule: D20_LITE_RULES.drinkDraught, sheet: empty, rng: d20(1) });
  assert.equal(rejected(spend), 'InsufficientResource');
  const unstocked = resolveAction({
    actionId: ACTION_ID,
    rule: D20_LITE_RULES.drinkDraught,
    sheet: hero(),
    rng: d20(1),
  });
  assert.equal(rejected(unstocked), 'UnknownReference');

  assert.equal(rejected(levelUp(hero())), 'PreconditionFailed');
  const capped = withTrait(withTrait(hero(), { id: 'level', kind: 'trait', value: MAX_LEVEL }), {
    id: 'xp',
    kind: 'trait',
    value: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(rejected(levelUp(capped)), 'PreconditionFailed');
});

test('rejects an empty or non-string effect and item id', () => {
  for (const bad of ['', undefined, 7] as unknown as string[]) {
    assert.equal(applyEffect(hero(), bad).ok, false);
    assert.equal(equip(hero(), bad).ok, false);
  }
});
