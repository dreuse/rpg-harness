import { isDeepStrictEqual } from 'node:util';
import type { ClarificationPlan } from './clarification.ts';
import { detectConflicts, MECHANICAL_FIELDS } from './conflicts.ts';
import {
  type CampaignIntent,
  type CapabilityMode,
  INTENT_FIELDS,
  type IntentField,
  type IntentIssue,
  type IntentIssueCode,
  type IntentValues,
  type Provenance,
  parseCampaignIntent,
} from './intent.ts';
import { type CapabilityReport, type MatchFailureCode, matchGenre, matchRuleset, type Registry } from './registry.ts';

export const CONFIG_VERSION = 1;

export type DropReason = 'explicit_wins' | 'derived_wins';
export type MechanicalField = (typeof MECHANICAL_FIELDS)[number];
export type PinnedRulePack = { id: string; edition: string; revision: string };
export type PinnedGenre = { id: string; version: string };
export type CapabilityDecisions = CapabilityReport & { modes: Record<MechanicalField, CapabilityMode> };
export type DroppedDefault = { field: IntentField; value: unknown; reason: DropReason };
export type CampaignConfig = {
  configVersion: typeof CONFIG_VERSION;
  values: IntentValues;
  provenance: Record<IntentField, Provenance>;
  rulepack: PinnedRulePack | null;
  genre: PinnedGenre | null;
  capabilities: CapabilityDecisions;
  dropped: DroppedDefault[];
};
export type ConfigIssueCode =
  | IntentIssueCode
  | MatchFailureCode
  | 'conflict'
  | 'clarification_pending'
  | 'unsupported_version'
  | 'mismatch';
export type ConfigIssue = { code: ConfigIssueCode; path: string };
export type ConfigResult = { ok: true; config: CampaignConfig } | { ok: false; issues: ConfigIssue[] };

const CONFIG_KEYS = ['configVersion', 'values', 'provenance', 'rulepack', 'genre', 'capabilities', 'dropped'];
const RULEPACK_KEYS = ['id', 'edition', 'revision'];
const GENRE_KEYS = ['id', 'version'];
const REPORT_KEYS = ['advertised', 'supported', 'unsupported'];
const CAPABILITY_KEYS = [...REPORT_KEYS, 'modes'];
const DROPPED_KEYS = ['field', 'value', 'reason'];
const INTENT_PATH = 'intent';
const DROP_REASONS: Partial<Record<Provenance, DropReason>> = { explicit: 'explicit_wins', derived: 'derived_wins' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  isRecord(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const isText = (value: unknown) => typeof value === 'string' && value.trim() !== '';
const isTextList = (value: unknown) => Array.isArray(value) && value.every(isText);
const isPin = (value: unknown, keys: string[]): value is Record<string, string> =>
  hasKeys(value, keys) && keys.every((key) => isText(value[key]));
const fail = (issues: ConfigIssue[]): ConfigResult => ({ ok: false, issues });
const prefixed = (issues: IntentIssue[]): ConfigIssue[] =>
  issues.map(({ code, path }) => ({ code, path: `${INTENT_PATH}.${path}` }));

const snapshot = (raw: unknown): unknown => {
  try {
    return structuredClone(raw);
  } catch {
    return undefined;
  }
};

const zip = (values: Record<string, unknown>, provenance: Record<string, unknown>) =>
  Object.fromEntries(
    [...new Set([...INTENT_FIELDS, ...Object.keys(values), ...Object.keys(provenance)])].map((field) => [
      field,
      { value: values[field], provenance: provenance[field] },
    ]),
  );
const valuesOf = (intent: CampaignIntent) =>
  Object.fromEntries(INTENT_FIELDS.map((field) => [field, intent[field].value])) as IntentValues;
const provenanceOf = (intent: CampaignIntent) =>
  Object.fromEntries(INTENT_FIELDS.map((field) => [field, intent[field].provenance])) as Record<
    IntentField,
    Provenance
  >;
const modesOf = (values: IntentValues) =>
  Object.fromEntries(MECHANICAL_FIELDS.map((field) => [field, values[field]])) as Record<
    MechanicalField,
    CapabilityMode
  >;

const pinsRuleset = (ruleset: IntentValues['ruleset'], pin: unknown) =>
  ruleset === null
    ? pin === null
    : isPin(pin, RULEPACK_KEYS) &&
      pin.id === ruleset.id &&
      (ruleset.edition === null || pin.edition === ruleset.edition);
const pinsGenre = (genre: IntentValues['genre'], pin: unknown) =>
  genre === null ? pin === null : isPin(pin, GENRE_KEYS) && pin.id === genre;

const conflictIssues = (intent: CampaignIntent, report: CapabilityReport): ConfigIssue[] =>
  detectConflicts(intent, report).map((conflict) => ({ code: 'conflict', path: conflict.entries[0]?.field ?? '' }));

const capabilityIssues = (intent: CampaignIntent, capabilities: unknown): ConfigIssue[] => {
  if (!hasKeys(capabilities, CAPABILITY_KEYS) || !REPORT_KEYS.every((key) => isTextList(capabilities[key])))
    return [{ code: 'invalid_type', path: 'capabilities' }];
  const report = capabilities as CapabilityDecisions;
  const supported = MECHANICAL_FIELDS.filter((field) => report.advertised.includes(field));
  const unsupported = MECHANICAL_FIELDS.filter((field) => !report.advertised.includes(field));
  if (!isDeepStrictEqual(report.supported, supported) || !isDeepStrictEqual(report.unsupported, unsupported))
    return [{ code: 'mismatch', path: 'capabilities' }];
  if (!isDeepStrictEqual(report.modes, modesOf(valuesOf(intent))))
    return [{ code: 'mismatch', path: 'capabilities.modes' }];
  return conflictIssues(intent, report);
};

const isDroppedList = (dropped: unknown, intent: CampaignIntent) =>
  Array.isArray(dropped) &&
  dropped.every(
    (entry) =>
      hasKeys(entry, DROPPED_KEYS) &&
      INTENT_FIELDS.includes(entry.field as IntentField) &&
      entry.reason !== undefined &&
      entry.reason === DROP_REASONS[intent[entry.field as IntentField].provenance],
  );

export const parseCampaignConfig = (raw: unknown): ConfigResult => {
  const input = snapshot(raw);
  if (!isRecord(input)) return fail([{ code: 'invalid_type', path: '' }]);
  const unknown = Object.keys(input).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) return fail(unknown.map((path) => ({ code: 'unknown_field', path })));
  if (input.configVersion !== CONFIG_VERSION) return fail([{ code: 'unsupported_version', path: 'configVersion' }]);
  const { values, provenance, rulepack, genre, capabilities, dropped } = input;
  if (!isRecord(values) || !isRecord(provenance)) return fail([{ code: 'invalid_type', path: INTENT_PATH }]);
  const parsed = parseCampaignIntent(zip(values, provenance));
  if (!parsed.ok) return fail(prefixed(parsed.issues));
  const effective = valuesOf(parsed.intent);
  const issues: ConfigIssue[] = [
    ...(pinsRuleset(effective.ruleset, rulepack) ? [] : [{ code: 'mismatch' as const, path: 'rulepack' }]),
    ...(pinsGenre(effective.genre, genre) ? [] : [{ code: 'mismatch' as const, path: 'genre' }]),
    ...capabilityIssues(parsed.intent, capabilities),
    ...(isDroppedList(dropped, parsed.intent) ? [] : [{ code: 'invalid_type' as const, path: 'dropped' }]),
  ];
  if (issues.length > 0) return fail(issues);
  return {
    ok: true,
    config: {
      configVersion: CONFIG_VERSION,
      values: effective,
      provenance: provenanceOf(parsed.intent),
      rulepack,
      genre,
      capabilities,
      dropped,
    } as CampaignConfig,
  };
};

export const generateCampaignConfig = (
  intent: CampaignIntent,
  registry: Registry,
  plan?: ClarificationPlan,
): ConfigResult => {
  const proposals = plan?.defaults ?? [];
  const winner = (field: IntentField) => {
    const provenance = intent[field]?.provenance;
    return provenance === undefined ? undefined : DROP_REASONS[provenance];
  };
  const dropped = proposals.flatMap((proposal): DroppedDefault[] => {
    const reason = winner(proposal.field);
    return reason ? [{ field: proposal.field, value: proposal.value, reason }] : [];
  });
  const applied = proposals
    .filter((proposal) => !winner(proposal.field))
    .map((proposal) => [proposal.field, { value: proposal.value, provenance: proposal.provenance }]);
  const parsed = parseCampaignIntent({ ...intent, ...Object.fromEntries(applied) });
  if (!parsed.ok) return fail(prefixed(parsed.issues));

  const effective = parsed.intent;
  const ruleset = effective.ruleset.value;
  const genre = effective.genre.value;
  const rules = ruleset === null ? null : matchRuleset(registry, ruleset, MECHANICAL_FIELDS);
  const setting = genre === null ? null : matchGenre(registry, { id: genre, version: null });
  const report: CapabilityReport =
    rules?.ok === true ? rules.capabilities : { advertised: [], supported: [], unsupported: [...MECHANICAL_FIELDS] };
  const questions = [...(plan?.questions ?? []), ...(plan?.deferred ?? [])];
  const issues: ConfigIssue[] = [
    ...(rules?.ok === false ? [{ code: rules.code, path: 'ruleset' }] : []),
    ...(setting?.ok === false ? [{ code: setting.code, path: 'genre' }] : []),
    ...(rules?.ok === false ? [] : conflictIssues(effective, report)),
    ...questions.map((question) => ({ code: 'clarification_pending' as const, path: question.fields[0] ?? '' })),
  ];
  if (issues.length > 0) return fail(issues);

  const values = valuesOf(effective);
  return parseCampaignConfig({
    configVersion: CONFIG_VERSION,
    values,
    provenance: provenanceOf(effective),
    rulepack: rules?.ok
      ? { id: rules.rulepack.id, edition: rules.rulepack.edition, revision: rules.rulepack.revision }
      : null,
    genre: setting?.ok ? { id: setting.genre.id, version: setting.genre.version } : null,
    capabilities: { ...report, modes: modesOf(values) },
    dropped,
  });
};
