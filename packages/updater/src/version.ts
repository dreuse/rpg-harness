const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC = /^\d+$/;
const IDENTIFIER_SEPARATOR = '.';
const SAME = 0;
const BEFORE = -1;
const AFTER = 1;

export type Version = {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
  readonly prerelease: boolean;
  readonly text: string;
};

export const parseVersion = (tag: string): Version | undefined => {
  const match = VERSION_PATTERN.exec(tag.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, pre] = match;
  const core = [Number(major), Number(minor), Number(patch)] as const;
  return {
    core,
    pre: pre === undefined ? [] : pre.split(IDENTIFIER_SEPARATOR),
    prerelease: pre !== undefined,
    text: `${core.join(IDENTIFIER_SEPARATOR)}${pre === undefined ? '' : `-${pre}`}`,
  };
};

const compareIdentifiers = (a: string, b: string): number => {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric !== bNumeric) return aNumeric ? BEFORE : AFTER;
  if (a === b) return SAME;
  return a < b ? BEFORE : AFTER;
};

const comparePre = (a: readonly string[], b: readonly string[]): number => {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (const [index, identifier] of a.entries()) {
    const other = b[index];
    if (other === undefined) return AFTER;
    const order = compareIdentifiers(identifier, other);
    if (order !== SAME) return order;
  }
  return a.length - b.length;
};

export const compareVersions = (a: Version, b: Version): number =>
  a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2] || comparePre(a.pre, b.pre);
