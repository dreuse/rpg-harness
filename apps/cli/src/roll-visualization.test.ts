import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VISUALIZATION_EVENT } from '../../../packages/client-protocol/src/visualization.ts';
import { attemptCheck, createSheet } from '../../../packages/rules/src/d20-lite.ts';
import { createSeededRng } from '../../../packages/rules/src/dice.ts';
import { DEFAULT_POOL_CONFIG, rollPool } from '../../../packages/rules/src/dice-pool-lite.ts';
import { DICE_MECHANIC, emitVisualizations, POOL_MECHANIC, poolResult, rollResult } from './roll-visualization.ts';

const SEED = 7;
const DC = 12;
const POOL_DICE = 4;
const ENABLED = { enabled: true };
const ATTRIBUTES = { might: 5, agility: 5, wits: 5, presence: 5 };

const d20Roll = () => {
  const sheet = createSheet({ characterId: 'hero' as never, attributes: ATTRIBUTES });
  const [roll] = attemptCheck({
    actionId: 'check-1',
    sheet,
    attribute: 'might',
    dc: DC,
    rng: createSeededRng(SEED),
  }).rolls;
  assert.ok(roll);
  return roll;
};

const pool = () => {
  const rolled = rollPool({
    actionId: 'pool-1',
    dice: POOL_DICE,
    config: DEFAULT_POOL_CONFIG,
    rng: createSeededRng(SEED),
  });
  assert.ok(rolled.ok);
  return rolled.roll;
};

test('maps a d20 roll to a visible mechanic result', () => {
  const roll = d20Roll();
  const [event] = emitVisualizations([rollResult(roll, 'public', 'success')], 'player', ENABLED);
  assert.deepEqual(event && { ...event, version: undefined }, {
    version: undefined,
    type: VISUALIZATION_EVENT,
    resultId: roll.rollId,
    mechanic: DICE_MECHANIC,
    frames: [{ step: 0, reveal: { kind: 'die', sides: 20, face: roll.draws[0]?.[0] } }],
    final: { total: roll.total, outcome: 'success', modifier: 0 },
  });
});

test('maps a pool roll to one die frame per face with successes as total', () => {
  const roll = pool();
  const [event] = emitVisualizations([poolResult('pool-1', roll, 'player')], 'player', ENABLED);
  assert.equal(event?.mechanic, POOL_MECHANIC);
  assert.equal(event?.resultId, 'pool-1');
  assert.deepEqual(
    event?.frames.map(({ reveal }) => reveal),
    roll.faces.map((face) => ({ kind: 'die', sides: DEFAULT_POOL_CONFIG.sides, face })),
  );
  assert.deepEqual(event?.final, { total: roll.successes, outcome: roll.outcome });
});

test('hides a gm roll from the player and shows it to the gm', () => {
  const results = [rollResult(d20Roll(), 'gm', 'success'), poolResult('pool-1', pool(), 'gm')];
  assert.deepEqual(emitVisualizations(results, 'player', ENABLED), []);
  assert.equal(emitVisualizations(results, 'gm', ENABLED).length, results.length);
});

test('emits nothing when the visualization preference is disabled', () => {
  assert.deepEqual(emitVisualizations([rollResult(d20Roll(), 'public')], 'gm', { enabled: false }), []);
});
