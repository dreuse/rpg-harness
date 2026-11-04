import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCharacter } from './character-builder.ts';
import { createSeededRng, MAX_DICE_PER_TERM, type Rng, verifyRollClaim } from './dice.ts';
import {
  DEFAULT_POOL_CONFIG,
  DICE_POOL_LITE_CREATION,
  DICE_POOL_LITE_MANIFEST,
  opposedCheck,
  type PoolConfig,
  type PoolRoll,
  rollPool,
  validatePoolConfig,
} from './dice-pool-lite.ts';
import { capabilityState, validateManifest } from './rulepack.ts';

const HALF = 0.5;
const ACTION_ID = 'act-1';
const SEED = 11;
const D10: PoolConfig = { sides: 10, successThreshold: 8, complicationFace: 2 };

const faces = (sides: number, ...rolled: number[]): Rng => {
  const queue = rolled.map((face) => (face - 1 + HALF) / sides);
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('rng exhausted');
    return next;
  };
};

const roll = (dice: number, rng: Rng, config: PoolConfig = DEFAULT_POOL_CONFIG): PoolRoll => {
  const result = rollPool({ actionId: ACTION_ID, dice, config, rng });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.roll;
};

test('manifest is valid, original and declares deterministic checks', () => {
  assert.equal(validateManifest(DICE_POOL_LITE_MANIFEST).ok, true);
  assert.equal(DICE_POOL_LITE_MANIFEST.id, 'dice-pool-lite');
  assert.equal(DICE_POOL_LITE_MANIFEST.edition, 'original');
  assert.equal(capabilityState(DICE_POOL_LITE_MANIFEST, 'checks'), 'deterministic');
  assert.equal(capabilityState(DICE_POOL_LITE_MANIFEST, 'dice'), 'deterministic');
});

test('support pool rolls, success counting, complications and configurable thresholds', () => {
  const sides = DEFAULT_POOL_CONFIG.sides;
  const pool = roll(4, faces(sides, 6, 5, 3, 1));
  assert.deepEqual(pool.faces, [6, 5, 3, 1]);
  assert.equal(pool.successes, 2);
  assert.equal(pool.complications, 1);
  assert.equal(pool.outcome, 'mixed');
  assert.equal(pool.rolls.length, 1);
  const [trusted] = pool.rolls;
  assert.ok(trusted);
  assert.equal(verifyRollClaim({ rollId: trusted.rollId, total: trusted.total }, pool.rolls).ok, true);

  const custom = roll(3, faces(D10.sides, 8, 7, 2), D10);
  assert.equal(custom.successes, 1);
  assert.equal(custom.complications, 1);
});

test('success threshold counts faces at or above it and complications count faces at or below the complication face', () => {
  const sides = DEFAULT_POOL_CONFIG.sides;
  assert.equal(roll(2, faces(sides, 5, 4)).outcome, 'success');
  assert.equal(roll(2, faces(sides, 4, 2)).outcome, 'failure');
  assert.equal(roll(2, faces(sides, 1, 4)).outcome, 'complication');
  const noComplications = { ...DEFAULT_POOL_CONFIG, complicationFace: 0 };
  assert.equal(roll(1, faces(sides, 1), noComplications).outcome, 'failure');
});

test('zero dice, mixed successes and opposed checks resolve consistently', () => {
  const empty = roll(0, () => {
    throw new Error('zero dice must not draw');
  });
  assert.deepEqual(empty, { faces: [], successes: 0, complications: 0, outcome: 'failure', rolls: [] });

  const sides = DEFAULT_POOL_CONFIG.sides;
  const mixed = roll(3, faces(sides, 6, 1, 1));
  assert.equal(mixed.outcome, 'mixed');

  const strong = roll(3, faces(sides, 6, 5, 2));
  const weak = roll(3, faces(sides, 5, 3, 1));
  assert.deepEqual(opposedCheck(strong, weak), { winner: 'first', margin: 1 });
  assert.deepEqual(opposedCheck(weak, strong), { winner: 'second', margin: 1 });
  assert.deepEqual(opposedCheck(weak, mixed), { winner: 'tie', margin: 0 });
  assert.deepEqual(opposedCheck(empty, empty), { winner: 'tie', margin: 0 });
});

test('seeded pools replay identically', () => {
  const first = roll(MAX_DICE_PER_TERM, createSeededRng(SEED));
  const second = roll(MAX_DICE_PER_TERM, createSeededRng(SEED));
  assert.deepEqual(first.faces, second.faces);
  assert.equal(first.successes, second.successes);
});

test('rejects invalid pool sizes and configs', () => {
  const rng = createSeededRng(SEED);
  for (const dice of [-1, MAX_DICE_PER_TERM + 1, HALF, Number.NaN]) {
    const result = rollPool({ actionId: ACTION_ID, dice, config: DEFAULT_POOL_CONFIG, rng });
    assert.equal(result.ok, false);
  }
  assert.equal(rollPool({ actionId: '', dice: 0, config: DEFAULT_POOL_CONFIG, rng }).ok, false);
  const invalid: unknown[] = [
    null,
    { ...DEFAULT_POOL_CONFIG, sides: 1 },
    { ...DEFAULT_POOL_CONFIG, successThreshold: 0 },
    { ...DEFAULT_POOL_CONFIG, successThreshold: DEFAULT_POOL_CONFIG.sides + 1 },
    { ...DEFAULT_POOL_CONFIG, complicationFace: -1 },
    { ...DEFAULT_POOL_CONFIG, complicationFace: DEFAULT_POOL_CONFIG.successThreshold },
  ];
  for (const config of invalid) assert.equal(validatePoolConfig(config).ok, false);
  assert.equal(rollPool({ actionId: ACTION_ID, dice: 1, config: invalid[1] as PoolConfig, rng }).ok, false);
  assert.deepEqual(validatePoolConfig(D10), { ok: true, config: D10 });
});

test('dice-pool-lite supplies creation rules for a named character with a backstory', () => {
  const result = buildCharacter({
    rules: DICE_POOL_LITE_CREATION,
    backstory: 'A drifter.',
    proposal: { name: 'Ash', values: {}, equipment: [] },
  });
  assert.equal(result.status, 'created', JSON.stringify(result));
  const { id, edition, revision } = DICE_POOL_LITE_MANIFEST;
  assert.deepEqual(result.status === 'created' ? result.character.profile.rulepack : undefined, {
    id,
    edition,
    revision,
  });
});
