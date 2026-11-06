import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D20_LITE_VOCABULARY } from './d20-lite.ts';
import { DICE_POOL_LITE_VOCABULARY } from './dice-pool-lite.ts';
import {
  MAX_MODIFIER_VALUE,
  MAX_MODIFIERS,
  type ModifierVocabulary,
  resolveModifiers,
  summarizeModifiers,
} from './modifiers.ts';

const COVER = { id: 'cover', reason: 'the player crouches behind a barrel', sourceRule: 'cover' };
const LABELLED = { id: 'moonlit', reason: 'moonlight helps', sourceRule: 'PHB p.12', value: 1 };
const EMPTY: ModifierVocabulary = { modifiers: [], conditions: [], difficulties: {}, effects: ['flat'] };

test('as-written accepts a modifier declared by the rulepack and records its effect', () => {
  const result = resolveModifiers(D20_LITE_VOCABULARY, [COVER], 'as-written');
  assert.ok(result.ok);
  assert.deepEqual(result.applied, [
    { id: 'cover', reason: COVER.reason, sourceRule: 'cover', effect: { kind: 'flat', value: 2 } },
  ]);
});

test('as-written rejects an unknown modifier id', () => {
  const result = resolveModifiers(D20_LITE_VOCABULARY, [LABELLED], 'as-written');
  assert.ok(!result.ok);
  assert.match(result.issues[0]?.message ?? '', /moonlit/);
});

test('relaxed accepts an unknown modifier that has a reason and a bounded flat value', () => {
  const result = resolveModifiers(D20_LITE_VOCABULARY, [LABELLED], 'relaxed');
  assert.ok(result.ok);
  assert.deepEqual(result.applied[0]?.effect, { kind: 'flat', value: 1 });
});

test('relaxed rejects a labelled modifier without a reason, with no value or out of bounds', () => {
  for (const bad of [
    { ...LABELLED, reason: ' ' },
    { id: 'moonlit', reason: 'x' },
    { ...LABELLED, value: MAX_MODIFIER_VALUE + 1 },
    { ...LABELLED, value: 1.5 },
  ])
    assert.ok(!resolveModifiers(EMPTY, [bad], 'relaxed').ok);
});

test('rejects a blank reason and too many modifiers in both modes', () => {
  assert.ok(!resolveModifiers(D20_LITE_VOCABULARY, [{ ...COVER, reason: '' }], 'as-written').ok);
  const many = Array.from({ length: MAX_MODIFIERS + 1 }, () => COVER);
  assert.ok(!resolveModifiers(D20_LITE_VOCABULARY, many, 'relaxed').ok);
});

test('summarize adds flat values and lets advantage and disadvantage cancel', () => {
  const applied = (ids: string[]) => {
    const result = resolveModifiers(
      D20_LITE_VOCABULARY,
      ids.map((id) => ({ id, reason: 'because' })),
      'as-written',
    );
    assert.ok(result.ok);
    return summarizeModifiers(result.applied);
  };
  assert.deepEqual(applied(['cover', 'darkness']), { flat: 0, dice: 0 });
  assert.deepEqual(applied(['advantage']), { flat: 0, dice: 0, keep: 'highest' });
  assert.deepEqual(applied(['disadvantage']), { flat: 0, dice: 0, keep: 'lowest' });
  assert.deepEqual(applied(['advantage', 'disadvantage']), { flat: 0, dice: 0 });
});

test('the dice pool vocabulary adds and removes dice', () => {
  const dice = (...ids: string[]) => {
    const result = resolveModifiers(
      DICE_POOL_LITE_VOCABULARY,
      ids.map((id) => ({ id, reason: 'because' })),
      'as-written',
    );
    assert.ok(result.ok);
    return summarizeModifiers(result.applied).dice;
  };
  assert.equal(dice('help'), 1);
  assert.equal(dice('wounded', 'hindered'), -2);
  assert.equal(dice('help', 'hindered'), 0);
});

test('refuses an effect kind the rulepack checks cannot apply', () => {
  const flatOnPool = resolveModifiers(DICE_POOL_LITE_VOCABULARY, [LABELLED], 'relaxed');
  assert.ok(!flatOnPool.ok);
  assert.match(flatOnPool.issues[0]?.message ?? '', /cannot apply/);
  const diceOnD20: ModifierVocabulary = {
    ...D20_LITE_VOCABULARY,
    modifiers: [{ id: 'help', label: 'Help', effect: { kind: 'dice', count: 1 } }],
  };
  assert.ok(!resolveModifiers(diceOnD20, [{ id: 'help', reason: 'an ally' }], 'as-written').ok);
  assert.ok(resolveModifiers(DICE_POOL_LITE_VOCABULARY, [{ id: 'help', reason: 'an ally' }], 'as-written').ok);
  assert.ok(resolveModifiers(DICE_POOL_LITE_VOCABULARY, [LABELLED], 'relaxed', ['flat']).ok);
});

test('a step effect is summed, declared by d20-lite and refused where checks cannot apply it', () => {
  const resolved = resolveModifiers(
    D20_LITE_VOCABULARY,
    ['empowered', 'empowered', 'weakened'].map((id) => ({ id, reason: 'because' })),
    'as-written',
  );
  assert.ok(resolved.ok);
  assert.deepEqual(summarizeModifiers(resolved.applied), { flat: 0, dice: 0, step: 1 });
  assert.ok(D20_LITE_VOCABULARY.effects.includes('step'));
  const refused = resolveModifiers(D20_LITE_VOCABULARY, [{ id: 'empowered', reason: 'because' }], 'as-written', [
    'flat',
  ]);
  assert.ok(!refused.ok);
  assert.match(refused.issues[0]?.message ?? '', /step effect these checks cannot apply/);
  const oversized: ModifierVocabulary = {
    ...EMPTY,
    modifiers: [{ id: 'huge', label: 'Huge', effect: { kind: 'step', steps: MAX_MODIFIER_VALUE + 1 } }],
  };
  assert.ok(!resolveModifiers(oversized, [{ id: 'huge', reason: 'because' }], 'as-written', ['step']).ok);
});

test('a citation check refuses a modifier whose source rule is not known and keeps the citation optional', () => {
  const cites = (rule: string) => rule === 'Melee Attacks';
  const request = { id: 'high-ground', reason: 'higher ground', value: 1 };
  const run = (sourceRule?: string) =>
    resolveModifiers(
      EMPTY,
      [{ ...request, ...(sourceRule === undefined ? {} : { sourceRule }) }],
      'relaxed',
      ['flat'],
      cites,
    );
  assert.ok(run('Melee Attacks').ok);
  assert.ok(run().ok);
  const refused = run('Dragon Breath');
  assert.ok(!refused.ok);
  assert.match(refused.issues[0]?.message ?? '', /Dragon Breath/);
});
