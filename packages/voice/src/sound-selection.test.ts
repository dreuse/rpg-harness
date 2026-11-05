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
