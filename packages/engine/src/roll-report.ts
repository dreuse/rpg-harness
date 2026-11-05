import { createSeededRng, type Rng } from '../../rules/src/dice.ts';
import { type Check, PLAYER_SOURCE, type ReportedRoll } from './turn.ts';

export const ROLL_REPORT_OUT_OF_RANGE = 'rollReport.outOfRange';
const PROBE_SEED = 1;
const MIN_FACE = 1;
const HALF_FACE = 0.5;
const SUM_START = 0;
const UNBOUNDED = Number.POSITIVE_INFINITY;

export type RollReportParams = {
  readonly expression: string;
  readonly min: number;
  readonly max: number;
};

export class RollReportError extends Error {
  readonly key = ROLL_REPORT_OUT_OF_RANGE;
  readonly params: RollReportParams;

  constructor(params: RollReportParams) {
    super(`a roll of ${params.expression} reports ${params.min} to ${params.max}`);
    this.params = params;
  }
}

const isFace = (value: unknown, sides: number) =>
  Number.isInteger(value) && Number(value) >= MIN_FACE && Number(value) <= sides;

const probe = (check: Check) => check('probe', createSeededRng(PROBE_SEED));

const termsOf = (check: Check) => probe(check).rolls.flatMap(({ pool }) => pool.dice);

const sidesOf = (check: Check) =>
  termsOf(check).flatMap(({ count, sides }) => Array.from({ length: count }, () => sides));

export const rollExpressionOf = (check: Check): string =>
  termsOf(check)
    .map(({ count, sides }) => `${count}d${sides}`)
    .join('+');

const distribute = (total: number, sides: readonly number[]) => {
  let left = total - sides.length;
  return sides.map((faceCap) => {
    const extra = Math.min(left, faceCap - MIN_FACE);
    left -= extra;
    return MIN_FACE + extra;
  });
};

const facesOf = (values: readonly number[], sides: readonly number[], expression: string) => {
  const range: RollReportParams = {
    expression,
    min: sides.length,
    max: sides.reduce((sum, cap) => sum + cap, SUM_START),
  };
  const perDie = values.length === sides.length && values.every((value, index) => isFace(value, sides[index] ?? 0));
  const total = values[0];
  const asTotal =
    values.length === 1 && Number.isInteger(total) && Number(total) >= range.min && Number(total) <= range.max;
  if (perDie) return values;
  if (asTotal) return distribute(Number(total), sides);
  throw new RollReportError(range);
};

const rngOf = (faces: readonly number[], sides: readonly number[]): Rng => {
  let index = 0;
  return () => {
    const next = ((faces[index] ?? MIN_FACE) - MIN_FACE + HALF_FACE) / (sides[index] ?? MIN_FACE);
    index += 1;
    return next;
  };
};

export const reportedCheck =
  (check: Check, values: readonly number[]): Check =>
  (actionId) => {
    const sides = sidesOf(check);
    const faces = facesOf(values, sides, rollExpressionOf(check));
    return { ...check(actionId, rngOf(faces, sides)), source: PLAYER_SOURCE, reported: values };
  };

export const reportedRoll = (values: readonly number[]): ReportedRoll => {
  if (values.length === 0 || !values.every((value) => isFace(value, UNBOUNDED)))
    throw new RollReportError({ expression: '', min: MIN_FACE, max: UNBOUNDED });
  return { reportedRoll: values };
};
