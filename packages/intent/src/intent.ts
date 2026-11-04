import { isDeepStrictEqual } from 'node:util';

export const PROVENANCES = ['default', 'explicit', 'derived'] as const;
export const CAPABILITY_MODES = ['rulepack', 'on', 'off'] as const;
export const PACINGS = ['off', 'slow', 'balanced', 'fast'] as const;
export const CLIENTS = ['cli', 'tui', 'desktop'] as const;
export const TIMELINES = ['linear', 'branching'] as const;

export type Provenance = (typeof PROVENANCES)[number];
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
export type Pacing = (typeof PACINGS)[number];
export type Client = (typeof CLIENTS)[number];
export type Timeline = (typeof TIMELINES)[number];

export type Sourced<T> = { value: T; provenance: Provenance };
export type RulesetChoice = { id: string; edition: string | null };

export type IntentValues = {
  ruleset: RulesetChoice | null;
  genre: string | null;
  mood: string | null;
  character: string | null;
  simulation: boolean;
  pacing: Pacing;
  dice: CapabilityMode;
  attributes: CapabilityMode;
  combat: CapabilityMode;
  voiceInput: boolean;
  voiceOutput: boolean;
  ambience: boolean;
  diceVisualization: boolean;
  rulebookImport: boolean;
  doltStorage: boolean;
  client: Client;
  houseRules: string[];
  timeline: Timeline;
};

export type IntentField = keyof IntentValues;
export type CampaignIntent = { [K in IntentField]: Sourced<IntentValues[K]> };
export type CampaignIntentInput = { [K in IntentField]?: Sourced<IntentValues[K]> };

export type IntentIssueCode = 'invalid_type' | 'invalid_value' | 'invalid_provenance' | 'unknown_field';
export type IntentIssue = { code: IntentIssueCode; path: string };
export type ParseResult = { ok: true; intent: CampaignIntent } | { ok: false; issues: IntentIssue[] };

type FieldSpec<K extends IntentField> = { fallback: IntentValues[K]; accepts: (value: unknown) => boolean };

const ENTRY_KEYS = ['value', 'provenance'];
const RULESET_KEYS = ['id', 'edition'];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const isDenseArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && Object.keys(value).length === value.length && Array.from(value).every(isNonEmptyString);
const unknownKeys = (record: Record<string, unknown>, allowed: string[], path: string): IntentIssue[] =>
  Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ code: 'unknown_field', path: `${path}.${key}` }));
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const nullable = (check: (value: unknown) => boolean) => (value: unknown) => value === null || check(value);
const oneOf = (list: readonly string[]) => (value: unknown) => typeof value === 'string' && list.includes(value);

const isRuleset = (value: unknown) =>
  isRecord(value) && isNonEmptyString(value.id) && (value.edition === null || isNonEmptyString(value.edition));

const FIELD_SPECS: { [K in IntentField]: FieldSpec<K> } = {
  ruleset: { fallback: null, accepts: nullable(isRuleset) },
  genre: { fallback: null, accepts: nullable(isNonEmptyString) },
  mood: { fallback: null, accepts: nullable(isNonEmptyString) },
  character: { fallback: null, accepts: nullable(isNonEmptyString) },
  simulation: { fallback: false, accepts: isBoolean },
  pacing: { fallback: 'balanced', accepts: oneOf(PACINGS) },
  dice: { fallback: 'rulepack', accepts: oneOf(CAPABILITY_MODES) },
  attributes: { fallback: 'rulepack', accepts: oneOf(CAPABILITY_MODES) },
  combat: { fallback: 'rulepack', accepts: oneOf(CAPABILITY_MODES) },
  voiceInput: { fallback: false, accepts: isBoolean },
  voiceOutput: { fallback: false, accepts: isBoolean },
  ambience: { fallback: false, accepts: isBoolean },
  diceVisualization: { fallback: false, accepts: isBoolean },
  rulebookImport: { fallback: false, accepts: isBoolean },
  doltStorage: { fallback: false, accepts: isBoolean },
  client: { fallback: 'cli', accepts: oneOf(CLIENTS) },
  houseRules: { fallback: [], accepts: isDenseArray },
  timeline: { fallback: 'linear', accepts: oneOf(TIMELINES) },
};

export const INTENT_FIELDS = Object.keys(FIELD_SPECS) as IntentField[];

export const isExplicitConsent = (entry: Sourced<unknown>): boolean => entry.provenance === 'explicit';

export const createCampaignIntent = (input: CampaignIntentInput): CampaignIntent =>
  Object.fromEntries(
    INTENT_FIELDS.map((field) => [
      field,
      input[field] ?? { value: structuredClone(FIELD_SPECS[field].fallback), provenance: 'default' },
    ]),
  ) as CampaignIntent;

const issuesFor = (field: IntentField, entry: unknown): IntentIssue[] => {
  if (!isRecord(entry)) return [{ code: 'invalid_type', path: field }];
  const issues = unknownKeys(entry, ENTRY_KEYS, field);
  if (!oneOf(PROVENANCES)(entry.provenance)) issues.push({ code: 'invalid_provenance', path: `${field}.provenance` });
  const { fallback, accepts } = FIELD_SPECS[field];
  const isValidDefault = entry.provenance !== 'default' || isDeepStrictEqual(entry.value, fallback);
  if (!accepts(entry.value) || !isValidDefault) issues.push({ code: 'invalid_value', path: `${field}.value` });
  if (field === 'ruleset' && isRecord(entry.value))
    issues.push(...unknownKeys(entry.value, RULESET_KEYS, `${field}.value`));
  return issues;
};

const cloneEntry = (entry: Sourced<unknown>) => ({
  value: entry.value,
  provenance: entry.provenance,
});

const snapshot = (input: unknown): unknown => {
  try {
    return isRecord(input) ? structuredClone(input) : undefined;
  } catch {
    return undefined;
  }
};

export const parseCampaignIntent = (raw: unknown): ParseResult => {
  const input = snapshot(raw);
  if (!isRecord(input)) return { ok: false, issues: [{ code: 'invalid_type', path: '' }] };
  const issues = Object.entries(input).flatMap(([key, entry]): IntentIssue[] =>
    Object.hasOwn(FIELD_SPECS, key) ? issuesFor(key as IntentField, entry) : [{ code: 'unknown_field', path: key }],
  );
  if (issues.length > 0) return { ok: false, issues };
  const copy = Object.fromEntries(
    Object.entries(input).map(([key, entry]) => [key, cloneEntry(entry as Sourced<unknown>)]),
  );
  return { ok: true, intent: createCampaignIntent(copy as CampaignIntentInput) };
};
