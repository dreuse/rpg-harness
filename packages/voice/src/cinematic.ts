import { KOKORO_CAPABILITIES, KOKORO_PROVIDER_ID } from './kokoro-provider.ts';
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

const voiceFor = (npcId: string, avoided: string | undefined): string => {
  const voices = KOKORO_CAPABILITIES.voices;
  const index = hashOf(npcId) % voices.length;
  const picked = voices[index] ?? '';
  return picked === avoided ? (voices[(index + NEXT_VOICE) % voices.length] ?? picked) : picked;
};

export const importantNpcProfile = (npcId: string, base: VoiceProfile, stored?: VoiceProfile): VoiceProfile => {
  if (stored !== undefined && selectVoiceId(stored, KOKORO_PROVIDER_ID) !== undefined) return stored;
  const source = stored ?? { ...base, id: npcId };
  return {
    ...source,
    fallbacks: [
      { providerId: KOKORO_PROVIDER_ID, voiceId: voiceFor(npcId, selectVoiceId(base, KOKORO_PROVIDER_ID)) },
      ...source.fallbacks.filter((fallback) => fallback.providerId !== KOKORO_PROVIDER_ID),
    ],
  };
};
