const ID_START = 1;

const isUnitInterval = (value: number) => Number.isFinite(value) && value >= 0 && value < 1;

export const createScriptedRng = (values: readonly number[]): (() => number) => {
  if (values.length === 0 || !values.every(isUnitInterval)) {
    throw new RangeError('scripted rng needs values from 0 inclusive to 1 exclusive');
  }
  let calls = 0;
  return () => values[calls++ % values.length] as number;
};

export const createFixedClock = (start: string, stepMs = 0): (() => string) => {
  const origin = Date.parse(start);
  if (Number.isNaN(origin)) throw new RangeError(`invalid clock start ${start}`);
  let ticks = 0;
  return () => new Date(origin + stepMs * ticks++).toISOString();
};

export const createSequentialIds = (prefix: string): (() => string) => {
  let next = ID_START;
  return () => `${prefix}-${next++}`;
};
