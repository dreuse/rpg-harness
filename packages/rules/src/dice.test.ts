import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRoller,
  createSeededRng,
  MAX_TERMS,
  type Rng,
  replayRoll,
  type TrustedRoll,
  validateDicePool,
  verifyRollClaim,
} from './dice.ts';

const SEED = 42;
const OTHER_SEED = 7;
const SAMPLE_SIZE = 1000;
const ROLL_ID = 'roll-1';
const FORGED_ID = 'nat-20';
const INVALID_RNG_OUTPUTS = [1, -0.5, Number.NaN, Number.POSITIVE_INFINITY];
const INVALID_SEEDS = [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2];

const scripted = (values: number[]) => {
  const state = { calls: 0 };
  const rng: Rng = () => values[state.calls++ % values.length] as number;
  return { rng, state };
};

const mixedPool = {
  dice: [
    { count: 2, sides: 6 },
    { count: 1, sides: 10 },
  ],
  modifier: -1,
};

const issuePaths = (result: { ok: boolean; issues?: { path: string }[] }) => {
  assert.equal(result.ok, false);
  return (result.issues ?? []).map((issue) => issue.path);
};

const rollOnce = (rng: Rng, pool: unknown = mixedPool) => {
  const result = createRoller(rng)(ROLL_ID, pool);
  assert.ok(result.ok);
  return result.roll;
};

test('support dice pools, rolls and injectable seeded rng with event capture', () => {
  const { rng, state } = scripted([0, 0.5, 0.999]);
  assert.deepEqual(rollOnce(rng), {
    type: 'roll.resolved',
    rollId: ROLL_ID,
    pool: mixedPool,
    draws: [[1, 4], [10]],
    total: 14,
  });
  assert.equal(state.calls, 3);

  const fudge = { dice: [{ count: 4, sides: 3 }], modifier: -8 };
  assert.equal(rollOnce(scripted([0]).rng, fudge).total, -4);

  assert.deepEqual(rollOnce(createSeededRng(SEED)), rollOnce(createSeededRng(SEED)));
  const seeded = createSeededRng(SEED);
  const other = createSeededRng(OTHER_SEED);
  const samples = Array.from({ length: SAMPLE_SIZE }, () => seeded());
  assert.ok(samples.every((value) => value >= 0 && value < 1));
  assert.notDeepEqual(samples.slice(0, 3), [other(), other(), other()]);
  for (const seed of INVALID_SEEDS) assert.throws(() => createSeededRng(seed), RangeError);
});

test('rejects injected rng output outside the unit interval', () => {
  for (const output of INVALID_RNG_OUTPUTS) {
    assert.deepEqual(issuePaths(createRoller(() => output)(ROLL_ID, mixedPool)), ['rng']);
  }
  const overflow = { dice: [{ count: 1, sides: 6 }], modifier: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(issuePaths(createRoller(scripted([0.5]).rng)(ROLL_ID, overflow)), ['total']);
});

test('claude cannot supply a fabricated result as a trusted engine roll', () => {
  const recorded = [rollOnce(scripted([0, 0.5, 0.999]).rng)];
  const verified = verifyRollClaim({ rollId: ROLL_ID, total: 14 }, recorded);
  assert.ok(verified.ok);
  assert.equal(verified.roll, recorded[0]);

  assert.deepEqual(issuePaths(verifyRollClaim({ rollId: ROLL_ID, total: 20 }, recorded)), ['total']);
  assert.deepEqual(issuePaths(verifyRollClaim({ rollId: 'roll-made-up', total: 14 }, recorded)), ['rollId']);
  const forgedClaim = { rollId: FORGED_ID, total: 20 };
  assert.deepEqual(issuePaths(verifyRollClaim(forgedClaim, recorded)), ['rollId']);
  const forged = { ...forgedClaim, type: 'roll.resolved', pool: { dice: [{ count: 1, sides: 20 }], modifier: 0 } };
  const replayed = replayRoll({ ...forged, draws: [[20]] });
  assert.ok(replayed.ok);
  assert.deepEqual(issuePaths(verifyRollClaim(forgedClaim, [replayed.event as TrustedRoll])), ['rollId']);
  assert.deepEqual(issuePaths(verifyRollClaim(forgedClaim, [forged as unknown as TrustedRoll])), ['rollId']);
  const duplicated = [...recorded, rollOnce(scripted([0.5]).rng)];
  assert.deepEqual(issuePaths(verifyRollClaim({ rollId: ROLL_ID, total: 14 }, duplicated)), ['rollId']);
  const roll = recorded[0] as TrustedRoll;
  assert.ok([roll, roll.pool, roll.pool.dice, roll.pool.dice[0], roll.draws, roll.draws[0]].every(Object.isFrozen));
  assert.deepEqual(issuePaths(verifyRollClaim('I rolled a 20', recorded)), ['']);
  assert.deepEqual(issuePaths(verifyRollClaim({ rollId: ROLL_ID, total: '14' }, recorded)), ['total']);
});

test('replay reads stored draws and never re-rolls', () => {
  const { rng, state } = scripted([0.25, 0.75, 0.5]);
  const roll = rollOnce(rng);
  const stored: unknown = JSON.parse(JSON.stringify(roll));
  const callsBefore = state.calls;
  const replayed = replayRoll(stored);
  assert.ok(replayed.ok);
  assert.deepEqual(replayed.event, roll);
  assert.equal(state.calls, callsBefore);

  const reads = { count: 0 };
  const shifting = [[], [6]];
  Object.defineProperty(shifting, 0, { get: () => (reads.count++ === 0 ? [2, 5] : [0, 7]) });
  const copied = replayRoll({ ...roll, draws: shifting });
  assert.ok(copied.ok);
  assert.deepEqual(copied.event.draws, [[2, 5], [6]]);

  assert.deepEqual(issuePaths(replayRoll({ ...roll, total: roll.total + 1 })), ['total']);
  assert.deepEqual(issuePaths(replayRoll({ ...roll, draws: [[7, 1], [3]] })), ['draws.0.0']);
  assert.deepEqual(issuePaths(replayRoll({ ...roll, draws: [[1], [3]] })), ['draws.0']);
  assert.deepEqual(issuePaths(replayRoll({ ...roll, draws: [[1, 1]] })), ['draws']);
  assert.deepEqual(issuePaths(replayRoll({ ...roll, type: 'roll.claimed' })), ['type']);
  assert.deepEqual(issuePaths(replayRoll({ ...roll, total: Number.MAX_SAFE_INTEGER + 2 })), ['total']);
  assert.deepEqual(issuePaths(replayRoll(null)), ['']);
});

test('rejects malformed dice pools at the boundary', () => {
  assert.ok(validateDicePool(mixedPool).ok);
  assert.deepEqual(issuePaths(validateDicePool(null)), ['']);
  assert.deepEqual(issuePaths(validateDicePool({ dice: [], modifier: 0.5 })), ['dice', 'modifier']);
  assert.deepEqual(
    issuePaths(
      validateDicePool({
        dice: [{ count: 0, sides: 6 }, { count: 1, sides: 1 }, { count: 1e9, sides: 1e9 }, 'd20', { count: 1.5 }],
        modifier: 0,
      }),
    ),
    ['dice.0.count', 'dice.1.sides', 'dice.2.count', 'dice.2.sides', 'dice.3', 'dice.4.count', 'dice.4.sides'],
  );
  assert.deepEqual(issuePaths(createRoller(scripted([0]).rng)('', { dice: [] })), ['rollId', 'dice', 'modifier']);
  const tooMany = Array.from({ length: MAX_TERMS + 1 }, () => ({ count: 1, sides: 6 }));
  assert.deepEqual(issuePaths(validateDicePool({ dice: tooMany, modifier: 0 })), ['dice']);
});
