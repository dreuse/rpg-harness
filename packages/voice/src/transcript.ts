import type { TranscriptSegment } from './voice.ts';

export type LocaleHint = string;

export interface ProtectedTerm {
  readonly text: string;
  readonly kind: 'name' | 'rule-term';
}

export interface Substitution {
  readonly segmentId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: ProtectedTerm['kind'];
}

export interface NormalizedTranscript {
  readonly segments: readonly TranscriptSegment[];
  readonly substitutions: readonly Substitution[];
}

const UNICODE_FORM = 'NFC';
const DECOMPOSED_FORM = 'NFD';
const COMBINING_MARKS = /\p{M}/gu;
const WHITESPACE_RUN = /\s+/g;
const SINGLE_SPACE = ' ';
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const WORD_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_AFTER = '(?![\\p{L}\\p{N}])';
const MATCH_FLAGS = 'gu';
const LOCALE_SEPARATOR = '-';

const canonicalLocale = (hint: LocaleHint | undefined): string | undefined => {
  if (!hint) return undefined;
  try {
    return Intl.getCanonicalLocales(hint)[0];
  } catch {
    return undefined;
  }
};

export const resolveLocale = (
  hint: LocaleHint | undefined,
  segment: TranscriptSegment | undefined,
): string | undefined => segment?.locale || canonicalLocale(hint);

const primaryLanguage = (locale: string): string => {
  const [language = locale] = (canonicalLocale(locale) ?? locale).split(LOCALE_SEPARATOR);
  return language.toLowerCase();
};

export const detectLanguageSwitch = (previous: string | undefined, next: string | undefined): boolean =>
  previous !== undefined && next !== undefined && primaryLanguage(previous) !== primaryLanguage(next);

const clean = (text: string): string => text.normalize(UNICODE_FORM).replace(WHITESPACE_RUN, SINGLE_SPACE).trim();

const foldChar = (char: string): string => char.normalize(DECOMPOSED_FORM).replace(COMBINING_MARKS, '').toLowerCase();

export const fold = (text: string): string => Array.from(text, foldChar).join('');

const foldWithOffsets = (text: string): { readonly folded: string; readonly offsets: readonly number[] } => {
  let folded = '';
  const offsets: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = foldChar(char);
    folded += part;
    for (let unit = 0; unit < part.length; unit += 1) offsets.push(index);
    index += char.length;
  }
  offsets.push(index);
  return { folded, offsets };
};

const buildMatcher = (terms: readonly ProtectedTerm[]) => {
  const byFolded = new Map<string, ProtectedTerm>();
  for (const term of terms) {
    const text = clean(term.text);
    const key = fold(text);
    if (key && !byFolded.has(key)) byFolded.set(key, { ...term, text });
  }
  const keys = [...byFolded.keys()].sort((a, b) => b.length - a.length);
  const pattern = keys.length
    ? new RegExp(
        `${WORD_BEFORE}(?:${keys.map((key) => key.replace(REGEX_SPECIALS, '\\$&')).join('|')})${WORD_AFTER}`,
        MATCH_FLAGS,
      )
    : undefined;
  return { byFolded, pattern };
};

export const normalizeTranscript = (
  segments: readonly TranscriptSegment[],
  protectedTerms: readonly ProtectedTerm[],
): NormalizedTranscript => {
  const { byFolded, pattern } = buildMatcher(protectedTerms);
  const substitutions: Substitution[] = [];
  const normalized = segments.map((segment) => {
    const text = clean(segment.text);
    if (!pattern) return { ...segment, text };
    const { folded, offsets } = foldWithOffsets(text);
    let output = '';
    let cursor = 0;
    for (const match of folded.matchAll(pattern)) {
      const term = byFolded.get(match[0]) as ProtectedTerm;
      const start = offsets[match.index] ?? text.length;
      const end = offsets[match.index + match[0].length] ?? text.length;
      const from = text.slice(start, end);
      output += text.slice(cursor, start) + term.text;
      cursor = end;
      if (from !== term.text) substitutions.push({ segmentId: segment.id, from, to: term.text, kind: term.kind });
    }
    return { ...segment, text: output + text.slice(cursor) };
  });
  return { segments: normalized, substitutions };
};
