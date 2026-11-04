import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCharacterProfile } from '../../domain/src/character.ts';
import { loadGenrePack } from './genrepack.ts';
import { FANTASY_PACK, SCIENCE_FICTION_PACK } from './packs.ts';
import { loadStoryKit } from './story.ts';

const NARRATIVE_RULESET = { id: 'narrative', edition: 'original', revision: '1' };
const MECHANIC_TERMS =
  /\b(spells?|dice|d20|hit points|hp|mana|damage|initiative|armou?r class|combat|levels?|class)\b/i;
const MECHANIC_FIELDS = ['spells', 'combat', 'dice', 'starshipCombat', 'rulepack'];
const PACKS = [FANTASY_PACK, SCIENCE_FICTION_PACK];

const unwrapPack = (input: unknown) => {
  const result = loadGenrePack(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.pack;
};

const unwrapStory = (input: unknown) => {
  const result = loadStoryKit(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.kit;
};

const storyIssuePaths = (input: unknown) => {
  const result = loadStoryKit(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

const disjoint = (left: readonly string[], right: readonly string[]) => left.every((item) => !right.includes(item));

test('provide distinct opening scenes, npc archetypes, conflicts and tone for both', () => {
  const [fantasy, scienceFiction] = PACKS.map((pack) => ({
    genre: unwrapPack(pack.genre),
    story: unwrapStory(pack.story),
  }));
  assert.ok(fantasy && scienceFiction);
  assert.notEqual(fantasy.genre.id, scienceFiction.genre.id);
  for (const { genre, story } of [fantasy, scienceFiction]) {
    assert.ok(genre.archetypes.length > 0, genre.id);
    assert.ok(story.openingScenes.length > 0, genre.id);
    assert.ok(story.conflicts.length > 0, genre.id);
    assert.ok(story.tone.length > 0, genre.id);
  }
  const archetypeIds = (pack: typeof fantasy) => pack.genre.archetypes.map((archetype) => archetype.id);
  assert.ok(disjoint(archetypeIds(fantasy), archetypeIds(scienceFiction)));
  assert.ok(disjoint(fantasy.story.openingScenes, scienceFiction.story.openingScenes));
  assert.ok(disjoint(fantasy.story.conflicts, scienceFiction.story.conflicts));
  assert.ok(disjoint(fantasy.story.tone, scienceFiction.story.tone));
  assert.deepEqual(storyIssuePaths({ ...FANTASY_PACK.story, openingScenes: [''] }), ['openingScenes.0']);
  assert.deepEqual(storyIssuePaths({ ...FANTASY_PACK.story, tone: 'grim' }), ['tone']);
  assert.deepEqual(storyIssuePaths(null), ['']);
  assert.equal(Object.isFrozen(fantasy.story.conflicts), true);
});

test('both packs can run under narrative rules without assumed spell/space combat mechanics', () => {
  for (const pack of PACKS) {
    assert.equal(MECHANIC_TERMS.test(JSON.stringify(pack)), false, pack.genre.id);
    assert.deepEqual(Object.keys(pack), ['genre', 'story']);
    for (const field of MECHANIC_FIELDS) {
      assert.equal(loadGenrePack({ ...pack.genre, [field]: true }).ok, false, `genre ${field}`);
      assert.deepEqual(storyIssuePaths({ ...pack.story, [field]: true }), [field]);
    }
    const genre = unwrapPack(pack.genre);
    const profile = parseCharacterProfile({
      identity: { name: `${genre.name} hero` },
      motivations: [],
      background: genre.id,
      traits: [],
      conditions: [],
      rulepack: NARRATIVE_RULESET,
    });
    assert.ok(profile.ok, genre.id);
    assert.deepEqual(profile.profile.rulepack, NARRATIVE_RULESET);
  }
});
