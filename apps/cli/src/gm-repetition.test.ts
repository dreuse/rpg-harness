import assert from 'node:assert/strict';
import { it } from 'node:test';
import { closingSentencesOf, repeatedLinesOf } from './gm-repetition.ts';

const FIRST =
  'Chairs scrape as Tam watches calmly. The strike is yours to land or to waste. Attempt the attack with your sword.';
const SECOND = 'Steel rings. Strike true. Attempt an attack with your sword.';

it('rpg-42a.76 closings are the last sentence of each narration', () => {
  assert.deepEqual(closingSentencesOf([FIRST, SECOND]), [
    'Attempt the attack with your sword.',
    'Attempt an attack with your sword.',
  ]);
});

it('rpg-42a.76 an identical closing sentence is repeated', () => {
  const fresh = 'The door groans open. Attempt the attack with your sword.';
  assert.deepEqual(repeatedLinesOf(fresh, [FIRST]), ['Attempt the attack with your sword.']);
});

it('rpg-42a.76 a sentence with more than 60 percent token overlap is repeated', () => {
  const fresh = 'Rain falls. The strike is yours to land, or to waste now.';
  assert.deepEqual(repeatedLinesOf(fresh, [FIRST]), ['The strike is yours to land, or to waste now.']);
});

it('rpg-42a.76 new text and empty history are not repeated', () => {
  assert.deepEqual(repeatedLinesOf('A raven lands on the sill. Will you read its note?', [FIRST, SECOND]), []);
  assert.deepEqual(repeatedLinesOf(FIRST, []), []);
});

it('rpg-42a.76 a short sentence contained in a longer earlier one is not repeated', () => {
  const old = 'Tam looks up from the dice and grins at you across the table.';
  assert.deepEqual(repeatedLinesOf('Tam grins at you today.', [old]), []);
  assert.deepEqual(repeatedLinesOf('Tam looks up from the dice and grins at you across the bar.', [old]).length, 1);
});

it('rpg-42a.76 splits a quoted closing line from the sentence before it', () => {
  assert.deepEqual(closingSentencesOf(['He waits. "Go now." Then silence. "Strike true, friend."']), [
    '"Strike true, friend."',
  ]);
});
