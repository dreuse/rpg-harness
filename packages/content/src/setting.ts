import type { CampaignEntity, EntityKind } from '../../domain/src/entity.ts';
import type { GenrePack } from './genrepack.ts';

export const SETTING_GENERATOR_VERSION = '1.0.0';

const LOCATION_KIND = 'location' satisfies EntityKind;
const FACTION_KIND = 'faction' satisfies EntityKind;
const NPC_KIND = 'npc' satisfies EntityKind;
const HOOK_KIND = 'hook';
const TABLE_KINDS = { locations: LOCATION_KIND, factions: FACTION_KIND, hooks: HOOK_KIND } as const;
const NPC_SOURCE = 'archetypes';
const SLUG_SEPARATOR = /[^a-z0-9]+/g;
const SLUG_EDGES = /^-|-$/g;

type TableName = keyof typeof TABLE_KINDS;
export type SettingElementKind = (typeof TABLE_KINDS)[TableName] | typeof NPC_KIND;
export type SettingTables = { readonly [table in TableName]: readonly string[] };
export type SettingPreferences = { readonly [table in TableName]: number } & { readonly npcs: number };

export type SettingElement = {
  readonly id: string;
  readonly kind: SettingElementKind;
  readonly name: string;
  readonly locationId: string | null;
  readonly origin: string;
};

export type SettingCanon = Pick<CampaignEntity, 'id' | 'name'> & {
  readonly kind: EntityKind | typeof HOOK_KIND;
  readonly locationId?: string | null;
};

export type SettingRequest = {
  readonly pack: GenrePack;
  readonly tables: SettingTables;
  readonly preferences: SettingPreferences;
  readonly rng: () => number;
  readonly seed: number | string;
  readonly canon?: readonly SettingCanon[];
  readonly replaceCanon?: boolean;
};

export type SettingConflict = {
  readonly id: string;
  readonly canon: SettingCanon;
  readonly proposed: SettingElement;
};

export type SettingProposal = {
  readonly provenance: {
    readonly packId: string;
    readonly packVersion: string;
    readonly seed: number | string;
    readonly generatorVersion: string;
  };
  readonly additions: readonly SettingElement[];
  readonly replacements: readonly SettingElement[];
  readonly conflicts: readonly SettingConflict[];
};

const normalise = (name: string) => name.trim().toLowerCase();

const slug = (name: string) => {
  const value = normalise(name).replace(SLUG_SEPARATOR, '-').replace(SLUG_EDGES, '');
  if (value.length === 0) throw new RangeError(`"${name}" has no characters usable in an id`);
  return value;
};

const draw = (rng: () => number, size: number) => {
  const value = rng();
  if (!(value >= 0 && value < 1)) throw new RangeError('rng must return a number in [0, 1)');
  return Math.floor(value * size);
};

type Entry = { readonly name: string; readonly key: string };

const pick = (rng: () => number, entries: readonly Entry[], count: number, label: string) => {
  if (!Number.isInteger(count) || count < 0 || count > entries.length) {
    throw new RangeError(`${label} must be an integer between 0 and ${entries.length}`);
  }
  const pool = entries.map((entry, index) => ({ ...entry, index }));
  return Array.from({ length: count }, () => pool.splice(draw(rng, pool.length), 1)).flat();
};

const named = (names: readonly string[]) => names.map((name) => ({ name, key: slug(name) }));

const differs = (canon: SettingCanon, proposed: SettingElement) =>
  canon.kind !== proposed.kind ||
  normalise(canon.name) !== normalise(proposed.name) ||
  (canon.locationId !== undefined && canon.locationId !== proposed.locationId);

export const generateSetting = (request: SettingRequest): SettingProposal => {
  const { pack, tables, preferences, rng, seed, canon = [], replaceCanon = false } = request;
  const canonById = new Map(canon.map((item) => [item.id, item]));
  const canonByName = new Map(canon.map((item) => [`${item.kind}:${normalise(item.name)}`, item]));
  const generatedIds = new Set<string>();
  const matches = new Map<string, SettingCanon>();
  const element = (
    kind: SettingElementKind,
    entry: Entry & { index: number },
    source: string,
    locationId: string | null,
  ) => {
    const generatedId = `${kind}:${entry.key}`;
    if (generatedIds.has(generatedId)) throw new RangeError(`${source} yields duplicate id ${generatedId}`);
    generatedIds.add(generatedId);
    const match = canonById.get(generatedId) ?? canonByName.get(`${kind}:${normalise(entry.name)}`);
    const item = Object.freeze({
      id: match?.id ?? generatedId,
      kind,
      name: entry.name,
      locationId,
      origin: `${source}.${entry.index}`,
    });
    if (match) matches.set(item.id, match);
    return item;
  };

  const locations = pick(rng, named(tables.locations), preferences.locations, 'preferences.locations').map((entry) =>
    element(LOCATION_KIND, entry, 'tables.locations', null),
  );
  const locationIds = [
    ...new Set([...canon, ...locations].filter((item) => item.kind === LOCATION_KIND).map((item) => item.id)),
  ];
  const placed = (kind: SettingElementKind, entries: readonly Entry[], count: number, source: string) => {
    const picks = pick(rng, entries, count, `preferences.${source}`);
    if (picks.length > 0 && locationIds.length === 0) throw new RangeError(`${source} need at least one location`);
    return picks.map((entry) => element(kind, entry, source, locationIds[draw(rng, locationIds.length)] ?? null));
  };
  const proposed = [
    ...locations,
    ...placed(FACTION_KIND, named(tables.factions), preferences.factions, 'tables.factions'),
    ...placed(HOOK_KIND, named(tables.hooks), preferences.hooks, 'tables.hooks'),
    ...placed(
      NPC_KIND,
      pack.archetypes.map((archetype) => ({ name: archetype.name, key: archetype.id })),
      preferences.npcs,
      NPC_SOURCE,
    ),
  ];

  const conflicts = proposed.flatMap((item) => {
    const existing = matches.get(item.id);
    return existing && differs(existing, item) ? [{ id: item.id, canon: existing, proposed: item }] : [];
  });
  return Object.freeze({
    provenance: Object.freeze({
      packId: pack.id,
      packVersion: pack.version,
      seed,
      generatorVersion: SETTING_GENERATOR_VERSION,
    }),
    additions: Object.freeze(proposed.filter((item) => !matches.has(item.id))),
    replacements: Object.freeze(replaceCanon ? conflicts.map((conflict) => conflict.proposed) : []),
    conflicts: Object.freeze(conflicts),
  });
};
