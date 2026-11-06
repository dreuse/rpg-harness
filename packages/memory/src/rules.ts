import { encoded, sliced } from './packet.ts';
import { estimateTokens } from './retrieval.ts';

export type RuleSection = { readonly title: string; readonly text: string };
export type CondensedRules = { readonly summary: string; readonly sections: readonly RuleSection[] };

const HEADING = /^#{1,6}\s+(.+)$/;
const PARAGRAPH_BREAK = /\n\s*\n/;
const WORD = /[\p{L}\p{N}]{4,}/gu;
const SHORT_CAPS = /(?<![\p{L}\p{N}])(?=[\p{N}]*\p{Lu})[\p{Lu}\p{N}]{2,3}(?![\p{L}\p{N}])/gu;
const TITLE_CHARS = 60;
const LEAD_CHARS = 240;
const SECTION_MAX_CHARS = 1_000;
const ITEM_SEPARATOR_TOKENS = 1;
const INTRO_TITLE = 'Introduction';
const SECTIONS_LABEL = 'Sections: ';
const TITLE_SEPARATOR = '; ';
const LINE_BREAK = '\n';
const ELLIPSIS = '...';
const INPUT_WEIGHT = 2;
const RECENT_WEIGHT = 1;
const TITLE_WEIGHT = 2;
const NO_SCORE = 0;
const FIRST = 0;

const clipped = (text: string, limit: number) =>
  text.length > limit ? `${sliced(text, limit).trimEnd()}${ELLIPSIS}` : text;

const wordsOf = (text: string) =>
  new Set([...(text.match(SHORT_CAPS) ?? []), ...(text.match(WORD) ?? [])].map((word) => word.toLowerCase()));

const byHeading = (text: string): RuleSection[] => {
  const intro = { title: INTRO_TITLE, lines: [] as string[] };
  const sections = [intro];
  for (const line of text.split(LINE_BREAK)) {
    const heading = HEADING.exec(line.trim());
    if (heading !== null) sections.push({ title: (heading[1] ?? '').trim(), lines: [line] });
    else sections.at(-1)?.lines.push(line);
  }
  const [, ...headings] = sections;
  if (headings.length === FIRST) return [];
  return sections
    .filter((section) => section !== intro || intro.lines.join('').trim() !== '')
    .map(({ title, lines }) => ({ title, text: lines.join(LINE_BREAK).trim() }));
};

const byParagraph = (text: string): RuleSection[] =>
  text
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => ({ title: clipped(paragraph.split(LINE_BREAK)[FIRST] ?? '', TITLE_CHARS), text: paragraph }));

export const condense = (text: string): CondensedRules => {
  const headed = byHeading(text);
  const sections = (headed.length > FIRST ? headed : byParagraph(text)).map((section) => ({
    title: section.title,
    text: clipped(section.text, SECTION_MAX_CHARS),
  }));
  const lead = clipped(text.trim().split(PARAGRAPH_BREAK)[FIRST] ?? '', LEAD_CHARS);
  const titles = sections.map(({ title }) => clipped(title, TITLE_CHARS)).join(TITLE_SEPARATOR);
  const summary = sections.length === FIRST ? '' : `${lead}${LINE_BREAK}${SECTIONS_LABEL}${titles}`.trim();
  return { summary, sections };
};

const costOf = (text: string) => estimateTokens(encoded(text)) + ITEM_SEPARATOR_TOKENS;

const scoreOf = (section: RuleSection, input: ReadonlySet<string>, recent: ReadonlySet<string>) => {
  let score = NO_SCORE;
  const body = wordsOf(section.text);
  const title = wordsOf(section.title);
  for (const [query, weight] of [
    [input, INPUT_WEIGHT],
    [recent, RECENT_WEIGHT],
  ] as const) {
    for (const word of query) score += weight * (Number(body.has(word)) + TITLE_WEIGHT * Number(title.has(word)));
  }
  return score;
};

export const selectSections = (
  sections: readonly RuleSection[],
  playerInput: string,
  recentTurns: readonly string[],
  budget: number,
): RuleSection[] => {
  const input = wordsOf(playerInput);
  const recent = wordsOf(recentTurns.join(LINE_BREAK));
  const ranked = sections
    .map((section, index) => ({ section, index, score: scoreOf(section, input, recent) }))
    .filter(({ score }) => score > NO_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof ranked = [];
  let used = NO_SCORE;
  for (const entry of ranked) {
    const cost = costOf(entry.section.text);
    if (used + cost > budget) continue;
    chosen.push(entry);
    used += cost;
  }
  return chosen.sort((a, b) => a.index - b.index).map(({ section }) => section);
};

export const rulesetItems = (
  condensed: CondensedRules,
  playerInput: string,
  recentTurns: readonly string[],
  cap: number,
): string[] => {
  const room = cap - costOf(condensed.summary);
  return [
    condensed.summary,
    ...selectSections(condensed.sections, playerInput, recentTurns, room).map(({ text }) => text),
  ];
};
