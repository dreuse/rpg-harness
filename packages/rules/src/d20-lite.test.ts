import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCharacter } from './character-builder.ts';
import {
  ATTRIBUTE_MAX,
  ATTRIBUTES,
  advanceTurn,
  attack,
  attemptCheck,
  attributeModifier,
  createSheet,
  D20_LITE_CREATION,
  D20_LITE_MANIFEST,
  D20_LITE_RULES,
  DRAUGHT,
  gainExperience,
  rollInitiative,
  XP_PER_LEVEL,
} from './d20-lite.ts';
import { createSeededRng, type Rng, verifyRollClaim } from './dice.ts';
import { RULE_DSL_VERSION } from './dsl.ts';
import { resolveAction } from './resolve.ts';
import { capabilityState, validateManifest } from './rulepack.ts';
import { validateSheetSchema } from './sheet-schema.ts';
import { resolveDerived, type TraitSheet } from './traits.ts';

const D20 = 20;
const HALF = 0.5;
const NATURAL_MAX = 20;
const NATURAL_MIN = 1;
const AVERAGE = 5;
const STRONG = 9;
const FEEBLE = 1;
const EASY_DC = 5;
const HARD_DC = 30;
const ACTION_ID = 'act-1';
const SEED = 7;
const HIGH_FACE = 15;
const LOW_FACE = 3;
const DAMAGE_SIDES = 6;
const DAMAGE_FACE = 4;
const PENALTY = -2;

const faces = (...rolls: [face: number, sides: number][]): Rng => {
  const queue = rolls.map(([face, sides]) => (face - 1 + HALF) / sides);
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('rng exhausted');
    return next;
  };
};

const hero = (attributes: Partial<Record<'might' | 'agility' | 'wits' | 'presence', number>> = {}, id = 'hero') =>
  createSheet({
    characterId: id as TraitSheet['characterId'],
    attributes: { might: AVERAGE, agility: AVERAGE, wits: AVERAGE, presence: AVERAGE, ...attributes },
  });

const numberIn = (sheet: TraitSheet, id: string) => {
  const trait = sheet.traits.find((item) => item.id === id);
  if (trait?.kind === 'resource') return trait.current;
  if (trait?.kind === 'trait') return trait.value;
  return resolveDerived(sheet)[id];
};

const maxOf = (sheet: TraitSheet, id: string) => {
  const trait = sheet.traits.find((item) => item.id === id);
  return trait?.kind === 'resource' ? trait.max : undefined;
};

const eventsOf = (result: ReturnType<typeof attemptCheck>) => (result.ok ? result.events.map((e) => e.event) : []);

test('manifest is valid, original and declares baseline capabilities', () => {
  const parsed = validateManifest(D20_LITE_MANIFEST);
  assert.equal(parsed.ok, true);
  assert.equal(D20_LITE_MANIFEST.id, 'd20-lite');
  for (const capability of ['checks', 'combat', 'resources', 'progression']) {
    assert.equal(capabilityState(D20_LITE_MANIFEST, capability), 'deterministic');
  }
});

test('attribute modifiers are centered on the average score and may be negative', () => {
  assert.equal(attributeModifier(AVERAGE), 0);
  assert.equal(attributeModifier(STRONG), STRONG - AVERAGE);
  assert.equal(attributeModifier(FEEBLE), FEEBLE - AVERAGE);
  assert.throws(() => attributeModifier(Number.NaN), RangeError);
});

test('sheet factory derives modifiers, defense and hit points as data', () => {
  const sheet = hero({ agility: STRONG, wits: FEEBLE });
  assert.equal(numberIn(sheet, 'agility.mod'), STRONG - AVERAGE);
  assert.equal(numberIn(sheet, 'wits.mod'), FEEBLE - AVERAGE);
  assert.ok((numberIn(sheet, 'defense') as number) > (numberIn(hero(), 'defense') as number));
  assert.equal(numberIn(sheet, 'hp'), maxOf(sheet, 'hp'));
  assert.equal(numberIn(sheet, 'level'), 1);
  assert.throws(() => hero({ might: Number.POSITIVE_INFINITY }), RangeError);
});

test('rules are valid DSL documents', () => {
  for (const rule of Object.values(D20_LITE_RULES)) assert.equal(rule.dslVersion, RULE_DSL_VERSION);
});

test('check succeeds when d20 plus modifier meets the DC', () => {
  const result = attemptCheck({
    actionId: ACTION_ID,
    sheet: hero(),
    attribute: 'wits',
    dc: EASY_DC,
    rng: faces([HIGH_FACE, D20]),
  });
  assert.deepEqual(eventsOf(result), ['check.success']);
});

test('check fails below the DC and negative modifiers count', () => {
  const dc = HIGH_FACE;
  const plain = attemptCheck({
    actionId: ACTION_ID,
    sheet: hero(),
    attribute: 'wits',
    dc,
    rng: faces([HIGH_FACE, D20]),
  });
  assert.deepEqual(eventsOf(plain), ['check.success']);
  const weak = hero({ wits: FEEBLE });
  const penalised = attemptCheck({
    actionId: ACTION_ID,
    sheet: weak,
    attribute: 'wits',
    dc,
    rng: faces([HIGH_FACE, D20]),
  });
  assert.deepEqual(eventsOf(penalised), ['check.failure']);
  const situational = attemptCheck({
    actionId: ACTION_ID,
    sheet: hero(),
    attribute: 'wits',
    dc,
    edge: PENALTY,
    rng: faces([HIGH_FACE, D20]),
  });
  assert.deepEqual(eventsOf(situational), ['check.failure']);
});

test('natural 20 is a critical success even against an impossible DC', () => {
  const result = attemptCheck({
    actionId: ACTION_ID,
    sheet: hero({ wits: FEEBLE }),
    attribute: 'wits',
    dc: HARD_DC,
    rng: faces([NATURAL_MAX, D20]),
  });
  assert.deepEqual(eventsOf(result), ['check.critical', 'check.success']);
});

test('natural 1 is a fumble even against a trivial DC', () => {
  const result = attemptCheck({
    actionId: ACTION_ID,
    sheet: hero({ wits: STRONG }),
    attribute: 'wits',
    dc: EASY_DC,
    rng: faces([NATURAL_MIN, D20]),
  });
  assert.deepEqual(eventsOf(result), ['check.fumble', 'check.failure']);
});

test('check records a verifiable d20 roll and is reproducible with a seed', () => {
  const run = () =>
    attemptCheck({ actionId: ACTION_ID, sheet: hero(), attribute: 'might', dc: EASY_DC, rng: createSeededRng(SEED) });
  const first = run();
  assert.equal(first.ok, true);
  assert.deepEqual(eventsOf(first), eventsOf(run()));
  const [roll] = first.rolls;
  assert.ok(roll);
  assert.equal(verifyRollClaim({ rollId: roll.rollId, total: roll.total }, first.rolls).ok, true);
});

const strike = (rng: Rng, attacker = hero(), target = hero({}, 'foe')) =>
  attack({ actionId: ACTION_ID, attacker, target, attribute: 'might', damageSides: DAMAGE_SIDES, rng });

test('a hit reduces target hit points by the damage roll', () => {
  const target = hero({}, 'foe');
  const result = strike(faces([HIGH_FACE, D20], [DAMAGE_FACE, DAMAGE_SIDES]), hero(), target);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.events.map((e) => e.event),
    ['attack.hit'],
  );
  assert.equal(numberIn(result.sheet, 'hp'), (numberIn(target, 'hp') as number) - DAMAGE_FACE);
});

test('a miss leaves hit points unchanged', () => {
  const target = hero({ agility: STRONG }, 'foe');
  const result = strike(faces([LOW_FACE, D20]), hero(), target);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.events.map((e) => e.event),
    ['attack.miss'],
  );
  assert.equal(numberIn(result.sheet, 'hp'), numberIn(target, 'hp'));
});

test('a natural 20 attack doubles damage', () => {
  const target = hero({}, 'foe');
  const result = strike(faces([NATURAL_MAX, D20], [DAMAGE_FACE, DAMAGE_SIDES]), hero(), target);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.events.map((e) => e.event),
    ['attack.critical', 'attack.hit'],
  );
  assert.equal(numberIn(result.sheet, 'hp'), (numberIn(target, 'hp') as number) - 2 * DAMAGE_FACE);
});

test('a natural 1 attack is a fumble and misses', () => {
  const result = strike(faces([NATURAL_MIN, D20]), hero({ might: STRONG }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.events.map((e) => e.event),
    ['attack.fumble', 'attack.miss'],
  );
});

test('a hit always deals at least one damage and hit points never drop below zero', () => {
  const weakling = hero({ might: FEEBLE });
  const target = hero({ agility: FEEBLE }, 'foe');
  const weak = strike(faces([HIGH_FACE, D20], [NATURAL_MIN, DAMAGE_SIDES]), weakling, target);
  assert.equal(weak.ok, true);
  if (!weak.ok) return;
  assert.equal(numberIn(weak.sheet, 'hp'), (numberIn(target, 'hp') as number) - 1);
  const dying = {
    ...target,
    traits: target.traits.map((t) => (t.id === 'hp' && t.kind === 'resource' ? { ...t, current: 1 } : t)),
  };
  const fatal = strike(faces([NATURAL_MAX, D20], [DAMAGE_SIDES, DAMAGE_SIDES]), hero({ might: STRONG }), dying);
  assert.equal(fatal.ok, true);
  if (fatal.ok) assert.equal(numberIn(fatal.sheet, 'hp'), 0);
});

test('initiative orders by total, then agility modifier, then id', () => {
  const swift = hero({ agility: STRONG }, 'swift');
  const slow = hero({ agility: FEEBLE }, 'slow');
  const twinB = hero({}, 'twin-b');
  const twinA = hero({}, 'twin-a');
  const order = rollInitiative({
    actionId: ACTION_ID,
    combatants: [slow, twinB, twinA, swift],
    rng: faces([NATURAL_MAX, D20], [AVERAGE, D20], [AVERAGE, D20], [AVERAGE - (STRONG - AVERAGE), D20]),
  });
  assert.deepEqual(
    order.map((entry) => entry.characterId),
    ['slow', 'swift', 'twin-a', 'twin-b'],
  );
  const tied = rollInitiative({
    actionId: ACTION_ID,
    combatants: [hero({}, 'mid'), swift],
    rng: faces([AVERAGE + (STRONG - AVERAGE), D20], [AVERAGE, D20]),
  });
  assert.deepEqual(
    tied.map((entry) => entry.characterId),
    ['swift', 'mid'],
  );
});

test('turns advance through the order and wrap into the next round', () => {
  const count = 2;
  assert.deepEqual(advanceTurn({ round: 1, index: 0 }, count), { round: 1, index: 1 });
  assert.deepEqual(advanceTurn({ round: 1, index: 1 }, count), { round: 2, index: 0 });
  assert.throws(() => advanceTurn({ round: 1, index: 0 }, 0), RangeError);
});

test('exertion spends stamina and fails without enough', () => {
  const sheet = hero();
  const spent = resolveAction({ actionId: ACTION_ID, rule: D20_LITE_RULES.exert, sheet, rng: faces() });
  assert.equal(spent.ok, true);
  if (!spent.ok) return;
  assert.ok((numberIn(spent.sheet, 'stamina') as number) < (numberIn(sheet, 'stamina') as number));
  const empty = {
    ...sheet,
    traits: sheet.traits.map((t) => (t.id === 'stamina' && t.kind === 'resource' ? { ...t, current: 0 } : t)),
  };
  const refused = resolveAction({ actionId: ACTION_ID, rule: D20_LITE_RULES.exert, sheet: empty, rng: faces() });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'InsufficientResource');
  const rested = resolveAction({ actionId: ACTION_ID, rule: D20_LITE_RULES.recover, sheet: empty, rng: faces() });
  assert.equal(rested.ok, true);
  if (rested.ok) assert.ok((numberIn(rested.sheet, 'stamina') as number) > 0);
});

test('experience below the threshold does not level up', () => {
  const result = gainExperience(hero(), XP_PER_LEVEL - 1);
  assert.equal(result.levelsGained, 0);
  assert.equal(numberIn(result.sheet, 'xp'), XP_PER_LEVEL - 1);
  assert.equal(numberIn(result.sheet, 'level'), 1);
});

test('crossing thresholds raises level, max hit points and proficiency', () => {
  const sheet = hero();
  const levels = 3;
  const result = gainExperience(sheet, (XP_PER_LEVEL * (levels * (levels + 1))) / 2);
  assert.equal(result.levelsGained, levels);
  assert.equal(numberIn(result.sheet, 'level'), 1 + levels);
  assert.ok((maxOf(result.sheet, 'hp') as number) > (maxOf(sheet, 'hp') as number));
  assert.equal(numberIn(result.sheet, 'hp'), maxOf(result.sheet, 'hp'));
  assert.ok((numberIn(result.sheet, 'proficiency') as number) > (numberIn(sheet, 'proficiency') as number));
  assert.throws(() => gainExperience(sheet, -1), RangeError);
});

test('a feeble character still gains hit points on level up', () => {
  const sheet = hero({ might: FEEBLE });
  const result = gainExperience(sheet, XP_PER_LEVEL);
  assert.ok((maxOf(result.sheet, 'hp') as number) > (maxOf(sheet, 'hp') as number));
});

test('d20-lite supplies creation rules that build a pinned character from attribute choices', () => {
  const build = (values: Record<string, number>) =>
    buildCharacter({
      rules: D20_LITE_CREATION,
      backstory: 'A scout.',
      proposal: { name: 'Ash', values, equipment: [DRAUGHT] },
    });
  assert.ok(validateSheetSchema(D20_LITE_CREATION.schema).ok);
  const created = build({ might: 6, agility: 5, wits: 7, presence: 4 });
  assert.equal(created.status, 'created', JSON.stringify(created));
  if (created.status === 'created') {
    const { id, edition, revision } = D20_LITE_MANIFEST;
    assert.deepEqual(created.character.profile.rulepack, { id, edition, revision });
    assert.deepEqual(created.character.equipment, [DRAUGHT]);
  }
  const pending = build({});
  assert.deepEqual(pending.status === 'pending' ? pending.questions.map(({ fieldId }) => fieldId) : [], [
    ...ATTRIBUTES,
  ]);
  assert.equal(build({ might: ATTRIBUTE_MAX + 1, agility: 5, wits: 5, presence: 5 }).status, 'rejected');
});
