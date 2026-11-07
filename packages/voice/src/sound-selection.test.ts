import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MUSIC_KEY, sceneSoundOf, selectSounds } from './sound-selection.ts';

test('maps a location kind to its ambience key', () => {
  assert.equal(selectSounds({ location: 'tavern', mood: [] }).ambience, 'tavern');
  assert.equal(selectSounds({ location: 'harbour', mood: [] }).ambience, 'sea');
  assert.equal(selectSounds({ location: 'dungeon', mood: [] }).ambience, 'cave');
});

test('matching is case-insensitive and ignores unknown locations', () => {
  assert.equal(selectSounds({ location: 'Forest', mood: [] }).ambience, 'forest');
  assert.equal(selectSounds({ location: 'moon base', mood: [] }).ambience, undefined);
});

test('combat and tension moods override the location ambience', () => {
  assert.equal(selectSounds({ location: 'tavern', mood: ['combat'] }).ambience, 'battle');
  assert.equal(selectSounds({ location: 'forest', mood: ['tense'] }).ambience, 'tension');
});

test('mood picks the music bed and calm is the default', () => {
  assert.equal(selectSounds({ location: 'tavern', mood: ['combat'] }).music, 'combat');
  assert.equal(selectSounds({ location: 'tavern', mood: ['tense'] }).music, 'tension');
  assert.equal(selectSounds({ location: 'forest', mood: ['exploration'] }).music, 'exploration');
  assert.equal(selectSounds({ location: 'tavern', mood: [] }).music, DEFAULT_MUSIC_KEY);
});

test('the first recognised mood wins, in the order the scene lists them', () => {
  assert.equal(selectSounds({ location: 'tavern', mood: ['unknown', 'tense', 'combat'] }).music, 'tension');
});

test('the same scene always selects the same sounds', () => {
  const scene = { location: 'cave', mood: ['tense'] };
  assert.deepEqual(selectSounds(scene), selectSounds(scene));
});

test('a genre extension adds locations and moods and may override defaults', () => {
  const extension = {
    locations: { spaceport: 'city', tavern: 'city' },
    moods: { mystic: { music: 'exploration', ambience: 'cave' } },
  };
  assert.equal(selectSounds({ location: 'spaceport', mood: [] }, extension).ambience, 'city');
  assert.equal(selectSounds({ location: 'tavern', mood: [] }, extension).ambience, 'city');
  assert.deepEqual(selectSounds({ location: 'tavern', mood: ['mystic'] }, extension), {
    ambience: 'cave',
    music: 'exploration',
  });
});

test('an extension never changes the built-in table', () => {
  selectSounds({ location: 'tavern', mood: [] }, { locations: { tavern: 'city' } });
  assert.equal(selectSounds({ location: 'tavern', mood: [] }).ambience, 'tavern');
});

test('inherited object keys are not locations or moods', () => {
  assert.deepEqual(selectSounds({ location: 'constructor', mood: ['toString'] }), { music: DEFAULT_MUSIC_KEY });
});

test('rpg-cm63.34 a scene title yields a location kind and mood tags', () => {
  assert.deepEqual(sceneSoundOf('The Rusty Tavern'), { location: 'tavern', mood: ['the', 'rusty', 'tavern'] });
  assert.deepEqual(sceneSoundOf(undefined), { location: '', mood: [] });
});

test('rpg-cm63.41 persisted location kind and mood tags replace the title words', () => {
  assert.deepEqual(sceneSoundOf('The Rusty Tavern', { locationKind: 'forest', moodTags: ['tense'] }), {
    location: 'forest',
    mood: ['tense'],
  });
});

test('rpg-cm63.41 a missing location kind falls back to the title and missing mood tags to none', () => {
  assert.deepEqual(sceneSoundOf('The Rusty Tavern', { moodTags: ['combat'] }), {
    location: 'tavern',
    mood: ['combat'],
  });
  assert.deepEqual(sceneSoundOf('The Rusty Tavern', { locationKind: 'cave' }), { location: 'cave', mood: [] });
});

test('rpg-cm63.41 empty tags fall back to the title', () => {
  assert.deepEqual(sceneSoundOf('The Rusty Tavern', {}), sceneSoundOf('The Rusty Tavern'));
});

test('any word of a multi-word location can match, first match wins', () => {
  assert.equal(selectSounds({ location: 'castle courtyard', mood: [] }).ambience, 'city');
  assert.equal(selectSounds({ location: 'old Harbour-side tavern', mood: [] }).ambience, 'sea');
  assert.equal(selectSounds({ location: 'moon base', mood: [] }).ambience, undefined);
});

test('common scene vocabulary maps to existing ambience keys', () => {
  const expected: Record<string, string> = {
    castle: 'city',
    keep: 'city',
    fortress: 'city',
    road: 'forest',
    trail: 'forest',
    plains: 'forest',
    docks: 'sea',
    pier: 'sea',
    wharf: 'sea',
  };
  for (const [location, ambience] of Object.entries(expected)) {
    assert.equal(selectSounds({ location, mood: [] }).ambience, ambience, location);
  }
});

test('extension locations still override the base table per word', () => {
  assert.equal(selectSounds({ location: 'castle hall', mood: [] }, { locations: { castle: 'cave' } }).ambience, 'cave');
});
