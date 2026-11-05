import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SOUND_SETTINGS, SOUND_CHANNELS, soundEnabled, toSoundSettings } from './sound-settings.ts';

test('every channel is off by default', () => {
  for (const channel of SOUND_CHANNELS) assert.equal(DEFAULT_SOUND_SETTINGS[channel].enabled, false);
  assert.equal(soundEnabled(DEFAULT_SOUND_SETTINGS), false);
});

test('reads saved channels and falls back per channel for anything invalid', () => {
  const settings = toSoundSettings({
    ambience: { enabled: true, volume: 0.25 },
    effects: { enabled: 'yes', volume: 7 },
    music: 'loud',
  });
  assert.deepEqual(settings.ambience, { enabled: true, volume: 0.25 });
  assert.deepEqual(settings.effects, DEFAULT_SOUND_SETTINGS.effects);
  assert.deepEqual(settings.music, DEFAULT_SOUND_SETTINGS.music);
  assert.equal(soundEnabled(settings), true);
});

test('anything that is not an object gives the defaults', () => {
  assert.deepEqual(toSoundSettings(null), DEFAULT_SOUND_SETTINGS);
  assert.deepEqual(toSoundSettings([]), DEFAULT_SOUND_SETTINGS);
});
