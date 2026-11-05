import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOICE_MANNERS } from '../../domain/src/voice.ts';
import { KOKORO_CAPABILITIES, MLX_KOKORO_CAPABILITIES } from './kokoro-provider.ts';
import {
  catalogGenderOf,
  MANNER_DELIVERY,
  MANNER_TIMBRE,
  MAX_MANNER_PACE,
  MAX_MANNER_PITCH_SEMITONES,
  MIN_MANNER_PACE,
  mannerDelivery,
  NEUTRAL_DELIVERY,
  VOICE_CATALOG,
} from './voice-catalog.ts';

const INSTALLED = [...KOKORO_CAPABILITIES.voices, ...MLX_KOKORO_CAPABILITIES.voices];
const MARKER_INDEX = 1;
const MARKER_GENDER: Readonly<Record<string, string>> = { f: 'female', m: 'male' };

test('every installed voice is tagged with a gender that matches its id', () => {
  for (const voiceId of INSTALLED) {
    const entry = VOICE_CATALOG[voiceId];
    assert.ok(entry, `${voiceId} is not in the catalog`);
    assert.equal(entry.gender, MARKER_GENDER[voiceId.charAt(MARKER_INDEX)]);
    assert.ok(entry.ages.length > 0 && entry.timbre.length > 0);
  }
});

test('an unlisted voice falls back to the gender marker of its id', () => {
  assert.equal(catalogGenderOf('pf_new'), 'female');
  assert.equal(catalogGenderOf('pm_new'), 'male');
  assert.equal(catalogGenderOf('xx_new'), undefined);
});

test('every manner has timbre words and delivery inside the safe bounds', () => {
  for (const manner of VOICE_MANNERS) {
    assert.ok(MANNER_TIMBRE[manner]?.length);
    const { pace, pitch } = MANNER_DELIVERY[manner] ?? { pace: Number.NaN, pitch: Number.NaN };
    assert.ok(pace >= MIN_MANNER_PACE && pace <= MAX_MANNER_PACE);
    assert.ok(Math.abs(pitch) <= MAX_MANNER_PITCH_SEMITONES);
  }
});

test('manner delivery is neutral for an absent or unknown manner', () => {
  assert.deepEqual(mannerDelivery(undefined), NEUTRAL_DELIVERY);
  assert.deepEqual(mannerDelivery('sleepy'), NEUTRAL_DELIVERY);
  assert.deepEqual(mannerDelivery('__proto__'), NEUTRAL_DELIVERY);
  assert.ok(mannerDelivery('menacing').pace < mannerDelivery('cheerful').pace);
  assert.ok(mannerDelivery('menacing').pitch < mannerDelivery('cheerful').pitch);
});
