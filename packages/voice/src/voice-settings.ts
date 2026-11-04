import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from './playback.ts';
import type { LocaleHint } from './transcript.ts';
import type { VoiceSettings } from './voice.ts';

export const VOICE_SETTINGS_CHANGED = 'VoiceSettingsChanged';

export type VoicePreferences = Pick<VoiceSettings, 'microphone' | 'spokenOutput'> & {
  readonly locale: LocaleHint;
  readonly speed: number;
};

export interface VoiceSession {
  readonly campaignId: string;
  readonly turn: number;
  readonly pendingInput: readonly string[];
  readonly preferences: VoicePreferences;
}

export type RequestSource = 'typed' | 'spoken';

export interface VoiceSettingsRequest {
  readonly source: RequestSource;
  readonly text: string;
}

export type VoiceSettingField = keyof VoicePreferences;

export interface VoiceSettingChange {
  readonly field: VoiceSettingField;
  readonly from: VoicePreferences[VoiceSettingField];
  readonly to: VoicePreferences[VoiceSettingField];
}

export interface VoiceSettingsChangedEvent {
  readonly type: typeof VOICE_SETTINGS_CHANGED;
  readonly payload: {
    readonly campaignId: string;
    readonly turn: number;
    readonly source: RequestSource;
    readonly changes: readonly VoiceSettingChange[];
  };
}

export type VoiceSettingsIssueCode =
  | 'unrecognized'
  | 'ambiguous'
  | 'negated'
  | 'unsupported_locale'
  | 'speed_out_of_range'
  | 'unchanged';

export interface VoiceSettingsIssue {
  readonly code: VoiceSettingsIssueCode;
  readonly path: VoiceSettingField | '';
}

export type VoiceSettingsResult =
  | { readonly ok: true; readonly session: VoiceSession; readonly event: VoiceSettingsChangedEvent }
  | { readonly ok: false; readonly issues: readonly VoiceSettingsIssue[] };

const NEGATOR = String.raw`don['’]?t|do\s+not|never|not|no`;
const VERB = 'set|switch|change|turn|use';
const COMMAND = new RegExp(String.raw`^\s*(?:settings:|(?:please\s+)?(?:(${NEGATOR})\s+)?(?:${VERB})\b)`, 'i');
const CLAUSE = new RegExp(String.raw`^(?:(${NEGATOR})\s+)?(?:(?:${VERB})\s+)?(?:to\s+)?(?:the\s+)?(.+)$`, 'i');
const SENTENCE_END = /[.!?]+(?:\s|$)/;
const CLAUSE_BREAK = /\s*(?:[,;](?!\d)|\band\b)\s*/i;
const SETTING_PHRASES: readonly (readonly [VoiceSettingField, RegExp])[] = [
  [
    'microphone',
    /^(?:(?:mic|microphone)\s+(?:to\s+)?(off|push[ -]to[ -]talk|hands[ -]free)|(push[ -]to[ -]talk|hands[ -]free)|(off)\s+(?:the\s+)?(?:mic|microphone))$/i,
  ],
  [
    'spokenOutput',
    /^(?:(?:output|speech)\s+(?:to\s+)?(off|narrator|dialogue|full)|(full)\s+voice|(off)\s+(?:the\s+)?(?:output|speech))$/i,
  ],
  ['locale', /^(?:locale|language)\s+(?:to\s+)?(\S+)$/i],
  ['speed', /^speed\s+(?:to\s+)?(\d*[.,]?\d+)x?$/i],
];
const WORD_GAP = /[ -]/g;
const HYPHEN = '-';
const DECIMAL_COMMA = ',';
const DECIMAL_POINT = '.';

interface Mention {
  readonly value: string;
  readonly negated: boolean;
}

type Mentions = Map<VoiceSettingField, Mention[]>;

const fail = (issues: VoiceSettingsIssue[]): VoiceSettingsResult => ({ ok: false, issues });

const keyword = (value: string): string => value.toLowerCase().replace(WORD_GAP, HYPHEN);

const normalizers: Record<VoiceSettingField, (value: string) => string> = {
  microphone: keyword,
  spokenOutput: keyword,
  locale: String,
  speed: (value) => value.replace(DECIMAL_COMMA, DECIMAL_POINT),
};

const canonicalLocale = (value: string): string | undefined => {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
};

const readClause = (clause: string, inheritedNegation: boolean): [VoiceSettingField, Mention] | undefined => {
  const [, negator, phrase = ''] = CLAUSE.exec(clause) ?? [];
  for (const [field, pattern] of SETTING_PHRASES) {
    const match = pattern.exec(phrase);
    if (!match) continue;
    const value = normalizers[field](match.slice(1).find(Boolean) ?? '');
    return [field, { value, negated: inheritedNegation || negator !== undefined }];
  }
  return undefined;
};

const requested = (text: string): Mentions | undefined => {
  const [sentence = ''] = text.split(SENTENCE_END);
  const command = COMMAND.exec(sentence);
  if (!command) return undefined;
  const clauses = sentence
    .slice(command[0].length)
    .split(CLAUSE_BREAK)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  const found: Mentions = new Map(SETTING_PHRASES.map(([field]) => [field, []]));
  for (const [index, clause] of clauses.entries()) {
    const read = readClause(clause, index === 0 && command[1] !== undefined);
    if (!read) return undefined;
    found.get(read[0])?.push(read[1]);
  }
  return found;
};

type Value = VoicePreferences[VoiceSettingField];
type Parsed = { ok: true; value: Value } | { ok: false; issue: VoiceSettingsIssue };

const parseValue = (field: VoiceSettingField, raw: string, supportedLocales: readonly string[]): Parsed => {
  if (field === 'speed') {
    const speed = Number(raw);
    return speed >= MIN_PLAYBACK_SPEED && speed <= MAX_PLAYBACK_SPEED
      ? { ok: true, value: speed }
      : { ok: false, issue: { code: 'speed_out_of_range', path: field } };
  }
  if (field === 'locale') {
    const locale = canonicalLocale(raw);
    const supported = locale !== undefined && supportedLocales.some((entry) => canonicalLocale(entry) === locale);
    return supported && locale
      ? { ok: true, value: locale }
      : { ok: false, issue: { code: 'unsupported_locale', path: field } };
  }
  return { ok: true, value: raw };
};

const resolveField = (
  field: VoiceSettingField,
  found: readonly Mention[],
  supportedLocales: readonly string[],
): Parsed => {
  if (found.some(({ negated }) => negated)) return { ok: false, issue: { code: 'negated', path: field } };
  const parsed = found.map(({ value }) => parseValue(field, value, supportedLocales));
  const failed = parsed.find((result) => !result.ok);
  if (failed) return failed;
  const values = new Set(parsed.map((result) => (result.ok ? result.value : undefined)));
  if (values.size > 1) return { ok: false, issue: { code: 'ambiguous', path: field } };
  return parsed[0] ?? { ok: false, issue: { code: 'unrecognized', path: '' } };
};

export const changeVoiceSettings = (
  session: VoiceSession,
  request: VoiceSettingsRequest,
  supportedLocales: readonly string[],
): VoiceSettingsResult => {
  const mentioned = typeof request.text === 'string' ? requested(request.text) : undefined;
  const found = [...(mentioned ?? [])].filter(([, values]) => values.length > 0);
  if (found.length === 0) return fail([{ code: 'unrecognized', path: '' }]);

  const issues: VoiceSettingsIssue[] = [];
  const changes: VoiceSettingChange[] = [];
  for (const [field, values] of found) {
    const resolved = resolveField(field, values, supportedLocales);
    if (!resolved.ok) {
      issues.push(resolved.issue);
      continue;
    }
    const from = session.preferences[field];
    if (from !== resolved.value) changes.push({ field, from, to: resolved.value });
  }
  if (issues.length > 0) return fail(issues);
  if (changes.length === 0) return fail([{ code: 'unchanged', path: '' }]);

  const preferences = Object.fromEntries(changes.map(({ field, to }) => [field, to]));
  return {
    ok: true,
    session: { ...session, preferences: { ...session.preferences, ...preferences } },
    event: {
      type: VOICE_SETTINGS_CHANGED,
      payload: { campaignId: session.campaignId, turn: session.turn, source: request.source, changes },
    },
  };
};

export type VoiceInputRoute<T> =
  | {
      readonly kind: 'settings';
      readonly session: VoiceSession;
      readonly event: VoiceSettingsChangedEvent;
      readonly action?: T;
    }
  | { readonly kind: 'settings-rejected'; readonly issues: readonly VoiceSettingsIssue[]; readonly action?: T }
  | { readonly kind: 'action'; readonly result: T };

const UNRECOGNIZED: VoiceSettingsIssueCode = 'unrecognized';

const remainderOf = (text: string): string => {
  const end = SENTENCE_END.exec(text);
  return end === null ? '' : text.slice(end.index + end[0].length).trim();
};

export const routeVoiceInput = <T>(
  session: VoiceSession,
  request: VoiceSettingsRequest,
  supportedLocales: readonly string[],
  submitAction: (text: string) => T,
): VoiceInputRoute<T> => {
  const result = changeVoiceSettings(session, request, supportedLocales);
  if (!result.ok && result.issues.some(({ code }) => code === UNRECOGNIZED)) {
    return { kind: 'action', result: submitAction(request.text) };
  }
  const rest = remainderOf(request.text);
  const action = rest === '' ? {} : { action: submitAction(rest) };
  if (result.ok) return { kind: 'settings', session: result.session, event: result.event, ...action };
  return { kind: 'settings-rejected', issues: result.issues, ...action };
};
