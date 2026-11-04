import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadGenrePack } from './genrepack.ts';
import { FANTASY_PACK } from './packs.ts';
import { generateSetting, SETTING_GENERATOR_VERSION, type SettingElement, type SettingRequest } from './setting.ts';

const SEED = 42;
const OTHER_SEED = 7;
const DND_FIELDS = /strength|dexterity|armor class|hit points|d20|\bdc\b/i;

const seededRng = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
};

const pack = (() => {
  const result = loadGenrePack(FANTASY_PACK.genre);
  if (!result.ok) throw new Error('pack failed to load');
  return result.pack;
})();

const request = (seed: number, overrides: Partial<SettingRequest> = {}): SettingRequest => ({
  pack,
  tables: {
    locations: ['Drowned chapel', 'Toll keep', 'Standing stones', 'Riverside inn'],
    factions: ['House Varn', 'Forest folk', 'Bell wardens'],
    hooks: [...FANTASY_PACK.story.openingScenes, ...FANTASY_PACK.story.conflicts],
  },
  preferences: { locations: 3, factions: 2, hooks: 2, npcs: 2 },
  rng: seededRng(seed),
  seed,
  ...overrides,
});

test('generate consistent locations, factions, hooks and starting npcs with provenance', () => {
  const proposal = generateSetting(request(SEED));
  assert.deepEqual(generateSetting(request(SEED)), proposal);
  assert.deepEqual(proposal.provenance, {
    packId: 'fantasy',
    packVersion: '1.0.0',
    seed: SEED,
    generatorVersion: SETTING_GENERATOR_VERSION,
  });
  const count = (kind: string) => proposal.additions.filter((element) => element.kind === kind).length;
  assert.deepEqual([count('location'), count('faction'), count('hook'), count('npc')], [3, 2, 2, 2]);
  const ids = proposal.additions.map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
  const locationIds = new Set(proposal.additions.filter((e) => e.kind === 'location').map((e) => e.id));
  for (const element of proposal.additions) {
    if (element.kind === 'location') assert.equal(element.locationId, null);
    else assert.ok(locationIds.has(element.locationId ?? ''), `${element.id} references a missing location`);
    assert.match(element.origin, /^(tables\.(locations|factions|hooks)|archetypes)\.\d+$/);
  }
  assert.ok(proposal.additions.some((element) => element.origin.startsWith('archetypes.')));
  assert.deepEqual(proposal.conflicts, []);
  assert.deepEqual(proposal.replacements, []);
  assert.equal(DND_FIELDS.test(JSON.stringify(proposal)), false);
  assert.throws(
    () => generateSetting(request(SEED, { preferences: { locations: 9, factions: 0, hooks: 0, npcs: 0 } })),
    RangeError,
  );
  assert.throws(
    () => generateSetting(request(SEED, { preferences: { locations: 0, factions: 1, hooks: 0, npcs: 0 } })),
    RangeError,
  );
});

test('regeneration does not silently replace persistent canon in an existing campaign', () => {
  const first = generateSetting(request(SEED));
  const canon: SettingElement[] = first.additions.map((element) =>
    element.kind === 'faction' ? { ...element, locationId: 'location:edited-by-player' } : element,
  );
  canon.push({
    id: 'location:edited-by-player',
    kind: 'location',
    name: 'Edited by player',
    locationId: null,
    origin: 'user',
  });
  const all = { locations: 4, factions: 3, hooks: 4, npcs: 3 };

  const preserved = generateSetting(request(OTHER_SEED, { canon, preferences: all }));
  const canonIds = new Set(canon.map((element) => element.id));
  assert.ok(preserved.additions.every((element) => !canonIds.has(element.id)));
  assert.deepEqual(preserved.replacements, []);
  assert.ok(preserved.conflicts.length > 0);
  for (const conflict of preserved.conflicts) {
    assert.deepEqual(
      conflict.canon,
      canon.find((element) => element.id === conflict.id),
    );
    assert.notDeepEqual(conflict.proposed, conflict.canon);
  }
  const knownLocations = new Set(
    [...canon, ...preserved.additions].filter((e) => e.kind === 'location').map((e) => e.id),
  );
  for (const element of preserved.additions) {
    if (element.kind !== 'location') assert.ok(knownLocations.has(element.locationId ?? ''));
  }

  const optedIn = generateSetting(request(OTHER_SEED, { canon, preferences: all, replaceCanon: true }));
  assert.deepEqual(
    optedIn.replacements,
    preserved.conflicts.map((conflict) => conflict.proposed),
  );
  assert.deepEqual(optedIn.conflicts, preserved.conflicts);
});

test('regeneration matches stored canon entities by kind and name, not only by generated id', () => {
  const STORED_ID = '0b6f1c9e-8d2a-4e57-9a51-3f2c7d1e4b60';
  const stored = { id: STORED_ID, kind: 'location' as const, name: '  toll KEEP ' };
  const canon = [stored];
  const everyLocation = { locations: 4, factions: 3, hooks: 0, npcs: 0 };
  const proposal = generateSetting(request(SEED, { canon, preferences: everyLocation }));
  assert.equal(proposal.additions.filter((element) => /toll keep/i.test(element.name)).length, 0);
  assert.deepEqual(proposal.conflicts, []);
  const factionRefs = proposal.additions.filter((e) => e.kind === 'faction').map((e) => e.locationId);
  assert.ok(factionRefs.every((ref) => ref !== 'location:toll-keep'));
  assert.ok(factionRefs.every((ref) => ref === STORED_ID || proposal.additions.some((e) => e.id === ref)));

  const placedCanon = [{ ...stored, name: 'Toll keep', locationId: 'location:elsewhere' }];
  const conflicted = generateSetting(request(SEED, { canon: placedCanon, preferences: everyLocation }));
  assert.deepEqual(
    conflicted.conflicts.map((conflict) => [conflict.id, conflict.proposed.id, conflict.proposed.name]),
    [[STORED_ID, STORED_ID, 'Toll keep']],
  );
  assert.ok(conflicted.additions.every((element) => element.name !== 'Toll keep'));

  const blank = { ...request(SEED).tables, locations: ['!!!'] };
  assert.throws(() => generateSetting(request(SEED, { tables: blank, preferences: everyLocation })), RangeError);
});
