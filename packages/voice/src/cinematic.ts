import { voicesFor } from './language-voices.ts';
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
