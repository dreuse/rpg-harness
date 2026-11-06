import type { RulesDocument } from '../../../packages/engine/src/own-rules.ts';
import { type CondensedRules, condense, rulesetItems } from '../../../packages/memory/src/rules.ts';

const TITLE_MARKS = /^#+\s*/;

const condensedOf = (documents: readonly RulesDocument[]): CondensedRules => {
  const condensed = documents.map(({ text }) => condense(text));
  return {
    summary: condensed.map(({ summary }) => summary).join('\n'),
    sections: condensed.flatMap(({ sections }) => sections),
  };
};

const normalizedTitle = (title: string) => title.replace(TITLE_MARKS, '').trim().toLowerCase();

export const ownRulesItems = (
  documents: readonly RulesDocument[],
  playerInput: string,
  recentTurns: readonly string[],
  cap: number,
): string[] => rulesetItems(condensedOf(documents), playerInput, recentTurns, cap);

export const citesOwnRulesSection = (documents: readonly RulesDocument[], section: string | undefined): boolean =>
  section !== undefined &&
  condensedOf(documents).sections.some(({ title }) => normalizedTitle(title) === normalizedTitle(section));
