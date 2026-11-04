import { creationRulesOf } from './character-builder.ts';
import { createRoller, type Rng, type TrustedRoll } from './dice.ts';
import { type Condition, type NumberExpr, RULE_DSL_VERSION, type RuleDsl, type RuleEffect } from './dsl.ts';
import { rejectPrecondition, type SheetResult } from './inventory.ts';
import { type ActionResolution, resolveAction } from './resolve.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from './rulepack.ts';
import { resolveDerived, type Trait, type TraitSheet } from './traits.ts';

export const ATTRIBUTES = ['might', 'agility', 'wits', 'presence'] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

export const D20_SIDES = 20;
export const NATURAL_MAX = 20;
export const NATURAL_MIN = 1;
export const ATTRIBUTE_AVERAGE = 5;
export const ATTRIBUTE_MIN = 0;
export const ATTRIBUTE_MAX = 10;
export const DEFENSE_BASE = 10;
export const HP_PER_LEVEL = 8;
export const MIN_HP_GAIN = 1;
export const STAMINA_MAX = 6;
export const EXERT_COST = 2;
export const RECOVER_AMOUNT = 3;
export const MIN_DAMAGE = 1;
export const CRITICAL_MULTIPLIER = 2;
export const XP_PER_LEVEL = 100;
export const MAX_LEVEL = 10;
export const PROFICIENCY_BASE = 1;
export const PROFICIENCY_INTERVAL = 3;
export const DRAUGHT = 'draught';
export const DRAUGHT_COST = 1;
export const DRAUGHT_SIDES = 4;

const FIRST_LEVEL = 1;
const D20_ROLL_SUFFIX = ':d20';
const MOD_SUFFIX = '.mod';
const HP = 'hp';
const STAMINA = 'stamina';
const LEVEL = 'level';
const XP = 'xp';
const PROFICIENCY = 'proficiency';
const DEFENSE = 'defense';
const D20_REF = 'd20';
const EDGE = 'edge';
const DC = 'dc';
const ATTACK_BONUS = 'attackBonus';
const DAMAGE_BONUS = 'damageBonus';

export const D20_LITE_MANIFEST: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'd20-lite',
  edition: 'original',
  revision: '1',
  capabilities: { checks: true, combat: true, resources: true, progression: true },
  sourceRefs: [],
};

export const D20_LITE_CREATION = creationRulesOf(
  D20_LITE_MANIFEST,
  ATTRIBUTES.map((id) => ({ id, widget: 'number', custom: false, visibility: 'public' })),
  ATTRIBUTES.map((field) => ({ field, min: ATTRIBUTE_MIN, max: ATTRIBUTE_MAX, onViolation: 'report' })),
  [DRAUGHT],
);

const modId = (attribute: Attribute) => `${attribute}${MOD_SUFFIX}`;
const constant = (value: number): NumberExpr => ({ kind: 'const', value });
const ref = (id: string): NumberExpr => ({ kind: 'ref', id });
const add = (left: NumberExpr, right: NumberExpr): NumberExpr => ({ kind: 'arith', op: 'add', left, right });
const natural = (face: number): Condition => ({ kind: 'compare', op: 'eq', left: ref(D20_REF), right: constant(face) });
const meets = (bonus: NumberExpr, target: NumberExpr): Condition => ({
  kind: 'compare',
  op: 'gte',
  left: add(ref(D20_REF), bonus),
  right: target,
});
const emit = (...events: string[]): RuleEffect[] => events.map((event) => ({ kind: 'emitEvent', event }));
const rule = (id: string, effects: RuleEffect[], when?: Condition): RuleDsl => ({
  dslVersion: RULE_DSL_VERSION,
  id,
  ...(when ? { when } : {}),
  effects,
});

export const checkTable = (attribute: Attribute): RuleDsl[] => {
  const bonus = add(ref(modId(attribute)), ref(EDGE));
  return [
    rule('check.critical', emit('check.critical', 'check.success'), natural(NATURAL_MAX)),
    rule('check.fumble', emit('check.fumble', 'check.failure'), natural(NATURAL_MIN)),
    rule('check.success', emit('check.success'), meets(bonus, ref(DC))),
    rule('check.failure', emit('check.failure')),
  ];
};

const damage = (sides: number, multiplier: number): RuleEffect => {
  const rolled: NumberExpr = { kind: 'dice', count: 1, sides, modifier: 0 };
  const dealt: NumberExpr = {
    kind: 'arith',
    op: 'mul',
    left: { kind: 'arith', op: 'max', left: add(rolled, ref(DAMAGE_BONUS)), right: constant(MIN_DAMAGE) },
    right: constant(multiplier),
  };
  return {
    kind: 'adjustResource',
    resource: HP,
    amount: {
      kind: 'arith',
      op: 'sub',
      left: constant(0),
      right: { kind: 'arith', op: 'min', left: dealt, right: ref(HP) },
    },
  };
};

export const attackTable = (damageSides: number): RuleDsl[] => [
  rule(
    'attack.critical',
    [damage(damageSides, CRITICAL_MULTIPLIER), ...emit('attack.critical', 'attack.hit')],
    natural(NATURAL_MAX),
  ),
  rule('attack.fumble', emit('attack.fumble', 'attack.miss'), natural(NATURAL_MIN)),
  rule('attack.hit', [damage(damageSides, 1), ...emit('attack.hit')], meets(ref(ATTACK_BONUS), ref(DEFENSE))),
  rule('attack.miss', emit('attack.miss')),
];

export const D20_LITE_RULES = {
  exert: {
    dslVersion: RULE_DSL_VERSION,
    id: 'exert',
    costs: [{ kind: 'cost', resource: STAMINA, amount: constant(EXERT_COST) }],
    effects: emit('stamina.spent'),
  },
  drinkDraught: {
    dslVersion: RULE_DSL_VERSION,
    id: 'drinkDraught',
    costs: [{ kind: 'cost', resource: DRAUGHT, amount: constant(DRAUGHT_COST) }],
    effects: [
      { kind: 'adjustResource', resource: HP, amount: { kind: 'dice', count: 1, sides: DRAUGHT_SIDES, modifier: 0 } },
      ...emit('draught.drunk'),
    ],
  },
  recover: rule('recover', [
    { kind: 'adjustResource', resource: STAMINA, amount: constant(RECOVER_AMOUNT) },
    ...emit('stamina.recovered'),
  ]),
} satisfies Record<string, RuleDsl>;

export const attributeModifier = (score: number) => {
  if (!Number.isInteger(score)) throw new RangeError('attribute score must be an integer');
  return score - ATTRIBUTE_AVERAGE;
};

export const proficiencyFor = (level: number) =>
  PROFICIENCY_BASE + Math.floor((level - FIRST_LEVEL) / PROFICIENCY_INTERVAL);

const hpGain = (mightScore: number) => Math.max(HP_PER_LEVEL + attributeModifier(mightScore), MIN_HP_GAIN);

export const xpThreshold = (level: number) => (XP_PER_LEVEL * level * (level + 1)) / 2;

export type SheetInput = { characterId: TraitSheet['characterId']; attributes: Record<Attribute, number> };

export const createSheet = ({ characterId, attributes }: SheetInput): TraitSheet => {
  for (const attribute of ATTRIBUTES) {
    const score = attributes[attribute];
    if (!Number.isInteger(score) || score < ATTRIBUTE_MIN || score > ATTRIBUTE_MAX) {
      throw new RangeError(`${attribute} must be an integer from ${ATTRIBUTE_MIN} to ${ATTRIBUTE_MAX}`);
    }
  }
  const hp = hpGain(attributes.might);
  return {
    characterId,
    traits: [
      ...ATTRIBUTES.flatMap((attribute): Trait[] => [
        { id: attribute, kind: 'trait', value: attributes[attribute] },
        { id: modId(attribute), kind: 'derived', op: 'sum', refs: [attribute], offset: -ATTRIBUTE_AVERAGE },
      ]),
      { id: DEFENSE, kind: 'derived', op: 'sum', refs: [modId('agility')], offset: DEFENSE_BASE },
      { id: HP, kind: 'resource', current: hp, max: hp },
      { id: STAMINA, kind: 'resource', current: STAMINA_MAX, max: STAMINA_MAX },
      { id: LEVEL, kind: 'trait', value: FIRST_LEVEL },
      { id: XP, kind: 'trait', value: 0 },
      { id: PROFICIENCY, kind: 'trait', value: proficiencyFor(FIRST_LEVEL) },
    ],
  };
};

const numberOf = (sheet: TraitSheet, id: string): number => {
  const trait = sheet.traits.find((item) => item.id === id);
  if (trait?.kind === 'resource') return trait.current;
  if (trait?.kind === 'trait' && typeof trait.value === 'number') return trait.value;
  const derived = resolveDerived(sheet)[id];
  if (derived === undefined) throw new RangeError(`${id} must reference a numeric trait`);
  return derived;
};

const rollD20 = (rng: Rng, rollId: string) =>
  createRoller(rng)(rollId, { dice: [{ count: 1, sides: D20_SIDES }], modifier: 0 });

type TableInput = {
  actionId: string;
  table: RuleDsl[];
  sheet: TraitSheet;
  rng: Rng;
  modifiers: Record<string, number>;
};

export const resolveTable = ({ actionId, table, sheet, rng, modifiers }: TableInput): ActionResolution => {
  const d20 = rollD20(rng, `${actionId}${D20_ROLL_SUFFIX}`);
  if (!d20.ok) return { ok: false, error: { code: 'RollFailed', issues: d20.issues }, rolls: [] };
  let last: ActionResolution = { ok: false, error: { code: 'InvalidAction', issues: [] }, rolls: [] };
  for (const entry of table) {
    last = resolveAction({ actionId, rule: entry, sheet, rng, modifiers: { ...modifiers, [D20_REF]: d20.roll.total } });
    if (last.ok || last.error.code !== 'PreconditionFailed') break;
  }
  return { ...last, rolls: [d20.roll, ...last.rolls] };
};

export type CheckInput = {
  actionId: string;
  sheet: TraitSheet;
  attribute: Attribute;
  dc: number;
  rng: Rng;
  edge?: number;
};

export const attemptCheck = ({ actionId, sheet, attribute, dc, rng, edge = 0 }: CheckInput) =>
  resolveTable({ actionId, table: checkTable(attribute), sheet, rng, modifiers: { [DC]: dc, [EDGE]: edge } });

export type AttackInput = {
  actionId: string;
  attacker: TraitSheet;
  target: TraitSheet;
  attribute: Attribute;
  damageSides: number;
  rng: Rng;
  edge?: number;
};

export const attack = ({ actionId, attacker, target, attribute, damageSides, rng, edge = 0 }: AttackInput) => {
  const modifier = numberOf(attacker, modId(attribute));
  return resolveTable({
    actionId,
    table: attackTable(damageSides),
    sheet: target,
    rng,
    modifiers: { [ATTACK_BONUS]: modifier + numberOf(attacker, PROFICIENCY) + edge, [DAMAGE_BONUS]: modifier },
  });
};

export type InitiativeEntry = { characterId: TraitSheet['characterId']; total: number; roll: TrustedRoll };

export const rollInitiative = ({
  actionId,
  combatants,
  rng,
}: {
  actionId: string;
  combatants: TraitSheet[];
  rng: Rng;
}): InitiativeEntry[] => {
  const entries = combatants.map((sheet) => {
    const agility = numberOf(sheet, modId('agility'));
    const rolled = rollD20(rng, `${actionId}:initiative:${sheet.characterId}`);
    if (!rolled.ok) throw new RangeError(rolled.issues.map((issue) => issue.message).join('; '));
    return { characterId: sheet.characterId, total: rolled.roll.total + agility, agility, roll: rolled.roll };
  });
  entries.sort(
    (left, right) =>
      right.total - left.total ||
      right.agility - left.agility ||
      (left.characterId < right.characterId ? -1 : left.characterId > right.characterId ? 1 : 0),
  );
  return entries.map(({ characterId, total, roll }) => ({ characterId, total, roll }));
};

export type TurnPosition = { round: number; index: number };

export const advanceTurn = ({ round, index }: TurnPosition, combatantCount: number): TurnPosition => {
  if (!Number.isInteger(combatantCount) || combatantCount < 1) {
    throw new RangeError('combatant count must be a positive integer');
  }
  const next = index + 1;
  return next < combatantCount ? { round, index: next } : { round: round + 1, index: 0 };
};

const replaceTrait = (sheet: TraitSheet, next: Trait): TraitSheet => ({
  ...sheet,
  traits: sheet.traits.map((trait) => (trait.id === next.id ? next : trait)),
});

export const gainExperience = (sheet: TraitSheet, amount: number) => {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('experience must be a non-negative integer');
  const xp = numberOf(sheet, XP) + amount;
  const startLevel = numberOf(sheet, LEVEL);
  let level = startLevel;
  while (level < MAX_LEVEL && xp >= xpThreshold(level)) level += 1;
  const levelsGained = level - startLevel;
  const hp = sheet.traits.find((trait) => trait.id === HP);
  if (hp?.kind !== 'resource') throw new RangeError(`${HP} must be a resource`);
  const gain = levelsGained * hpGain(numberOf(sheet, 'might'));
  let next = replaceTrait(sheet, { id: XP, kind: 'trait', value: xp });
  next = replaceTrait(next, { id: LEVEL, kind: 'trait', value: level });
  next = replaceTrait(next, { id: PROFICIENCY, kind: 'trait', value: proficiencyFor(level) });
  next = replaceTrait(next, { ...hp, current: hp.current + gain, max: hp.max + gain });
  return { sheet: next, levelsGained };
};

export const levelUp = (sheet: TraitSheet): SheetResult => {
  const level = numberOf(sheet, LEVEL);
  if (level >= MAX_LEVEL) return rejectPrecondition(LEVEL, `must be below ${MAX_LEVEL}`);
  const needed = xpThreshold(level);
  if (numberOf(sheet, XP) < needed) return rejectPrecondition(XP, `must be at least ${needed}`);
  return { ok: true, sheet: gainExperience(sheet, 0).sheet };
};
