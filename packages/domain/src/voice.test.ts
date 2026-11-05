import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toVoiceProfile, toVoiceTraits, VOICE_AGES, VOICE_GENDERS, VOICE_MANNERS } from './voice.ts';

test('voice traits accept the closed enums', () => {
  assert.deepEqual(toVoiceTraits({ gender: 'female', age: 'old', manner: 'gruff' }), {
    gender: 'female',
    age: 'old',
    manner: 'gruff',
  });
  assert.deepEqual(VOICE_GENDERS, ['female', 'male', 'neutral']);
  assert.deepEqual(VOICE_AGES, ['child', 'young', 'adult', 'old']);
  assert.ok(VOICE_MANNERS.includes('warm') && VOICE_MANNERS.includes('menacing'));
});

test('unknown values and keys are dropped without throwing', () => {
  assert.deepEqual(toVoiceTraits({ gender: 'robot', age: 'old', manner: 7, volume: 11 }), { age: 'old' });
});

test('nothing usable gives no traits', () => {
  for (const junk of [undefined, null, 'female', 42, [], {}, { gender: 'robot' }]) {
    assert.equal(toVoiceTraits(junk), undefined);
  }
});

const PROFILE = { id: 'npc', language: 'en-GB', pace: 1, style: '', pronunciations: {}, fallbacks: [] };

test('a voice profile keeps a known manner and drops an unknown one', () => {
  assert.equal(toVoiceProfile({ ...PROFILE, manner: 'gruff' })?.manner, 'gruff');
  assert.equal(toVoiceProfile({ ...PROFILE, manner: 'sleepy' })?.manner, undefined);
  assert.deepEqual(toVoiceProfile(PROFILE), PROFILE);
});
