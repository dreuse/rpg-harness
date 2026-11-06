import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosineSimilarity } from './speaker-embedding.ts';
import { mixPack, searchVoicepack, seededRandom } from './voicepack-search.ts';

const DIMENSION = 4;
const ROWS = 3;
const SEED = 7;
const OTHER_SEED = 8;
const SAMPLES = 5;
const WEIGHT_STEPS = 40;
const DELTA_STEPS = 60;
const EPSILON = 1e-6;

const row = (values: number[]): number[] => Array.from({ length: ROWS }, () => values).flat();
const BASES = [
  Float32Array.from(row([1, 0, 0, 0])),
  Float32Array.from(row([0, 1, 0, 0])),
  Float32Array.from(row([0, 0, 1, 0])),
];
const TARGET = Float32Array.from(row([0.2, 0.7, 0.4, 0.5]));

const options = (seed: number) => ({
  bases: BASES,
  dimension: DIMENSION,
  seed,
  weightSteps: WEIGHT_STEPS,
  deltaSteps: DELTA_STEPS,
  score: async (pack: Float32Array) => cosineSimilarity(pack, TARGET),
});

test('rpg-cm63.63 the seeded generator repeats and stays in [0, 1)', () => {
  const first = seededRandom(SEED);
  const second = seededRandom(SEED);
  const values = Array.from({ length: SAMPLES }, () => first());
  assert.deepEqual(
    values,
    Array.from({ length: SAMPLES }, () => second()),
  );
  for (const value of values) assert.ok(value >= 0 && value < 1);
  assert.notEqual(seededRandom(OTHER_SEED)(), values[0]);
});

test('rpg-cm63.63 mixPack applies weights then adds the delta to every row', () => {
  const pack = mixPack(BASES, [0.5, 0.5, 0], Float32Array.of(0.1, 0.1, 0.1, 0.1), DIMENSION);
  assert.equal(pack.length, ROWS * DIMENSION);
  for (let r = 0; r < ROWS; r++)
    assert.deepEqual(
      [...pack.slice(r * DIMENSION, (r + 1) * DIMENSION)].map((v) => +v.toFixed(3)),
      [0.6, 0.6, 0.1, 0.1],
    );
});

test('rpg-cm63.63 the search beats the best single base and keeps the weights on the simplex', async () => {
  const bestBase = Math.max(...BASES.map((base) => cosineSimilarity(base, TARGET)));
  const result = await searchVoicepack(options(SEED));
  assert.ok(result.score > bestBase);
  assert.ok(Math.abs(result.weights.reduce((sum, weight) => sum + weight, 0) - 1) < EPSILON);
  for (const weight of result.weights) assert.ok(weight >= 0);
  assert.equal(result.pack.length, BASES[0]?.length);
});

test('rpg-cm63.63 the same seed gives the same result', async () => {
  const [a, b] = [await searchVoicepack(options(SEED)), await searchVoicepack(options(SEED))];
  assert.equal(a.score, b.score);
  assert.deepEqual(a.weights, b.weights);
  assert.deepEqual(a.pack, b.pack);
});

test('rpg-cm63.63 the reported score is the score of the returned pack', async () => {
  const result = await searchVoicepack(options(SEED));
  assert.equal(result.score, cosineSimilarity(result.pack, TARGET));
});

test('rpg-cm63.63 the search never scores below its best base', async () => {
  const noMoves = await searchVoicepack({ ...options(SEED), weightSteps: 0, deltaSteps: 0 });
  assert.equal(noMoves.score, Math.max(...BASES.map((base) => cosineSimilarity(base, TARGET))));
});
