export interface SearchOptions {
  readonly bases: readonly Float32Array[];
  readonly dimension: number;
  readonly seed: number;
  readonly weightSteps: number;
  readonly deltaSteps: number;
  readonly score: (pack: Float32Array) => Promise<number>;
}

export interface SearchResult {
  readonly weights: readonly number[];
  readonly delta: Float32Array;
  readonly pack: Float32Array;
  readonly score: number;
}

const WEIGHT_MOVES = Object.freeze([0.05, 0.1, 0.2, 0.3]);
const DELTA_LIMIT_RATIO = 0.5;
const SIGMA_START_RATIO = 0.25;
const SIGMA_MIN_RATIO = 0.01;
const SIGMA_SHRINK = 0.97;
const SIGMA_GROW = 1.1;
const UINT32 = 2 ** 32;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const MULBERRY_SHIFT_A = 15;
const MULBERRY_SHIFT_B = 7;
const MULBERRY_SHIFT_C = 14;
const MULBERRY_MIX = 61;

export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> MULBERRY_SHIFT_A), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> MULBERRY_SHIFT_B), mixed | MULBERRY_MIX);
    return ((mixed ^ (mixed >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32;
  };
};

export const mixPack = (
  bases: readonly Float32Array[],
  weights: readonly number[],
  delta: Float32Array,
  dimension: number,
): Float32Array => {
  const pack = new Float32Array(bases[0]?.length ?? 0);
  bases.forEach((base, index) => {
    const weight = weights[index] ?? 0;
    if (weight !== 0)
      for (let i = 0; i < pack.length; i++) pack[i] = (pack[i] as number) + weight * (base[i] as number);
  });
  for (let i = 0; i < pack.length; i++) pack[i] = (pack[i] as number) + (delta[i % dimension] as number);
  return pack;
};

const rmsOf = (bases: readonly Float32Array[]): number => {
  const base = bases[0] ?? new Float32Array();
  return Math.sqrt(base.reduce((sum, value) => sum + value * value, 0) / (base.length || 1));
};

const gaussian = (random: () => number): number =>
  Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

export const searchVoicepack = async ({
  bases,
  dimension,
  seed,
  weightSteps,
  deltaSteps,
  score,
}: SearchOptions): Promise<SearchResult> => {
  const random = seededRandom(seed);
  const noDelta = new Float32Array(dimension);
  const oneHot = (index: number): number[] => bases.map((_, i) => (i === index ? 1 : 0));
  const scored: number[] = [];
  for (const base of bases) scored.push(await score(base));
  const start = scored.indexOf(Math.max(...scored));
  let weights = oneHot(start);
  let delta = noDelta;
  let best = scored[start] as number;

  for (let step = 0; step < weightSteps; step++) {
    const donors = weights.flatMap((weight, index) => (weight > 0 ? [index] : []));
    const from = donors[Math.floor(random() * donors.length)] as number;
    const to = Math.floor(random() * bases.length);
    if (to === from) continue;
    const move = Math.min(weights[from] as number, WEIGHT_MOVES[Math.floor(random() * WEIGHT_MOVES.length)] as number);
    const next = weights.map((weight, index) =>
      index === from ? weight - move : index === to ? weight + move : weight,
    );
    const value = await score(mixPack(bases, next, delta, dimension));
    if (value > best) [weights, best] = [next, value];
  }

  const limit = DELTA_LIMIT_RATIO * rmsOf(bases);
  let sigma = SIGMA_START_RATIO * limit;
  for (let step = 0; step < deltaSteps; step++) {
    const next = delta.map((value) => Math.max(-limit, Math.min(limit, value + sigma * gaussian(random))));
    const value = await score(mixPack(bases, weights, next, dimension));
    if (value > best) {
      [delta, best] = [next, value];
      sigma *= SIGMA_GROW;
    } else sigma = Math.max(sigma * SIGMA_SHRINK, SIGMA_MIN_RATIO * limit);
  }

  return { weights, delta, pack: mixPack(bases, weights, delta, dimension), score: best };
};
