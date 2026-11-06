import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importantNpcProfile, npcVoiceBlend, voiceBlendFor } from './cinematic.ts';
import { KOKORO_CAPABILITIES, KOKORO_DELIVERY_SPEED, KOKORO_PROVIDER_ID, kokoroSpeed } from './kokoro-provider.ts';
import { MLX_KOKORO_CAPABILITIES, MLX_KOKORO_PROVIDER_ID } from './mlx-audio-engine.ts';
import { NARRATOR_SPEAKER } from './speaker-routing.ts';
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
const ROUTE = 'mlx';

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
  const voices = ids.map((id) => importantNpcProfile(id, NARRATOR, ROUTE).fallbacks[0]?.voiceId);
  assert.deepEqual(
    voices,
    ids.map((id) => importantNpcProfile(id, NARRATOR, ROUTE).fallbacks[0]?.voiceId),
  );
  for (const voice of voices) {
    assert.ok(voice !== undefined && KOKORO_CAPABILITIES.voices.includes(voice));
    assert.notEqual(voice, NARRATOR_VOICE);
  }
  assert.ok(new Set(voices).size > 1);
});

test('the important NPC profile keeps the base profile and puts Kokoro first', () => {
  const other = { providerId: 'cloud', voiceId: 'x' };
  const profile = importantNpcProfile('npc-7', { ...NARRATOR, fallbacks: [other, ...NARRATOR.fallbacks] }, ROUTE);
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
    const picked = kokoroVoiceOf(importantNpcProfile(id, NARRATOR, ROUTE));
    const elsewhere = kokoroVoiceOf(importantNpcProfile(id, withNarratorVoice(unrelated), ROUTE));
    if (picked !== unrelated && elsewhere !== NARRATOR_VOICE) assert.equal(elsewhere, picked);
  }
});

test('a stored kokoro voice survives a narrator voice change', () => {
  const stored = importantNpcProfile('npc-7', NARRATOR, ROUTE);
  const storedVoice = kokoroVoiceOf(stored);
  assert.ok(storedVoice !== undefined);
  const recast = importantNpcProfile('npc-7', withNarratorVoice(storedVoice), ROUTE, stored);
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
    const [fallback] = importantNpcProfile(id, PORTUGUESE_NARRATOR, ROUTE).fallbacks;
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
  assert.deepEqual(importantNpcProfile('npc-7', base, ROUTE), { ...base, id: 'npc-7' });
});

test('a stored profile without a kokoro voice gets one added', () => {
  const stored: VoiceProfile = { ...NARRATOR, id: 'npc-7', fallbacks: [{ providerId: 'cloud', voiceId: 'x' }] };
  const assigned = importantNpcProfile('npc-7', NARRATOR, ROUTE, stored);
  assert.equal(assigned.fallbacks[0]?.providerId, KOKORO_PROVIDER_ID);
  assert.deepEqual(assigned.fallbacks.slice(1), stored.fallbacks);
  assert.deepEqual(importantNpcProfile('npc-7', NARRATOR, ROUTE, stored), assigned);
});

const VOICE_PREFIX_CHARS = 2;
const MIN_BLEND_WEIGHT = 0.2;
const MAX_BLEND_WEIGHT = 0.4;

test('maps a main NPC to a deterministic blend of two voices of the same accent and gender', () => {
  const voices = KOKORO_CAPABILITIES.voices;
  const blend = voiceBlendFor('npc-captain', 'af_heart', voices);
  assert.ok(blend);
  assert.deepEqual(voiceBlendFor('npc-captain', 'af_heart', voices), blend);
  assert.equal(blend.first, 'af_heart');
  assert.notEqual(blend.second, blend.first);
  assert.ok(voices.includes(blend.second));
  assert.equal(blend.second.slice(0, VOICE_PREFIX_CHARS), 'af');
  assert.ok(blend.weight >= MIN_BLEND_WEIGHT && blend.weight <= MAX_BLEND_WEIGHT);
  const seconds = new Set(
    Array.from({ length: NPC_COUNT }, (_, index) => voiceBlendFor(`npc-${index}`, 'af_heart', voices)?.second),
  );
  assert.ok(seconds.size > 1);
});

test('blends only inside the capabilities of the provider and gives no blend without a partner', () => {
  const mlx = MLX_KOKORO_CAPABILITIES.voices;
  assert.equal(voiceBlendFor('npc-captain', 'pf_dora', mlx), undefined);
  const male = voiceBlendFor('npc-captain', 'pm_alex', mlx);
  assert.equal(male?.second, 'pm_santa');
  assert.equal(voiceBlendFor('npc-captain', 'af_heart', mlx), undefined);
  assert.equal(voiceBlendFor('npc-captain', 'pf_clara', mlx), undefined);
  assert.ok(mlx.includes('pm_bruno') && male?.second === 'pm_santa');
  assert.equal(voiceBlendFor('npc-captain', 'af_heart', ['af_heart', 'af_bella'])?.second, 'af_bella');
});

test('blends NPC voices but never the narrator', () => {
  const voices = MLX_KOKORO_CAPABILITIES.voices;
  const blendFor = npcVoiceBlend(voices);
  assert.deepEqual(blendFor('npc-captain', 'pm_alex'), voiceBlendFor('npc-captain', 'pm_alex', voices));
  assert.equal(blendFor(NARRATOR_SPEAKER, 'pm_alex'), undefined);
});
