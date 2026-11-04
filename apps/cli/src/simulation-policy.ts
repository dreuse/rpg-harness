import {
  type GenrePackIssue,
  isNonEmptyString,
  isPlainRecord,
  NON_EMPTY_STRING,
  readStringList,
} from '../../../packages/content/src/genrepack.ts';
import { SIMULATION_MODES, type SimulationMode } from '../../../packages/domain/src/simulation.ts';
import {
  DETERMINISTIC,
  GM_ADJUDICATED,
  type MechanicSupport,
  type SimulationPolicy,
} from '../../../packages/world/src/policy.ts';

export const INVALID_SIMULATION_POLICY = 'InvalidSimulationPolicy';

export type InvalidSimulationPolicy = { code: typeof INVALID_SIMULATION_POLICY; issues: GenrePackIssue[] };
export type SimulationPolicyResult =
  | { ok: true; policy: SimulationPolicy }
  | { ok: false; error: InvalidSimulationPolicy };

const MUST_BE_OBJECT = 'must be an object';
const UNKNOWN_KIND = 'unknown mechanic kind';
const MECHANIC_SUPPORT: readonly string[] = [DETERMINISTIC, GM_ADJUDICATED];
const TICK_FIELDS = ['fromTick', 'untilTick'] as const;

type Issues = GenrePackIssue[];

const readRecord = (value: unknown, path: string, issues: Issues) => {
  if (isPlainRecord(value)) return value;
  issues.push({ path, message: MUST_BE_OBJECT });
  return undefined;
};

const readMechanics = (value: unknown, suggested: readonly string[], issues: Issues) => {
  const support: Record<string, MechanicSupport> = Object.create(null);
  for (const kind of suggested) support[kind] = GM_ADJUDICATED;
  if (!Array.isArray(value)) {
    issues.push({ path: 'mechanics', message: 'must be an array' });
    return support;
  }
  for (let index = 0; index < value.length; index++) {
    const path = `mechanics.${index}`;
    const mechanic = readRecord(value[index], path, issues);
    if (!mechanic) continue;
    const { ruleId, kind } = mechanic;
    if (!isNonEmptyString(ruleId)) issues.push({ path: `${path}.ruleId`, message: NON_EMPTY_STRING });
    else if (!MECHANIC_SUPPORT.includes(kind as string)) issues.push({ path: `${path}.kind`, message: UNKNOWN_KIND });
    else support[ruleId] = kind as MechanicSupport;
  }
  return support;
};

const readTime = (value: unknown, issues: Issues): SimulationPolicy['time'] => {
  const time = readRecord(value, 'time', issues);
  if (!time) return undefined;
  const invalid = TICK_FIELDS.filter((field) => !Number.isSafeInteger(time[field]));
  for (const field of invalid) issues.push({ path: `time.${field}`, message: 'must be an integer' });
  if (invalid.length > 0) return undefined;
  const { fromTick, untilTick } = time as { fromTick: number; untilTick: number };
  if (fromTick <= untilTick) return { fromTick, untilTick };
  issues.push({ path: 'time', message: 'fromTick must not exceed untilTick' });
  return undefined;
};

const readFactionKinds = (value: unknown, issues: Issues) => {
  const factions = readRecord(value, 'factionKinds', issues);
  const kinds: Record<string, readonly string[]> = Object.create(null);
  for (const id of Object.keys(factions ?? {})) {
    kinds[id] = readStringList(factions?.[id], `factionKinds.${id}`, issues);
  }
  return kinds;
};

const optional = <T>(input: Record<string, unknown>, field: string, read: (value: unknown) => T) =>
  Object.hasOwn(input, field) ? { [field]: read(input[field]) } : {};

export const toSimulationPolicy = (input: unknown): SimulationPolicyResult => {
  const issues: Issues = [];
  const fields = readRecord(input, '', issues);
  if (!fields) return { ok: false, error: { code: INVALID_SIMULATION_POLICY, issues } };
  const genre = readRecord(fields.genre, 'genre', issues);
  const suggested = genre ? readStringList(genre.suggestedCapabilities, 'genre.suggestedCapabilities', issues) : [];
  const mechanics = readMechanics(fields.mechanics, suggested, issues);
  const mode = readRecord(fields.preferences, 'preferences', issues)?.simulation;
  if (!SIMULATION_MODES.includes(mode as SimulationMode)) {
    issues.push({ path: 'preferences.simulation', message: 'unknown simulation mode' });
  }
  if (typeof fields.adjudicator !== 'boolean') issues.push({ path: 'adjudicator', message: 'must be a boolean' });
  const constraints = {
    ...optional(fields, 'time', (value) => readTime(value, issues)),
    ...optional(fields, 'factionKinds', (value) => readFactionKinds(value, issues)),
    ...optional(fields, 'forbiddenKinds', (value) => readStringList(value, 'forbiddenKinds', issues)),
  };
  if (issues.length > 0) return { ok: false, error: { code: INVALID_SIMULATION_POLICY, issues } };
  const policy: SimulationPolicy = {
    mode: mode as SimulationMode,
    adjudicator: fields.adjudicator as boolean,
    mechanics,
    ...constraints,
  };
  return { ok: true, policy };
};
