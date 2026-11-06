import type { RulesDocument } from '../../../packages/engine/src/own-rules.ts';
import { type CondensedRules, condense, rulesetItems } from '../../../packages/memory/src/rules.ts';

const TITLE_MARKS = /^#+\s*/;

const CONDENSED_CACHE_LIMIT = 32;
const condensedCache = new Map<string, CondensedRules>();

const condensedDocument = ({ text }: RulesDocument): CondensedRules => {
  const cached = condensedCache.get(text);
  if (cached !== undefined) return cached;
  const fresh = condense(text);
  condensedCache.set(text, fresh);
  if (condensedCache.size > CONDENSED_CACHE_LIMIT) {
    const oldest = condensedCache.keys().next().value;
    if (oldest !== undefined) condensedCache.delete(oldest);
  }
  return fresh;
};

const condensedOf = (documents: readonly RulesDocument[]): CondensedRules => {
  const condensed = documents.map(condensedDocument);
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
