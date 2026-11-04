import type { VoiceProfile } from './voice.ts';

export const EMPHASIS_LEVELS = ['reduced', 'moderate', 'strong'] as const;
export type EmphasisLevel = (typeof EMPHASIS_LEVELS)[number];

export interface Pronunciation {
  readonly text: string;
  readonly phonetic: string;
}

export interface ProsodyHint {
  readonly style?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly emphasis?: EmphasisLevel;
  readonly pronunciations?: readonly Pronunciation[];
}

export interface ProviderProsodyCapabilities {
  readonly styles: readonly string[];
  readonly rate: boolean;
  readonly pitch: boolean;
  readonly emphasis: boolean;
  readonly pronunciation: boolean;
}

export type ProsodyField = keyof ProsodyHint;
export type DropReason = 'unsupported' | 'invalid' | 'duplicate' | 'over-limit';

export interface DroppedHint {
  readonly field: ProsodyField;
  readonly reason: DropReason;
}

declare const APPLIED: unique symbol;

export interface AppliedProsody {
  readonly [APPLIED]: true;
  readonly hint: ProsodyHint;
  readonly dropped: readonly DroppedHint[];
}

export interface RenderedProsody {
  readonly ssml: string;
  readonly style?: string;
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const MIN_PITCH_SEMITONES = -12;
export const MAX_PITCH_SEMITONES = 12;
export const MAX_PRONUNCIATIONS = 32;
export const MAX_PRONUNCIATION_LENGTH = 64;

const STYLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PRONUNCIATION_TEXT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '-]*$/u;
const PHONETIC_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .'-]*$/u;
const WORD_EDGE_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_EDGE_AFTER = '(?![\\p{L}\\p{N}])';
const PERCENT = 100;
const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const XML_SPECIAL = /[&<>"']/g;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;
const NOT_APPLIED = 'toSsml requires the result of applyProsody';
const appliedResults = new WeakSet<object>();

const inRange = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

const isEntryValid = (entry: Pronunciation): boolean =>
  typeof entry === 'object' && entry !== null && isEntryFilled(entry);

const isEntryFilled = ({ text, phonetic }: Pronunciation): boolean =>
  typeof text === 'string' &&
  typeof phonetic === 'string' &&
  text.length <= MAX_PRONUNCIATION_LENGTH &&
  phonetic.length <= MAX_PRONUNCIATION_LENGTH &&
  PRONUNCIATION_TEXT_PATTERN.test(text) &&
  PHONETIC_PATTERN.test(phonetic);

const styleVerdict = (style: string, capabilities: ProviderProsodyCapabilities): DropReason | undefined => {
  if (typeof style !== 'string' || !STYLE_PATTERN.test(style)) return 'invalid';
  return capabilities.styles.includes(style) ? undefined : 'unsupported';
};

const checkPronunciations = (
  pronunciations: ProsodyHint['pronunciations'],
  supported: boolean,
  kept: { pronunciations?: readonly Pronunciation[] },
  dropped: DroppedHint[],
): void => {
  const drop = (reason: DropReason) => dropped.push({ field: 'pronunciations', reason });
  if (pronunciations === undefined || (Array.isArray(pronunciations) && pronunciations.length === 0)) return;
  if (!supported) return void drop('unsupported');
  if (!Array.isArray(pronunciations)) return void drop('invalid');
  const entries = new Map<string, Pronunciation>();
  for (const entry of pronunciations) {
    if (entries.size === MAX_PRONUNCIATIONS) {
      drop('over-limit');
      break;
    }
    if (!isEntryValid(entry)) drop('invalid');
    else if (entries.has(entry.text)) drop('duplicate');
    else entries.set(entry.text, Object.freeze({ text: entry.text, phonetic: entry.phonetic }));
  }
  if (entries.size > 0) kept.pronunciations = Object.freeze([...entries.values()]);
};

export const applyProsody = (hint: ProsodyHint, capabilities: ProviderProsodyCapabilities): AppliedProsody => {
  const kept: { -readonly [K in ProsodyField]?: ProsodyHint[K] } = {};
  const dropped: DroppedHint[] = [];
  const check = <K extends ProsodyField>(
    field: K,
    verdict: (value: NonNullable<ProsodyHint[K]>) => DropReason | undefined,
  ): void => {
    const value = hint[field];
    if (value === undefined) return;
    const reason = verdict(value);
    if (reason) dropped.push({ field, reason });
    else kept[field] = value;
  };
  const gate = (supported: boolean, valid: boolean): DropReason | undefined =>
    !supported ? 'unsupported' : valid ? undefined : 'invalid';
  check('style', (style) => styleVerdict(style, capabilities));
  check('rate', (rate) => gate(capabilities.rate, inRange(rate, MIN_RATE, MAX_RATE)));
  check('pitch', (pitch) => gate(capabilities.pitch, inRange(pitch, MIN_PITCH_SEMITONES, MAX_PITCH_SEMITONES)));
  check('emphasis', (emphasis) => gate(capabilities.emphasis, EMPHASIS_LEVELS.includes(emphasis)));
  checkPronunciations(hint.pronunciations, capabilities.pronunciation, kept, dropped);
  const applied = Object.freeze({
    hint: Object.freeze(kept),
    dropped: Object.freeze(dropped.map((drop) => Object.freeze(drop))),
  }) as AppliedProsody;
  appliedResults.add(applied);
  return applied;
};

const escapeXml = (value: string): string => value.replace(XML_SPECIAL, (character) => XML_ESCAPES[character] ?? '');

const signed = (value: number): string => (value < 0 ? `${value}` : `+${value}`);

const substitute = (text: string, pronunciations: readonly Pronunciation[]): string => {
  if (pronunciations.length === 0) return escapeXml(text);
  const phoneticOf = new Map(pronunciations.map(({ text: written, phonetic }) => [written, phonetic]));
  const alternatives = [...phoneticOf.keys()]
    .sort((left, right) => right.length - left.length)
    .map((written) => written.replace(REGEX_SPECIAL, '\\$&'));
  const matcher = new RegExp(`${WORD_EDGE_BEFORE}(${alternatives.join('|')})${WORD_EDGE_AFTER}`, 'u');
  return text
    .split(matcher)
    .map((part, index) => {
      const phonetic = index % 2 === 1 ? phoneticOf.get(part) : undefined;
      return phonetic === undefined ? escapeXml(part) : `<sub alias="${escapeXml(phonetic)}">${escapeXml(part)}</sub>`;
    })
    .join('');
};

export const toSsml = (text: string, applied: AppliedProsody): RenderedProsody => {
  if (!appliedResults.has(applied)) throw new TypeError(NOT_APPLIED);
  const { hint } = applied;
  let body = substitute(text, hint.pronunciations ?? []);
  if (hint.emphasis !== undefined) body = `<emphasis level="${escapeXml(hint.emphasis)}">${body}</emphasis>`;
  const attributes = [
    Number.isFinite(hint.rate) ? ` rate="${Math.round((hint.rate ?? 0) * PERCENT)}%"` : '',
    Number.isFinite(hint.pitch) ? ` pitch="${signed(Math.round(hint.pitch ?? 0))}st"` : '',
  ].join('');
  if (attributes !== '') body = `<prosody${attributes}>${body}</prosody>`;
  const ssml = `<speak>${body}</speak>`;
  return hint.style === undefined ? { ssml } : { ssml, style: hint.style };
};

export const profileHint = (profile: VoiceProfile): ProsodyHint => {
  const pronunciations = Object.entries(profile.pronunciations).map(([text, phonetic]) => ({ text, phonetic }));
  return {
    ...(profile.style === '' ? {} : { style: profile.style }),
    rate: profile.pace,
    ...(pronunciations.length === 0 ? {} : { pronunciations }),
  };
};
