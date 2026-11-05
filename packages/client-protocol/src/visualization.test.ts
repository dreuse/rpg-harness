import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from './protocol.ts';
import {
  dieShapeOf,
  GENERIC_DIE,
  type MechanicResult,
  toVisualizationEvent,
  tumbleFaces,
  VISUALIZATION_EVENT,
} from './visualization.ts';

const D20: MechanicResult = {
  resultId: 'roll-1',
  mechanic: 'd20-check',
  visibility: 'public',
  reveals: [{ kind: 'die', sides: 20, face: 17 }],
  modifier: 3,
  total: 20,
  outcome: 'success',
};

const POOL: MechanicResult = {
  resultId: 'roll-2',
  mechanic: 'dice-pool',
  visibility: 'player',
  reveals: [6, 5, 1, 3].map((face) => ({ kind: 'die', sides: 6, face })),
  modifier: 0,
  total: 2,
  outcome: 'mixed',
};

const CARDS: MechanicResult = {
  resultId: 'draw-1',
  mechanic: 'card-draw',
  visibility: 'public',
  reveals: [
    { kind: 'token', label: 'Queen of Hearts' },
    { kind: 'token', label: 'Two of Clubs' },
  ],
  outcome: 'partial',
};

const SECRET_FACE = 13;
const HIDDEN: MechanicResult = {
  ...D20,
  resultId: 'roll-3',
  visibility: 'gm',
  reveals: [{ kind: 'die', sides: 20, face: SECRET_FACE }],
};
const ENABLED = { enabled: true };

const finalOf = (result: MechanicResult) => ({
  total: result.total,
  outcome: result.outcome,
  ...(result.modifier === undefined ? {} : { modifier: result.modifier }),
});

test('UI05 animates trusted engine results for d20, pools and supported non-dice mechanics', () => {
  for (const result of [D20, POOL, CARDS]) {
    const event = toVisualizationEvent(result, 'player', ENABLED);
    assert.ok(event);
    assert.equal(event.version, PROTOCOL_VERSION);
    assert.equal(event?.type, VISUALIZATION_EVENT);
    assert.equal(event?.resultId, result.resultId);
    assert.equal(event?.mechanic, result.mechanic);
    assert.deepEqual(
      event.frames.map((frame) => frame.reveal),
      result.reveals,
    );
    assert.deepEqual(
      event.frames.map((frame) => frame.step),
      result.reveals.map((_, index) => index),
    );
    assert.deepEqual(event.final, finalOf(result));
  }
});

test('UI05 d20 final carries the engine modifier unchanged', () => {
  assert.deepEqual(toVisualizationEvent(D20, 'player', ENABLED)?.final, {
    total: D20.total,
    outcome: D20.outcome,
    modifier: D20.modifier,
  });
  assert.equal(Object.hasOwn(toVisualizationEvent(CARDS, 'player', ENABLED)?.final ?? {}, 'modifier'), false);
});

test('UI05 frames carry only known reveal fields', () => {
  const SEED = 'seed';
  const reveals = [
    { kind: 'die', sides: 20, face: 4, [SEED]: 42 },
    { kind: 'token', label: 'Ace of Spades', [SEED]: 7 },
  ] as const;
  const leaky: MechanicResult = { ...CARDS, reveals };
  const event = toVisualizationEvent(leaky, 'player', ENABLED);
  assert.deepEqual(
    event?.frames.map((frame) => frame.reveal),
    [
      { kind: 'die', sides: 20, face: 4 },
      { kind: 'token', label: 'Ace of Spades' },
    ],
  );
  assert.doesNotMatch(JSON.stringify(event), new RegExp(SEED));
});

test('UI05 edge: animation never changes result', () => {
  const source = structuredClone(POOL);
  const event = toVisualizationEvent(source, 'player', ENABLED);
  assert.deepEqual(source, POOL);
  assert.ok(event);
  assert.equal(event?.final.total, POOL.total);
  assert.equal(event?.final.outcome, POOL.outcome);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.frames) && Object.isFrozen(event.final));
  assert.throws(() => {
    (event.final as { total?: number }).total = 99;
  });
  const lying: MechanicResult = { ...D20, total: 1, outcome: 'failure' };
  assert.deepEqual(toVisualizationEvent(lying, 'player', ENABLED)?.final, finalOf(lying));
});

test('UI05 edge: hidden rolls respect visibility policy', () => {
  for (const visibility of ['gm', 'actor-scoped'] as const) {
    const playerView = toVisualizationEvent({ ...HIDDEN, visibility }, 'player', ENABLED);
    assert.equal(playerView, undefined);
    assert.doesNotMatch(
      String(JSON.stringify(playerView)),
      new RegExp(`${SECRET_FACE}|${HIDDEN.outcome}|${HIDDEN.resultId}|${HIDDEN.mechanic}`),
    );
  }
  const gmView = toVisualizationEvent(HIDDEN, 'gm', ENABLED);
  assert.deepEqual(gmView?.final, finalOf(HIDDEN));
  assert.deepEqual(
    gmView?.frames.map((frame) => frame.reveal),
    HIDDEN.reveals,
  );
});

test('UI05 opt-out produces no visualization events', () => {
  assert.equal(toVisualizationEvent(D20, 'player', { enabled: false }), undefined);
});

const TUMBLE_STEPS = 6;
const PROPERTY_ROLLS = 2000;
const SIDE_CHOICES = [2, 3, 4, 6, 7, 8, 10, 12, 20, 100];

test('UI15: every tumble lands on the engine face for many rolls', () => {
  for (let roll = 0; roll < PROPERTY_ROLLS; roll += 1) {
    const sides = SIDE_CHOICES[roll % SIDE_CHOICES.length] ?? 6;
    const face = (roll % sides) + 1;
    const faces = tumbleFaces({ kind: 'die', sides, face }, TUMBLE_STEPS);
    assert.equal(faces.at(-1), face);
    assert.equal(faces.length, TUMBLE_STEPS);
    assert.ok(faces.every((shown) => Number.isInteger(shown) && shown >= 1 && shown <= sides));
  }
  assert.deepEqual(tumbleFaces({ kind: 'die', sides: 0, face: 3 }, TUMBLE_STEPS), [3]);
  assert.deepEqual(tumbleFaces({ kind: 'die', sides: 20, face: 17 }, 0), [17]);
});

test('UI15: known die shapes come from declared sides and unknown sides fall back to a generic die', () => {
  assert.equal(dieShapeOf(20), 'd20');
  assert.equal(dieShapeOf(6), 'd6');
  assert.equal(dieShapeOf(7), GENERIC_DIE);
  assert.equal(dieShapeOf(1.5), GENERIC_DIE);
});
