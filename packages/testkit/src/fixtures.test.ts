import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixedClock, createScriptedRng, createSequentialIds } from './fixtures.ts';

const SCRIPT = [0.1, 0.5, 0.9];
const START = '2026-01-01T00:00:00.000Z';
const STEP_MS = 1000;
const PREFIX = 'event';

const draw = (rng: () => number, count: number) => Array.from({ length: count }, () => rng());

test('scripted rng cycles its values and rejects values outside the unit interval', () => {
  assert.deepEqual(draw(createScriptedRng(SCRIPT), SCRIPT.length * 2), [...SCRIPT, ...SCRIPT]);
  assert.throws(() => createScriptedRng([]), RangeError);
  assert.throws(() => createScriptedRng([1]), RangeError);
});

test('fixed clock and sequential ids are deterministic', () => {
  const clock = createFixedClock(START, STEP_MS);
  assert.deepEqual([clock(), clock()], [START, '2026-01-01T00:00:01.000Z']);
  assert.throws(() => createFixedClock('not a date'), RangeError);
  const nextId = createSequentialIds(PREFIX);
  assert.deepEqual([nextId(), nextId()], ['event-1', 'event-2']);
});
