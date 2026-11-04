import type { RulesetChoice } from './intent.ts';

export type InstalledRulePack = {
  id: string;
  edition: string;
  revision: string;
  capabilities: Record<string, boolean | string>;
  sourceRefs: string[];
  aliases?: string[];
};
export type InstalledGenrePack = { id: string; version: string; name?: string; aliases?: string[] };
export type Registry = { rulepacks: readonly InstalledRulePack[]; genres: readonly InstalledGenrePack[] };
export type GenreChoice = { id: string; version: string | null };

export type MatchFailureCode = 'not_installed' | 'ambiguous';
export type MatchFailure<R> = { ok: false; code: MatchFailureCode; requested: R; available: string[] };
export type CapabilityReport = { advertised: string[]; supported: string[]; unsupported: string[] };
export type RulesetMatch =
  | { ok: true; rulepack: InstalledRulePack; capabilities: CapabilityReport }
  | MatchFailure<RulesetChoice>;
export type GenreMatch = { ok: true; genre: InstalledGenrePack } | MatchFailure<GenreChoice>;

const SEPARATORS = /[\s_-]+/g;
const nameKey = (name: string) => name.trim().toLowerCase().replace(SEPARATORS, '-');
const genreNames = (genre: InstalledGenrePack) =>
  [genre.id, genre.name, ...(genre.aliases ?? [])].flatMap((name) => (name === undefined ? [] : [nameKey(name)]));

const select = <T, R>(candidates: T[], versionOf: (item: T) => string, wanted: string | null, requested: R) => {
  const available = candidates.map(versionOf);
  const matches = wanted === null ? candidates : candidates.filter((item) => versionOf(item) === wanted);
  const found = matches.length === 1 ? matches[0] : undefined;
  if (found) return { ok: true as const, found };
  const code: MatchFailureCode = wanted === null && candidates.length > 1 ? 'ambiguous' : 'not_installed';
  return { ok: false as const, code, requested, available };
};

const reportCapabilities = (pack: InstalledRulePack, requested: readonly string[]): CapabilityReport => {
  const advertised = Object.keys(pack.capabilities).filter((name) => pack.capabilities[name] !== false);
  return {
    advertised,
    supported: requested.filter((name) => advertised.includes(name)),
    unsupported: requested.filter((name) => !advertised.includes(name)),
  };
};

export const matchRuleset = (
  registry: Registry,
  requested: RulesetChoice,
  capabilities: readonly string[],
): RulesetMatch => {
  const candidates = registry.rulepacks.filter((pack) => pack.id === requested.id);
  const result = select(candidates, (pack) => pack.edition, requested.edition, requested);
  if (!result.ok) return result;
  return { ok: true, rulepack: result.found, capabilities: reportCapabilities(result.found, capabilities) };
};

export const matchGenre = (registry: Registry, requested: GenreChoice): GenreMatch => {
  const candidates = registry.genres.filter((genre) => genreNames(genre).includes(nameKey(requested.id)));
  const result = select(candidates, (genre) => genre.version, requested.version, requested);
  return result.ok ? { ok: true, genre: result.found } : result;
};
