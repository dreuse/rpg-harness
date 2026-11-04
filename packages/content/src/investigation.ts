import type { Visibility } from '../../domain/src/entity.ts';
import {
  type GenrePackIssue,
  isNonEmptyString,
  isPlainRecord,
  NON_EMPTY_STRING,
  readStringList,
  unknownFields,
} from './genrepack.ts';

const GM: Visibility = 'gm';
const PLAYER: Visibility = 'player';
const MUST_BE_ARRAY = 'must be an array';
const MUST_BE_OBJECT = 'must be an object';
const MUST_BE_INTEGER = 'must be an integer';
const OUT_OF_RANGE = 'must be within range';
const MUST_BE_UNIQUE = 'must be unique';
const UNREACHABLE = 'no clue points to this secret';
const KIT_FIELDS = ['tension', 'clues', 'secrets', 'pacing'] as const;
const TENSION_FIELDS = ['min', 'max', 'start', 'thresholds'] as const;
const THRESHOLD_FIELDS = ['at', 'cue'] as const;
const CLUE_FIELDS = ['id', 'text', 'pointsTo'] as const;
const SECRET_FIELDS = ['id', 'statement'] as const;
const BEAT_FIELDS = ['id', 'summary', 'requiresClues'] as const;

export type TensionThreshold = { readonly at: number; readonly cue: string };
export type TensionTrack = {
  readonly min: number;
  readonly max: number;
  readonly start: number;
  readonly thresholds: readonly TensionThreshold[];
};
export type Clue = { readonly id: string; readonly text: string; readonly pointsTo: string };
export type Secret = {
  readonly id: string;
  readonly statement: string;
  readonly visibility: typeof GM;
  readonly actorId: null;
};
export type Beat = { readonly id: string; readonly summary: string; readonly requiresClues: readonly string[] };
export type InvestigationKit = {
  readonly tension: TensionTrack;
  readonly clues: readonly Clue[];
  readonly secrets: readonly Secret[];
  readonly pacing: readonly Beat[];
};
export type ScopedKnowledge = {
  readonly id: string;
  readonly statement: string;
  readonly visibility: Visibility;
  readonly actorId: null;
};
export type InvestigationKitResult = { ok: true; kit: InvestigationKit } | { ok: false; issues: GenrePackIssue[] };

type IndexedRecord = { readonly index: number; readonly record: Record<string, unknown> };

const readRecords = (
  value: unknown,
  path: string,
  fields: readonly string[],
  issues: GenrePackIssue[],
): IndexedRecord[] => {
  if (!Array.isArray(value)) {
    issues.push({ path, message: MUST_BE_ARRAY });
    return [];
  }
  const records: IndexedRecord[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    const itemPath = `${path}.${index}`;
    if (!isPlainRecord(item)) {
      issues.push({ path: itemPath, message: MUST_BE_OBJECT });
      continue;
    }
    issues.push(...unknownFields(item, fields, `${itemPath}.`));
    records.push({ index, record: { ...item } });
  }
  return records;
};

const readUniqueId = (
  record: Record<string, unknown>,
  path: string,
  seen: Set<string>,
  issues: GenrePackIssue[],
): string => {
  const id = readString(record, 'id', path, issues);
  if (id && seen.has(id)) issues.push({ path: `${path}.id`, message: MUST_BE_UNIQUE });
  seen.add(id);
  return id;
};

const readString = (record: Record<string, unknown>, field: string, path: string, issues: GenrePackIssue[]) => {
  const value = record[field];
  if (isNonEmptyString(value)) return value;
  issues.push({ path: `${path}.${field}`, message: NON_EMPTY_STRING });
  return '';
};

const readInteger = (value: unknown, path: string, issues: GenrePackIssue[]) => {
  if (Number.isInteger(value)) return value as number;
  issues.push({ path, message: MUST_BE_INTEGER });
  return Number.NaN;
};

const readTension = (value: unknown, issues: GenrePackIssue[]): TensionTrack => {
  const path = 'tension';
  const record = isPlainRecord(value) ? { ...value } : {};
  if (!isPlainRecord(value)) issues.push({ path, message: MUST_BE_OBJECT });
  issues.push(...unknownFields(record, TENSION_FIELDS, `${path}.`));
  const min = readInteger(record.min, `${path}.min`, issues);
  const max = readInteger(record.max, `${path}.max`, issues);
  const start = readInteger(record.start, `${path}.start`, issues);
  const inRange = (level: number) => !(level < min || level > max);
  if (max < min) issues.push({ path: `${path}.max`, message: 'must not be below min' });
  if (Number.isInteger(start) && !inRange(start)) issues.push({ path: `${path}.start`, message: OUT_OF_RANGE });
  const thresholds = readRecords(record.thresholds, `${path}.thresholds`, THRESHOLD_FIELDS, issues).map(
    ({ index, record: threshold }) => {
      const at = readInteger(threshold.at, `${path}.thresholds.${index}.at`, issues);
      if (Number.isInteger(at) && !inRange(at)) {
        issues.push({ path: `${path}.thresholds.${index}.at`, message: OUT_OF_RANGE });
      }
      return Object.freeze({ at, cue: readString(threshold, 'cue', `${path}.thresholds.${index}`, issues) });
    },
  );
  return Object.freeze({ min, max, start, thresholds: Object.freeze(thresholds) });
};

export const loadInvestigationKit = (input: unknown): InvestigationKitResult => {
  if (!isPlainRecord(input)) return { ok: false, issues: [{ path: '', message: MUST_BE_OBJECT }] };
  const issues = unknownFields(input, KIT_FIELDS, '');
  const tension = readTension(input.tension, issues);
  const secretIds = new Set<string>();
  const secrets = readRecords(input.secrets, 'secrets', SECRET_FIELDS, issues).map(({ index, record }) => ({
    index,
    secret: Object.freeze({
      id: readUniqueId(record, `secrets.${index}`, secretIds, issues),
      statement: readString(record, 'statement', `secrets.${index}`, issues),
      visibility: GM,
      actorId: null,
    }),
  }));
  const clueIds = new Set<string>();
  const clues = readRecords(input.clues, 'clues', CLUE_FIELDS, issues).map(({ index, record }) => {
    const path = `clues.${index}`;
    const id = readString(record, 'id', path, issues);
    if (id && (clueIds.has(id) || secretIds.has(id))) issues.push({ path: `${path}.id`, message: MUST_BE_UNIQUE });
    clueIds.add(id);
    const pointsTo = readString(record, 'pointsTo', path, issues);
    if (pointsTo && !secretIds.has(pointsTo)) {
      issues.push({ path: `${path}.pointsTo`, message: 'must reference a declared secret' });
    }
    return Object.freeze({ id, text: readString(record, 'text', path, issues), pointsTo });
  });
  const beatIds = new Set<string>();
  const pacing = readRecords(input.pacing, 'pacing', BEAT_FIELDS, issues).map(({ index, record }) => {
    const path = `pacing.${index}`;
    const id = readUniqueId(record, path, beatIds, issues);
    const summary = readString(record, 'summary', path, issues);
    const requiresClues = Object.freeze(readStringList(record.requiresClues, `${path}.requiresClues`, issues));
    requiresClues.forEach((clueId, clueIndex) => {
      if (!clueIds.has(clueId)) {
        issues.push({ path: `${path}.requiresClues.${clueIndex}`, message: 'must reference a declared clue' });
      }
    });
    return Object.freeze({ id, summary, requiresClues });
  });
  const pointedTo = new Set(clues.map((clue) => clue.pointsTo));
  for (const { index, secret } of secrets) {
    if (secret.id && !pointedTo.has(secret.id)) issues.push({ path: `secrets.${index}`, message: UNREACHABLE });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    kit: Object.freeze({
      tension,
      clues: Object.freeze(clues),
      secrets: Object.freeze(secrets.map(({ secret }) => secret)),
      pacing: Object.freeze(pacing),
    }),
  };
};

export const tensionCue = (kit: InvestigationKit, level: number): string | null =>
  kit.tension.thresholds.filter((threshold) => threshold.at <= level).sort((a, b) => b.at - a.at)[0]?.cue ?? null;

export const openBeats = (kit: InvestigationKit, discoveredClueIds: readonly string[]): readonly Beat[] =>
  kit.pacing.filter((beat) => beat.requiresClues.every((clueId) => discoveredClueIds.includes(clueId)));

export const scopedKnowledge = (
  kit: InvestigationKit,
  discoveredClueIds: readonly string[],
): readonly ScopedKnowledge[] => [
  ...kit.clues.map((clue) => ({
    id: clue.id,
    statement: clue.text,
    visibility: discoveredClueIds.includes(clue.id) ? PLAYER : GM,
    actorId: null,
  })),
  ...kit.secrets.map(({ id, statement, visibility, actorId }) => ({ id, statement, visibility, actorId })),
];
