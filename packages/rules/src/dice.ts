import { isNonEmptyString, isRecord, type ManifestIssue, NON_EMPTY_STRING } from './rulepack.ts';

export const ROLL_EVENT_TYPE = 'roll.resolved';
export const MAX_TERMS = 20;
export const MAX_DICE_PER_TERM = 100;
export const MIN_SIDES = 2;
export const MAX_SIDES = 1000;

const MIN_FACE = 1;
const SAFE_INTEGER = 'must be a safe integer';
const MULBERRY32_INCREMENT = 0x6d2b79f5;
const UINT32_RANGE = 2 ** 32;

declare const TRUSTED: unique symbol;

export type Rng = () => number;
export type DieTerm = { readonly count: number; readonly sides: number };
export type DicePool = { readonly dice: readonly DieTerm[]; readonly modifier: number };
export type RollEvent = {
  readonly type: typeof ROLL_EVENT_TYPE;
  readonly rollId: string;
  readonly pool: DicePool;
  readonly draws: readonly (readonly number[])[];
  readonly total: number;
};
export type TrustedRoll = RollEvent & { readonly [TRUSTED]: true };
export type DicePoolResult = { ok: true; pool: DicePool } | { ok: false; issues: ManifestIssue[] };
export type RollResult = { ok: true; roll: TrustedRoll } | { ok: false; issues: ManifestIssue[] };
export type ReplayResult = { ok: true; event: RollEvent } | { ok: false; issues: ManifestIssue[] };

const issued = new WeakSet<RollEvent>();

export const createSeededRng = (seed: number): Rng => {
  if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer');
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY32_INCREMENT) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
};

const isUnitInterval = (value: number) => Number.isFinite(value) && value >= 0 && value < 1;

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const fail = (path: string, message: string) => ({ ok: false as const, issues: [{ path, message }] });

const parseTerm = (input: unknown, path: string, issues: ManifestIssue[]): DieTerm | undefined => {
  if (!isRecord(input)) {
    issues.push({ path, message: 'must be an object' });
    return undefined;
  }
  const { count, sides } = input;
  if (!isIntegerIn(count, MIN_FACE, MAX_DICE_PER_TERM)) {
    issues.push({ path: `${path}.count`, message: `must be an integer from ${MIN_FACE} to ${MAX_DICE_PER_TERM}` });
  }
  if (!isIntegerIn(sides, MIN_SIDES, MAX_SIDES)) {
    issues.push({ path: `${path}.sides`, message: `must be an integer from ${MIN_SIDES} to ${MAX_SIDES}` });
  }
  return { count: count as number, sides: sides as number };
};

export const validateDicePool = (input: unknown): DicePoolResult => {
  if (!isRecord(input)) return fail('', 'must be an object');
  const { dice, modifier } = input;
  const issues: ManifestIssue[] = [];
  if (!Array.isArray(dice) || dice.length === 0 || dice.length > MAX_TERMS) {
    issues.push({ path: 'dice', message: `must be an array of 1 to ${MAX_TERMS} terms` });
  }
  if (!Number.isSafeInteger(modifier)) issues.push({ path: 'modifier', message: SAFE_INTEGER });
  const terms = (Array.isArray(dice) ? dice : []).map((term: unknown, index) =>
    parseTerm(term, `dice.${index}`, issues),
  );
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, pool: { dice: terms as DieTerm[], modifier: modifier as number } };
};

const sumDraws = (pool: DicePool, draws: readonly (readonly number[])[]) =>
  draws.flat().reduce((sum, face) => sum + face, pool.modifier);

const toEvent = (rollId: string, pool: DicePool, draws: readonly (readonly number[])[]): RollEvent =>
  Object.freeze({
    type: ROLL_EVENT_TYPE,
    rollId,
    pool: Object.freeze({ ...pool, dice: Object.freeze(pool.dice.map((term) => Object.freeze({ ...term }))) }),
    draws: Object.freeze(draws.map((faces) => Object.freeze([...faces]))),
    total: sumDraws(pool, draws),
  });

export const createRoller =
  (rng: Rng) =>
  (rollId: string, pool: unknown): RollResult => {
    const parsed = validateDicePool(pool);
    const issues = [
      ...(isNonEmptyString(rollId) ? [] : [{ path: 'rollId', message: NON_EMPTY_STRING }]),
      ...(parsed.ok ? [] : parsed.issues),
    ];
    if (!parsed.ok || issues.length > 0) return { ok: false, issues };
    const outputs = parsed.pool.dice.map((term) => Array.from({ length: term.count }, () => rng()));
    if (!outputs.flat().every(isUnitInterval)) {
      return fail('rng', 'must return a finite number from 0 inclusive to 1 exclusive');
    }
    const draws = outputs.map((values, index) =>
      values.map((value) => Math.floor(value * (parsed.pool.dice[index] as DieTerm).sides) + MIN_FACE),
    );
    if (!Number.isSafeInteger(sumDraws(parsed.pool, draws))) return fail('total', SAFE_INTEGER);
    const roll = toEvent(rollId, parsed.pool, draws);
    issued.add(roll);
    return { ok: true, roll: roll as TrustedRoll };
  };

const drawIssues = (pool: DicePool, draws: unknown): ManifestIssue[] => {
  if (!Array.isArray(draws) || draws.length !== pool.dice.length) {
    return [{ path: 'draws', message: 'must hold one list per die term' }];
  }
  return pool.dice.flatMap((term, index) => {
    const faces: unknown = draws[index];
    if (!Array.isArray(faces) || faces.length !== term.count) {
      return [{ path: `draws.${index}`, message: 'must hold one face per die' }];
    }
    return faces.flatMap((face: unknown, faceIndex) =>
      isIntegerIn(face, MIN_FACE, term.sides)
        ? []
        : [{ path: `draws.${index}.${faceIndex}`, message: `must be an integer from ${MIN_FACE} to ${term.sides}` }],
    );
  });
};

const copyDraws = (draws: unknown): unknown =>
  Array.isArray(draws) ? draws.map((faces: unknown) => (Array.isArray(faces) ? [...faces] : faces)) : draws;

export const replayRoll = (stored: unknown): ReplayResult => {
  if (!isRecord(stored)) return fail('', 'must be an object');
  const { type, rollId, pool, draws, total } = stored;
  const issues: ManifestIssue[] = [];
  if (type !== ROLL_EVENT_TYPE) issues.push({ path: 'type', message: `must be ${ROLL_EVENT_TYPE}` });
  if (!isNonEmptyString(rollId)) issues.push({ path: 'rollId', message: NON_EMPTY_STRING });
  if (!Number.isSafeInteger(total)) issues.push({ path: 'total', message: SAFE_INTEGER });
  const parsed = validateDicePool(pool);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [...issues, ...parsed.issues.map((issue) => ({ ...issue, path: `pool.${issue.path}` }))],
    };
  }
  const copied = copyDraws(draws);
  issues.push(...drawIssues(parsed.pool, copied));
  if (issues.length > 0) return { ok: false, issues };
  const event = toEvent(rollId as string, parsed.pool, copied as number[][]);
  if (event.total !== total) return fail('total', 'must equal the sum of stored draws and modifier');
  return { ok: true, event };
};

export const verifyRollClaim = (claim: unknown, recorded: readonly TrustedRoll[]): RollResult => {
  if (!isRecord(claim)) return fail('', 'must be an object');
  const { rollId, total } = claim;
  const issues: ManifestIssue[] = [];
  if (!isNonEmptyString(rollId)) issues.push({ path: 'rollId', message: NON_EMPTY_STRING });
  if (!Number.isSafeInteger(total)) issues.push({ path: 'total', message: SAFE_INTEGER });
  if (issues.length > 0) return { ok: false, issues };
  const matches = recorded.filter((entry) => issued.has(entry) && entry.rollId === rollId);
  const [roll] = matches;
  if (!roll) return fail('rollId', 'must reference a roll recorded by the engine roller');
  if (matches.length > 1) return fail('rollId', 'must reference exactly one recorded engine roll');
  if (roll.total !== total) return fail('total', 'must equal the recorded engine roll total');
  return { ok: true, roll };
};
