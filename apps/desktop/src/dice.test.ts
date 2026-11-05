import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import {
  GENERIC_DIE,
  type MechanicReveal,
  VISUALIZATION_EVENT,
  type VisualizationEvent,
} from '../../../packages/client-protocol/src/visualization.ts';
import { effectiveMotion, parseVisualization, ROLL_MS, renderRoll, rollPlan, SETTLE_MS } from './dice.ts';

const LOCALE = 'en';
const PROPERTY_ROLLS = 500;
const MAX_DICE = 4;
const SIDE_CHOICES = [4, 6, 7, 8, 10, 12, 20, 100];

const rollOf = (reveals: readonly MechanicReveal[], final = {}): VisualizationEvent => ({
  version: PROTOCOL_VERSION,
  type: VISUALIZATION_EVENT,
  resultId: 'r1',
  mechanic: 'dice',
  frames: reveals.map((reveal, step) => ({ step, reveal })),
  final: { total: undefined, outcome: undefined, ...final },
});

const die = (sides: number, face: number): MechanicReveal => ({ kind: 'die', sides, face });
const resting = (html: string) => [...html.matchAll(/<span data-strip><span>(\d+)<\/span>/g)].map(([, f]) => f);

test('UI15: the animated die always lands on the engine face over many rolls', () => {
  for (let roll = 0; roll < PROPERTY_ROLLS; roll += 1) {
    const count = (roll % MAX_DICE) + 1;
    const reveals = Array.from({ length: count }, (_, index) => {
      const sides = SIDE_CHOICES[(roll + index) % SIDE_CHOICES.length] ?? 6;
      return die(sides, ((roll * (index + 1)) % sides) + 1);
    });
    const plan = rollPlan(rollOf(reveals), 'full');
    const landed = plan.groups.flatMap(({ dice }) => dice.map((faces) => faces.at(-1)));
    const engine = plan.groups.flatMap(({ sides }) =>
      reveals.flatMap((reveal) => (reveal.kind === 'die' && reveal.sides === sides ? [reveal.face] : [])),
    );
    assert.deepEqual(landed, engine);
    assert.deepEqual(resting(renderRoll(plan, LOCALE)), engine.map(String));
  }
});

test('UI15: reduced motion and motion off render the result immediately', () => {
  for (const motion of ['reduced', 'off'] as const) {
    const plan = rollPlan(rollOf([die(20, 17), die(6, 2)]), motion);
    assert.equal(plan.animated, false);
    assert.equal(plan.durationMs, 0);
    assert.deepEqual(
      plan.groups.map(({ dice }) => dice),
      [[[17]], [[2]]],
    );
    const html = renderRoll(plan, LOCALE);
    assert.doesNotMatch(html, /data-animated="true"/);
    assert.doesNotMatch(html, /data-roll-skip/);
  }
  assert.equal(effectiveMotion('full', true), 'reduced');
  assert.equal(effectiveMotion('off', true), 'off');
  assert.equal(effectiveMotion('full', false), 'full');
  const full = renderRoll(rollPlan(rollOf([die(20, 17)]), 'full'), LOCALE);
  assert.match(full, /data-animated="true"/);
  assert.match(full, /data-roll-skip/);
});

test('UI15: an unknown die type from a RulePack falls back to a generic numeric die', () => {
  const plan = rollPlan(rollOf([die(7, 5)]), 'full');
  assert.equal(plan.groups[0]?.shape, GENERIC_DIE);
  const html = renderRoll(plan, LOCALE);
  assert.match(html, new RegExp(`data-die="${GENERIC_DIE}"`));
  assert.match(html, /<circle/);
  assert.match(html, /aria-label="d7: 5"/);
});

test('UI15: multi-die rolls are grouped by die type with a breakdown of modifier, total and outcome', () => {
  const plan = rollPlan(
    rollOf([die(6, 3), die(20, 17), die(6, 5), { kind: 'token', label: '<Ace>' }], {
      modifier: -1,
      total: 24,
      outcome: 'success',
    }),
    'off',
  );
  assert.deepEqual(
    plan.groups.map(({ shape, dice }) => [shape, dice.flat()]),
    [
      ['d6', [3, 5]],
      ['d20', [17]],
    ],
  );
  const html = renderRoll(plan, LOCALE);
  assert.match(html, /modifier -1/);
  assert.match(html, /total 24/);
  assert.match(html, /success/);
  assert.match(html, /&lt;Ace&gt;/);
});

test('rpg-42a.17 a rules outcome id reads as a plain word in the roll caption', () => {
  const html = renderRoll(rollPlan(rollOf([die(20, 13)], { total: 14, outcome: 'check.success' }), 'off'), LOCALE);
  assert.match(html, /<figcaption>d20 13, total 14, success<\/figcaption>/);
});

test('UI15: malformed visualization messages are ignored', () => {
  assert.equal(parseVisualization({ type: VISUALIZATION_EVENT }), undefined);
  assert.equal(
    parseVisualization({ ...rollOf([]), frames: [{ step: 0, reveal: { kind: 'die', sides: 'x' } }] }),
    undefined,
  );
  assert.deepEqual(parseVisualization(rollOf([die(6, 4)])), rollOf([die(6, 4)]));
});

test('UI15: the CSS roll and settle durations match the timers that settle them', () => {
  const tokens = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
  assert.match(tokens, new RegExp(`--duration-roll: ${ROLL_MS}ms;`));
  assert.match(tokens, new RegExp(`--duration-settle: ${SETTLE_MS}ms;`));
});
