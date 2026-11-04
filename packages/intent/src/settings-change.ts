import { isDeepStrictEqual } from 'node:util';
import {
  type CampaignConfig,
  type ConfigIssue,
  type ConfigIssueCode,
  type DroppedDefault,
  parseCampaignConfig,
} from './config.ts';
import { MECHANICAL_FIELDS } from './conflicts.ts';
import type { IntentField, IntentValues, Sourced } from './intent.ts';
import { type Evidence, isNegatedClause, type ProposalIssue, proposeCampaignIntent } from './parser.ts';

export const CAMPAIGN_CONFIG_CHANGED = 'CampaignConfigChanged';
export const SETTING_FIELDS = ['simulation', 'mood', 'combat', 'voiceInput', 'voiceOutput'] as const;

export type SettingField = (typeof SETTING_FIELDS)[number];
export type SettingChange = { field: SettingField; from: Sourced<unknown>; to: Sourced<unknown>; evidence: Evidence };
export type ConfigChangedEvent = {
  type: typeof CAMPAIGN_CONFIG_CHANGED;
  payload: { configVersion: CampaignConfig['configVersion']; changes: SettingChange[] };
};
export type SettingsChangeIssueCode =
  | ConfigIssueCode
  | ProposalIssue['code']
  | 'unrecognized'
  | 'ambiguous'
  | 'not_changeable'
  | 'unchanged';
export type SettingsChangeIssue = { code: SettingsChangeIssueCode; path: string };
export type SettingsChangeResult =
  | { ok: true; config: CampaignConfig; event: ConfigChangedEvent }
  | { ok: false; issues: SettingsChangeIssue[] };

type Request = { field: IntentField; value: unknown; evidence: Evidence; bare?: true };

const PREVIOUS_PATH = 'previous';
const TONE =
  /\b(?:make|set|change|switch)[ ](?:the[ ])?(?:tone|mood)[ ](?:to[ ]|into[ ]|more[ ])?([a-z]+(?:-[a-z]+)*)/gi;

const TONE_FILLER = ['a', 'an', 'the', 'not', 'be', 'something', 'more', 'less', 'so'];
const BARE_COMBAT = /\bcombat\b/gi;
const OFF_WORD = /\b(?:off|disable|stop|mute)\b/i;
const OFF_VERB_OBJECT = /\b(?:kill|drop|pause|less)\s+(?:the\s+)?$/i;
const ON_WORD = /\b(?:on|enable|start|unmute)\b/i;
const CLAUSE_BREAK = /[,;.!?]|\b(?:but|then)\b/i;
const JOIN = /\b(?:and|or)\b/i;
const BARE_JOIN = /^\s*(?:the\s*)?$/i;
const OFF_VALUES: Partial<Record<IntentField, unknown>> = {
  simulation: false,
  combat: 'off',
  voiceInput: false,
  voiceOutput: false,
};

const fail = (issues: SettingsChangeIssue[]): SettingsChangeResult => ({ ok: false, issues });
const isSettingField = (field: IntentField): field is SettingField =>
  (SETTING_FIELDS as readonly string[]).includes(field);

const toneRequests = (text: string): Request[] =>
  Array.from(text.matchAll(TONE))
    .filter((match) => !isNegatedClause(text, match.index))
    .map((match) => ({
      field: 'mood',
      value: match[1]?.toLowerCase(),
      evidence: { start: match.index, end: match.index + match[0].length, text: match[0] },
    }));

const overlaps = (a: Evidence, b: Evidence) => a.start < b.end && b.start < a.end;

const bareCombatRequests = (text: string, settings: Request[], conflicted: boolean): Request[] =>
  conflicted
    ? []
    : Array.from(text.matchAll(BARE_COMBAT))
        .map((match) => ({
          field: 'combat' as const,
          value: 'on',
          bare: true as const,
          evidence: { start: match.index, end: match.index + match[0].length, text: match[0] },
        }))
        .filter((request) => !settings.some((setting) => overlaps(setting.evidence, request.evidence)));

type Context = { before: string; tail: string; joined: boolean };
type Resolved = Request & { offBefore: boolean; unclear: boolean };

const splitGap = (gap: string) => {
  const clauses = gap.split(CLAUSE_BREAK);
  if (clauses.length > 1) return { tail: clauses[0] ?? '', before: clauses.at(-1) ?? '', joined: false };
  const join = JOIN.exec(gap);
  if (!join) return { tail: '', before: gap, joined: false };
  return { tail: gap.slice(0, join.index), before: gap.slice(join.index + join[0].length), joined: true };
};

const contextOf = (text: string, found: Request[], index: number): Context => {
  const { start, end } = found[index]?.evidence ?? { start: 0, end: 0 };
  const previous = found[index - 1];
  const next = found[index + 1];
  const lead = previous
    ? splitGap(text.slice(previous.evidence.end, start))
    : { before: text.slice(0, start).split(CLAUSE_BREAK).at(-1) ?? '', joined: false };
  const tail = next
    ? splitGap(text.slice(end, next.evidence.start)).tail
    : (text.slice(end).split(CLAUSE_BREAK)[0] ?? '');
  return { before: lead.before, tail, joined: lead.joined };
};

const resolveOffWords = (text: string, found: Request[]): Resolved[] => {
  const resolved: Resolved[] = [];
  found.forEach((request, index) => {
    if (!Object.hasOwn(OFF_VALUES, request.field)) {
      resolved.push({ ...request, offBefore: false, unclear: false });
      return;
    }
    const { before, tail, joined } = contextOf(text, found, index);
    const offBefore =
      OFF_WORD.test(before) ||
      OFF_VERB_OBJECT.test(before) ||
      (joined && BARE_JOIN.test(before) && resolved.at(-1)?.offBefore === true);
    const off = offBefore || OFF_WORD.test(tail);
    const unclear = request.bare
      ? isNegatedClause(text, request.evidence.start) || (off ? ON_WORD.test(before) : !ON_WORD.test(before + tail))
      : off && (ON_WORD.test(before) || isNegatedClause(text, request.evidence.start));
    resolved.push({ ...request, value: off ? OFF_VALUES[request.field] : request.value, offBefore, unclear });
  });
  return resolved;
};

const isUnclear = (request: Resolved) =>
  request.unclear || (request.field === 'mood' && TONE_FILLER.includes(request.value as string));

const prefixed = (issues: ConfigIssue[], prefix: string): SettingsChangeIssue[] =>
  issues.map(({ code, path }) => ({ code, path: `${prefix}.${path}` }));

const nextConfig = (previous: CampaignConfig, changes: SettingChange[]) => {
  const values = { ...previous.values };
  const provenance = { ...previous.provenance };
  for (const { field, to } of changes) {
    (values as Record<IntentField, unknown>)[field] = to.value;
    provenance[field] = to.provenance;
  }
  const changed = new Set<IntentField>(changes.map((change) => change.field));
  const dropped = previous.dropped.map(
    (entry): DroppedDefault => (changed.has(entry.field) ? { ...entry, reason: 'explicit_wins' } : entry),
  );
  const modes = Object.fromEntries(MECHANICAL_FIELDS.map((field) => [field, (values as IntentValues)[field]]));
  return { ...previous, values, provenance, capabilities: { ...previous.capabilities, modes }, dropped };
};

export const changeSettings = (previous: unknown, text: unknown): SettingsChangeResult => {
  const prior = parseCampaignConfig(previous);
  if (!prior.ok) return fail(prefixed(prior.issues, PREVIOUS_PATH));
  const proposed = proposeCampaignIntent(text);
  if (!proposed.ok) return fail(proposed.issues);
  const { settings, conflicts } = proposed.proposal;
  const said = text as string;
  const found = resolveOffWords(
    said,
    [
      ...settings,
      ...bareCombatRequests(
        said,
        settings,
        conflicts.some(({ field }) => field === 'combat'),
      ),
      ...toneRequests(said),
    ].sort((a, b) => a.evidence.start - b.evidence.start),
  );
  if (found.length === 0 && conflicts.length === 0) return fail([{ code: 'unrecognized', path: '' }]);
  const requests = found.filter((request) => found.find((other) => other.field === request.field) === request);
  const contested = requests.filter(
    (request) =>
      isUnclear(request) ||
      found.some((other) => other.field === request.field && !isDeepStrictEqual(other.value, request.value)),
  );
  const issues: SettingsChangeIssue[] = [
    ...[...conflicts, ...contested].map(({ field }) => ({ code: 'ambiguous' as const, path: field })),
    ...requests
      .filter(({ field }) => !isSettingField(field))
      .map(({ field }) => ({ code: 'not_changeable' as const, path: field })),
  ];
  if (issues.length > 0) return fail(issues);

  const config = prior.config;
  const changes = requests
    .map(({ field, value, evidence }) => ({
      field: field as SettingField,
      from: { value: config.values[field], provenance: config.provenance[field] },
      to: { value, provenance: 'explicit' as const },
      evidence,
    }))
    .filter((change) => !isDeepStrictEqual(change.from, change.to));
  if (changes.length === 0) return fail([{ code: 'unchanged', path: '' }]);

  const next = parseCampaignConfig(nextConfig(config, changes));
  if (!next.ok) return fail(next.issues);
  return {
    ok: true,
    config: next.config,
    event: { type: CAMPAIGN_CONFIG_CHANGED, payload: { configVersion: next.config.configVersion, changes } },
  };
};
