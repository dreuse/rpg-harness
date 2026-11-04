import { isDeepStrictEqual } from 'node:util';
import { SIMULATION_MODES, type SimulationMode } from '../../domain/src/simulation.ts';
import type { CampaignIntentInput, IntentField, IntentValues } from './intent.ts';

export const MAX_INTENT_TEXT_LENGTH = 2000;

export const CONFIDENCE = { strong: 0.9, moderate: 0.7 } as const;

export type Evidence = { start: number; end: number; text: string };
export type ProposedSetting = {
  [K in IntentField]: { field: K; value: IntentValues[K]; confidence: number; evidence: Evidence };
}[IntentField];
export type IntentConflict = { field: IntentField; candidates: ProposedSetting[] };
export type IntentProposal = {
  settings: ProposedSetting[];
  conflicts: IntentConflict[];
  remainder: string;
  input: CampaignIntentInput;
};
export type ProposalIssue = { code: 'invalid_type' | 'too_long'; path: string };
export type ProposalResult = { ok: true; proposal: IntentProposal } | { ok: false; issues: ProposalIssue[] };

type Cue = {
  [K in IntentField]: {
    field: K;
    pattern: RegExp;
    confidence: number;
    read: (match: RegExpExecArray) => IntentValues[K];
    off?: IntentValues[K];
  };
}[IntentField];

const NAME_WORD = String.raw`[A-Z][\w&'+-]*:?`;
const LEADING_VERBS = ['Play', 'Use', 'Run', 'Start', 'Try', 'Begin'];
const NAME = String.raw`(?<![\w&'+-])(?!(?:${LEADING_VERBS.join('|')})[ ])${NAME_WORD}(?:[ ](?:(?:of|the|and)[ ])?${NAME_WORD}){0,3}`;
const PACE = String.raw`[ -]pac(?:e|ed|ing)\b`;
const EDITION = String.raw`\d+(?:st|nd|rd|th)[ ][Ee]dition|\d+e`;
const VERSION = String.raw`\d+(?:\.\d+)+|\d+(?:st|nd|rd|th)?[ ]?(?:e|ed|[Ee]dition)\b`;
const STORY_NOUNS = 'story|adventure|campaign|game|tale|mystery|saga|one-shot';
const NEGATION_TOKEN = /\b(?:no|not|never|nothing|without)\b|n['’]t\b/i;
const CLAUSE_END = /[,;.]|\bbut\b/i;
const GAPS = /[\s,;:]+/g;
const MODE = `(${SIMULATION_MODES.join('|')})`;
const SIMULATION_MODE = new RegExp(
  String.raw`\b(?:world[ ])?simulation[ ](?:mode[ ])?to[ ]${MODE}\b|\b${MODE}[ ](?:world[ ])?simulation\b`,
  'gi',
);

const fixed = <K extends IntentField>(field: K, value: IntentValues[K], pattern: RegExp, off?: IntentValues[K]): Cue =>
  ({ field, pattern, confidence: CONFIDENCE.strong, read: () => value, off }) as Cue;

const INTENT_CUES: Cue[] = [
  fixed('simulation', 'dynamic', /\bdynamic[ ]world\b/gi, 'off'),
  fixed('simulation', 'balanced', /\b(?:living|persistent|reactive|simulated)[ ]world\b/gi, 'off'),
  fixed('simulation', 'off', /\b(?:static[ ]world|no[ ](?:world[ ])?simulation)\b/gi),
  {
    field: 'simulation',
    pattern: SIMULATION_MODE,
    confidence: CONFIDENCE.strong,
    read: (match) => (match[1] ?? match[2] ?? '').toLowerCase() as SimulationMode,
    off: 'off',
  },
  fixed('pacing', 'slow', new RegExp(String.raw`\b(?:relaxed|slow|leisurely|unhurried|gentle)${PACE}`, 'gi')),
  fixed('pacing', 'balanced', new RegExp(String.raw`\b(?:balanced|moderate|steady)${PACE}`, 'gi')),
  fixed('pacing', 'fast', new RegExp(String.raw`\b(?:fast|quick|brisk|rapid|breakneck)${PACE}`, 'gi')),
  fixed('combat', 'off', /\b(?:(?:no|without)[ ]combat|combat[ -]free)\b/gi),
  fixed('combat', 'on', /\b(?:with|lots[ ]of|plenty[ ]of|tactical)[ ]combat\b/gi),
  fixed('dice', 'off', /\b(?:(?:no|without)[ ]dice|diceless)\b/gi),
  fixed('dice', 'on', /\bwith[ ]dice\b/gi),
  fixed('attributes', 'off', /\b(?:no|without)[ ](?:stats|attributes|character[ ]sheets?)\b/gi),
  fixed('voiceOutput', true, /\b(?:voice|spoken|voiced)[ ]narration\b|\btext[ -]to[ -]speech\b/gi, false),
  fixed('voiceInput', true, /\bvoice[ ](?:input|commands?|control)\b/gi, false),
  fixed('ambience', true, /\b(?:ambient|background)[ ](?:music|sound|audio)\b|\bambience\b/gi, false),
  fixed('timeline', 'branching', /\bbranching[ ](?:timelines?|story|stories|narrative)\b/gi, 'linear'),
  {
    field: 'genre',
    pattern: new RegExp(String.raw`\ban?[ ]((?:[a-z]+[ -]){0,3}?[a-z]+)[ ](?:${STORY_NOUNS})\b`, 'gi'),
    confidence: CONFIDENCE.moderate,
    read: (match) => match[1] ?? null,
  },
  {
    field: 'genre',
    pattern: /\bblank[ -]world\b/gi,
    confidence: CONFIDENCE.moderate,
    read: (match) => match[0],
  },
  {
    field: 'ruleset',
    pattern: new RegExp(String.raw`\b(${EDITION})[ ](?:of[ ])?(${NAME})`, 'g'),
    confidence: CONFIDENCE.strong,
    read: (match) => ({ id: match[2] ?? '', edition: match[1] ?? null }),
  },
  {
    field: 'ruleset',
    pattern: new RegExp(`(${NAME})[ ](${VERSION})`, 'g'),
    confidence: CONFIDENCE.strong,
    read: (match) => ({ id: match[1] ?? '', edition: match[2] ?? null }),
  },
  {
    field: 'ruleset',
    pattern: new RegExp(
      String.raw`\b(?:using|in|with|on)[ ](?:the[ ])?(${NAME})[ ](?:rules|system|ruleset|rpg)\b`,
      'g',
    ),
    confidence: CONFIDENCE.moderate,
    read: (match) => ({ id: match[1] ?? '', edition: null }),
  },
];

export const isNegatedClause = (text: string, start: number) =>
  NEGATION_TOKEN.test(text.slice(0, start).split(CLAUSE_END).at(-1) ?? '');

const matchesOf = (text: string): ProposedSetting[] =>
  INTENT_CUES.flatMap((cue) =>
    Array.from(text.matchAll(cue.pattern)).flatMap((match) => {
      const start = match.index;
      const negated = isNegatedClause(text, start);
      if (negated && cue.off === undefined) return [];
      const value = negated ? cue.off : cue.read(match);
      const evidence = { start, end: start + match[0].length, text: match[0] };
      return [{ field: cue.field, value, confidence: cue.confidence, evidence } as ProposedSetting];
    }),
  );

const overlaps = (a: Evidence, b: Evidence) => a.start < b.end && b.start < a.end;
const spanLength = (setting: ProposedSetting) => setting.evidence.end - setting.evidence.start;

const byPriority = (a: ProposedSetting, b: ProposedSetting) =>
  b.confidence - a.confidence || spanLength(b) - spanLength(a) || a.evidence.start - b.evidence.start;

const resolveOverlaps = (matches: ProposedSetting[]): ProposedSetting[] => {
  const kept: ProposedSetting[] = [];
  for (const match of matches.toSorted(byPriority))
    if (!kept.some((other) => overlaps(other.evidence, match.evidence))) kept.push(match);
  return kept.sort((a, b) => a.evidence.start - b.evidence.start);
};

const remainderOf = (text: string, kept: ProposedSetting[]) =>
  kept
    .reduceRight((rest, { evidence }) => `${rest.slice(0, evidence.start)} ${rest.slice(evidence.end)}`, text)
    .replace(GAPS, ' ')
    .trim();

const propose = (text: string): IntentProposal => {
  const kept = resolveOverlaps(matchesOf(text));
  const settings: ProposedSetting[] = [];
  const conflicts: IntentConflict[] = [];
  for (const field of new Set(kept.map((setting) => setting.field))) {
    const candidates = kept.filter((setting) => setting.field === field);
    const [first] = candidates;
    if (!first) continue;
    if (candidates.every((candidate) => isDeepStrictEqual(candidate.value, first.value))) settings.push(first);
    else conflicts.push({ field, candidates });
  }
  const input = Object.fromEntries(
    settings.map((setting) => [setting.field, { value: setting.value, provenance: 'derived' }]),
  ) as CampaignIntentInput;
  return { settings, conflicts, remainder: remainderOf(text, kept), input };
};

export const proposeCampaignIntent = (text: unknown): ProposalResult => {
  if (typeof text !== 'string') return { ok: false, issues: [{ code: 'invalid_type', path: '' }] };
  if (text.length > MAX_INTENT_TEXT_LENGTH) return { ok: false, issues: [{ code: 'too_long', path: '' }] };
  return { ok: true, proposal: propose(text) };
};
