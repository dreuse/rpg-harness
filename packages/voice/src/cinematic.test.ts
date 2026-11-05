import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importantNpcProfile } from './cinematic.ts';
import { KOKORO_CAPABILITIES, KOKORO_DELIVERY_SPEED, KOKORO_PROVIDER_ID, kokoroSpeed } from './kokoro-provider.ts';
import { MLX_KOKORO_CAPABILITIES, MLX_KOKORO_PROVIDER_ID } from './mlx-audio-engine.ts';
import type { VoiceProfile } from './voice.ts';

const NARRATOR_VOICE = 'af_heart';
const NARRATOR: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: KOKORO_PROVIDER_ID, voiceId: NARRATOR_VOICE }],
};
const HALF = 0.5;
const SLOW_PACE = 0.8;
const NPC_COUNT = 40;

test('maps emotion, intensity and pace to a Kokoro speed', () => {
  assert.equal(kokoroSpeed(undefined), KOKORO_DELIVERY_SPEED.neutral);
  assert.equal(kokoroSpeed({ emotion: 'angry' }), KOKORO_DELIVERY_SPEED.angry);
  assert.equal(kokoroSpeed({ emotion: 'sad', intensity: 0 }), KOKORO_DELIVERY_SPEED.neutral);
  assert.equal(
    kokoroSpeed({ emotion: 'excited', intensity: HALF }),
    KOKORO_DELIVERY_SPEED.neutral + (KOKORO_DELIVERY_SPEED.excited - KOKORO_DELIVERY_SPEED.neutral) * HALF,
  );
  assert.equal(kokoroSpeed({ pace: SLOW_PACE }), SLOW_PACE);
});

test('unsupported emotions and invalid numbers degrade to neutral', () => {
  assert.equal(kokoroSpeed({ emotion: 'smug' }), KOKORO_DELIVERY_SPEED.neutral);
  assert.equal(kokoroSpeed({ emotion: 'toString' }), KOKORO_DELIVERY_SPEED.neutral);
  assert.equal(kokoroSpeed({ pace: Number.NaN, intensity: Number.NaN }), KOKORO_DELIVERY_SPEED.neutral);
  assert.equal(kokoroSpeed({ emotion: 'angry', intensity: 2 }), KOKORO_DELIVERY_SPEED.angry);
});

test('clamps the speed to the range Kokoro accepts', () => {
  assert.equal(kokoroSpeed({ pace: 10 }), 2);
  assert.equal(kokoroSpeed({ pace: 0.01 }), 0.5);
});

test('important NPCs get a deterministic Kokoro voice distinct from the narrator', () => {
  const ids = Array.from({ length: NPC_COUNT }, (_, index) => `npc-${index}`);
  const voices = ids.map((id) => importantNpcProfile(id, NARRATOR).fallbacks[0]?.voiceId);
  assert.deepEqual(
    voices,
    ids.map((id) => importantNpcProfile(id, NARRATOR).fallbacks[0]?.voiceId),
  );
  for (const voice of voices) {
    assert.ok(voice !== undefined && KOKORO_CAPABILITIES.voices.includes(voice));
    assert.notEqual(voice, NARRATOR_VOICE);
  }
  assert.ok(new Set(voices).size > 1);
});

test('the important NPC profile keeps the base profile and puts Kokoro first', () => {
  const other = { providerId: 'cloud', voiceId: 'x' };
  const profile = importantNpcProfile('npc-7', { ...NARRATOR, fallbacks: [other, ...NARRATOR.fallbacks] });
  assert.equal(profile.id, 'npc-7');
  assert.equal(profile.language, NARRATOR.language);
  assert.equal(profile.fallbacks[0]?.providerId, KOKORO_PROVIDER_ID);
  assert.deepEqual(profile.fallbacks.slice(1), [other]);
});

const kokoroVoiceOf = (profile: VoiceProfile) =>
  profile.fallbacks.find((fallback) => fallback.providerId === KOKORO_PROVIDER_ID)?.voiceId;
const withNarratorVoice = (voiceId: string): VoiceProfile => ({
  ...NARRATOR,
  fallbacks: [{ providerId: KOKORO_PROVIDER_ID, voiceId }],
});

test('the picked voice depends only on the npc id unless it collides with the narrator', () => {
  const ids = Array.from({ length: NPC_COUNT }, (_, index) => `npc-${index}`);
  const voices = KOKORO_CAPABILITIES.voices;
  const unrelated = voices.at(-1) ?? NARRATOR_VOICE;
  for (const id of ids) {
    const picked = kokoroVoiceOf(importantNpcProfile(id, NARRATOR));
    const elsewhere = kokoroVoiceOf(importantNpcProfile(id, withNarratorVoice(unrelated)));
    if (picked !== unrelated && elsewhere !== NARRATOR_VOICE) assert.equal(elsewhere, picked);
  }
});

test('a stored kokoro voice survives a narrator voice change', () => {
  const stored = importantNpcProfile('npc-7', NARRATOR);
  const storedVoice = kokoroVoiceOf(stored);
  assert.ok(storedVoice !== undefined);
  const recast = importantNpcProfile('npc-7', withNarratorVoice(storedVoice), stored);
  assert.equal(recast, stored);
});

const PORTUGUESE_NARRATOR: VoiceProfile = {
  ...NARRATOR,
  language: 'pt-BR',
  fallbacks: [{ providerId: MLX_KOKORO_PROVIDER_ID, voiceId: 'pf_dora' }],
};

test('important NPCs in a Brazilian Portuguese campaign get a pt-BR voice distinct from the narrator', () => {
  const ids = Array.from({ length: NPC_COUNT }, (_, index) => `npc-${index}`);
  const voices = ids.map((id) => {
    const [fallback] = importantNpcProfile(id, PORTUGUESE_NARRATOR).fallbacks;
    assert.equal(fallback?.providerId, MLX_KOKORO_PROVIDER_ID);
    return fallback?.voiceId;
  });
  for (const voice of voices) {
    assert.ok(voice !== undefined && MLX_KOKORO_CAPABILITIES.voices.includes(voice));
    assert.notEqual(voice, 'pf_dora');
  }
  assert.ok(new Set(voices).size > 1);
});

test('important NPCs in a language without voices keep the base profile', () => {
  const base: VoiceProfile = { ...NARRATOR, language: 'pt-PT', fallbacks: [{ providerId: 'cloud', voiceId: 'x' }] };
  assert.deepEqual(importantNpcProfile('npc-7', base), { ...base, id: 'npc-7' });
});

test('a stored profile without a kokoro voice gets one added', () => {
  const stored: VoiceProfile = { ...NARRATOR, id: 'npc-7', fallbacks: [{ providerId: 'cloud', voiceId: 'x' }] };
  const assigned = importantNpcProfile('npc-7', NARRATOR, stored);
  assert.equal(assigned.fallbacks[0]?.providerId, KOKORO_PROVIDER_ID);
  assert.deepEqual(assigned.fallbacks.slice(1), stored.fallbacks);
  assert.deepEqual(importantNpcProfile('npc-7', NARRATOR, stored), assigned);
});
