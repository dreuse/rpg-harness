import type { VoiceBlend } from './kokoro-provider.ts';
import { voicesFor } from './language-voices.ts';
import { NARRATOR_SPEAKER } from './speaker-routing.ts';
import { selectVoiceId } from './tts.ts';
import type { VoiceProfile } from './voice.ts';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const hashOf = (text: string): number => {
  let hash = FNV_OFFSET;
  for (const character of text) hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), FNV_PRIME) >>> 0;
  return hash;
};

const NEXT_VOICE = 1;

const voiceFor = (voices: readonly string[], npcId: string, avoided: string | undefined): string => {
  const index = hashOf(npcId) % voices.length;
  const picked = voices[index] ?? '';
  return picked === avoided ? (voices[(index + NEXT_VOICE) % voices.length] ?? picked) : picked;
};

export const importantNpcProfile = (npcId: string, base: VoiceProfile, stored?: VoiceProfile): VoiceProfile => {
  const language = voicesFor(base.language);
  const source = stored ?? { ...base, id: npcId };
  if (!language) return source;
  const { providerId, capabilities } = language;
  if (stored !== undefined && selectVoiceId(stored, providerId) !== undefined) return stored;
  return {
    ...source,
    fallbacks: [
      { providerId, voiceId: voiceFor(capabilities.voices, npcId, selectVoiceId(base, providerId)) },
      ...source.fallbacks.filter((fallback) => fallback.providerId !== providerId),
    ],
  };
};

const VOICE_FAMILY_CHARS = 2;
const BLEND_WEIGHTS = Object.freeze([0.2, 0.25, 0.3, 0.35, 0.4]);
const WEIGHT_HASH_SHIFT = 8;

export const voiceBlendFor = (npcId: string, voiceId: string, voices: readonly string[]): VoiceBlend | undefined => {
  const family = voiceId.slice(0, VOICE_FAMILY_CHARS);
  const partners = voices.filter((voice) => voice !== voiceId && voice.startsWith(family));
  if (!voices.includes(voiceId) || partners.length === 0) return undefined;
  const hash = hashOf(npcId);
  const second = partners[hash % partners.length];
  const weight = BLEND_WEIGHTS[(hash >>> WEIGHT_HASH_SHIFT) % BLEND_WEIGHTS.length];
  return second === undefined || weight === undefined ? undefined : { first: voiceId, second, weight };
};

export const npcVoiceBlend =
  (voices: readonly string[]) =>
  (speakerId: string, voiceId: string): VoiceBlend | undefined =>
    speakerId === NARRATOR_SPEAKER ? undefined : voiceBlendFor(speakerId, voiceId, voices);
