import type { RulesetChoice } from './intent.ts';
import { type CapabilityReport, type InstalledRulePack, matchRuleset, type Registry } from './registry.ts';

export const MAX_TYPO_DISTANCE = 2;
export const CHARS_PER_TYPO = 4;
export const MATCH_KINDS = ['exact', 'alias', 'fuzzy'] as const;

export type MatchKind = (typeof MATCH_KINDS)[number];
export type RulesetCandidate = { id: string; edition: string };
export type ClarificationReason = 'unknown_system' | 'unknown_edition';
export type RulesetResolution =
  | {
      status: 'resolved';
      match: MatchKind;
      requested: RulesetChoice;
      rulepack: InstalledRulePack;
      capabilities: CapabilityReport;
    }
  | { status: 'ambiguous'; requested: RulesetChoice; candidates: RulesetCandidate[] }
  | {
      status: 'clarification_needed';
      reason: ClarificationReason;
      requested: RulesetChoice;
      available: RulesetCandidate[];
    };

const ORDINAL_WORDS: Record<string, string> = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
  fifth: '5',
  sixth: '6',
  seventh: '7',
  eighth: '8',
  ninth: '9',
  tenth: '10',
};
const ORDINAL_WORD = new RegExp(String.raw`\b(?:${Object.keys(ORDINAL_WORDS).join('|')})\b`, 'g');
const EDITION_FORM = /^(\d+(?:\.\d+)*)\s*(?:st|nd|rd|th|ª|º|a)?\s*(?:e|ed|edition|edição)?$/;
const AMPERSAND = /&/g;
const NON_ALPHANUMERIC = /[^a-z0-9]/g;
const WHITESPACE = /\s+/g;

const systemKey = (name: string) => name.toLowerCase().replace(AMPERSAND, 'and').replace(NON_ALPHANUMERIC, '');

const editionKey = (edition: string) => {
  const spelled = edition
    .trim()
    .toLowerCase()
    .replace(ORDINAL_WORD, (word) => ORDINAL_WORDS[word] ?? word);
  return EDITION_FORM.exec(spelled)?.[1] ?? spelled.replace(WHITESPACE, '');
};

const typoDistance = (a: string, b: string) => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = rows[i] ?? [];
      const above = rows[i - 1] ?? [];
      row[j] = Math.min((above[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (above[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j] ?? 0, (rows[i - 2]?.[j - 2] ?? 0) + 1);
    }
  return rows[a.length]?.[b.length] ?? 0;
};

const candidate = (pack: InstalledRulePack): RulesetCandidate => ({ id: pack.id, edition: pack.edition });
const worst = (a: MatchKind, b: MatchKind) =>
  MATCH_KINDS[Math.max(MATCH_KINDS.indexOf(a), MATCH_KINDS.indexOf(b))] ?? b;

const matchSystems = (registry: Registry, requested: string): { ids: string[]; kind: MatchKind } => {
  const ids = [...new Set(registry.rulepacks.map((pack) => pack.id))];
  if (ids.includes(requested)) return { ids: [requested], kind: 'exact' };
  const key = systemKey(requested);
  const names = (id: string) =>
    [id, ...registry.rulepacks.filter((pack) => pack.id === id).flatMap((pack) => pack.aliases ?? [])].map(systemKey);
  const aliased = ids.filter((id) => names(id).includes(key));
  if (aliased.length > 0) return { ids: aliased, kind: 'alias' };
  const allowed = Math.min(MAX_TYPO_DISTANCE, Math.floor(key.length / CHARS_PER_TYPO));
  const distances = ids.map((id) => Math.min(...names(id).map((name) => typoDistance(key, name))));
  const best = Math.min(...distances);
  if (best > allowed) return { ids: [], kind: 'fuzzy' };
  return { ids: ids.filter((_, index) => distances[index] === best), kind: 'fuzzy' };
};

const matchEdition = (packs: InstalledRulePack[], requested: string | null) => {
  if (requested === null) return { packs, kind: 'exact' as const };
  const exact = packs.filter((pack) => pack.edition === requested);
  if (exact.length > 0) return { packs: exact, kind: 'exact' as const };
  return { packs: packs.filter((pack) => editionKey(pack.edition) === editionKey(requested)), kind: 'alias' as const };
};

export const resolveRuleset = (
  registry: Registry,
  requested: RulesetChoice,
  capabilities: readonly string[] = [],
): RulesetResolution => {
  const systems = matchSystems(registry, requested.id);
  const packs = registry.rulepacks.filter((pack) => systems.ids.includes(pack.id));
  if (systems.ids.length === 0)
    return {
      status: 'clarification_needed',
      reason: 'unknown_system',
      requested,
      available: registry.rulepacks.map(candidate),
    };
  if (systems.ids.length > 1) return { status: 'ambiguous', requested, candidates: packs.map(candidate) };
  const editions = matchEdition(packs, requested.edition);
  const [found] = editions.packs;
  if (!found)
    return { status: 'clarification_needed', reason: 'unknown_edition', requested, available: packs.map(candidate) };
  const match = matchRuleset(
    registry,
    { id: found.id, edition: editions.packs.length === 1 ? found.edition : null },
    capabilities,
  );
  if (!match.ok) return { status: 'ambiguous', requested, candidates: editions.packs.map(candidate) };
  return {
    status: 'resolved',
    match: worst(systems.kind, editions.kind),
    requested,
    rulepack: match.rulepack,
    capabilities: match.capabilities,
  };
};
