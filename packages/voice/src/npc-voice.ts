import { createHash } from 'node:crypto';
import { type KokoroCapabilities, speaksLanguage } from './kokoro-provider.ts';
import type { TtsProvider } from './tts.ts';
import type { VoiceProfile } from './voice.ts';

export type InstalledVoice = VoiceProfile['fallbacks'][number];
export type VoiceGender = 'female' | 'male';

export interface VoiceHint {
  readonly gender?: string | undefined;
}

export interface PickInput {
  readonly campaignId: string;
  readonly entityId: string;
  readonly voices: readonly InstalledVoice[];
  readonly hint?: VoiceHint | undefined;
}

export interface NpcVoicesOptions {
  readonly campaignId: string;
  readonly language: string;
  readonly base: VoiceProfile;
  readonly installed: () => readonly InstalledVoice[];
  readonly stored: (speakerId: string) => VoiceProfile | undefined;
  readonly assign: (speakerId: string, profile: VoiceProfile) => void;
  readonly hintOf: (speakerId: string) => VoiceHint | undefined;
  readonly notify: (message: string) => void;
}

const GENDER_BY_MARKER: Readonly<Record<string, VoiceGender>> = Object.freeze({ f: 'female', m: 'male' });
const GENDER_MARKER_INDEX = 1;
const HASH_ALGORITHM = 'sha256';
const HASH_SEPARATOR = '\0';
const HASH_PREFIX_BYTES = 4;
const NO_HINT: VoiceHint = Object.freeze({});

const genderOf = ({ voiceId }: InstalledVoice): VoiceGender | undefined =>
  GENDER_BY_MARKER[voiceId.charAt(GENDER_MARKER_INDEX)];

const identityOf = ({ providerId, voiceId }: InstalledVoice): string => `${providerId}/${voiceId}`;

const byIdentity = (a: InstalledVoice, b: InstalledVoice): number => {
  const [left, right] = [identityOf(a), identityOf(b)];
  return left < right ? -1 : left > right ? 1 : 0;
};

const indexOf = (campaignId: string, entityId: string, size: number): number =>
  createHash(HASH_ALGORITHM)
    .update(`${campaignId}${HASH_SEPARATOR}${entityId}`)
    .digest()
    .readUIntBE(0, HASH_PREFIX_BYTES) % size;

const matching = (voices: readonly InstalledVoice[], gender: string | undefined): readonly InstalledVoice[] => {
  if (gender === undefined) return voices;
  const same = voices.filter((voice) => genderOf(voice) === gender);
  return same.length > 0 ? same : voices;
};

export const pickVoice = ({ campaignId, entityId, voices, hint = NO_HINT }: PickInput): InstalledVoice | undefined => {
  const pool = matching([...voices].sort(byIdentity), hint.gender);
  return pool[indexOf(campaignId, entityId, pool.length)];
};

type CapableProvider = TtsProvider & { readonly capabilities?: KokoroCapabilities };

export const installedVoices = (providers: readonly CapableProvider[], language: string): readonly InstalledVoice[] =>
  providers.flatMap(({ id, healthy, capabilities }) =>
    healthy?.() === false || capabilities === undefined || !speaksLanguage(capabilities, language)
      ? []
      : capabilities.voices.map((voiceId) => ({ providerId: id, voiceId })),
  );

const isInstalled = (installed: readonly InstalledVoice[], { providerId, voiceId }: InstalledVoice): boolean =>
  installed.some((voice) => voice.providerId === providerId && voice.voiceId === voiceId);

const wantedGender = (profile: VoiceProfile): VoiceGender | undefined =>
  profile.fallbacks.map(genderOf).find((gender) => gender !== undefined);

export const createNpcVoices = (options: NpcVoicesOptions) => {
  const { campaignId, language, base, installed, stored, assign, hintOf, notify } = options;
  const told = new Set<string>();

  const assigned = (speakerId: string): VoiceProfile | undefined => {
    const picked = pickVoice({ campaignId, entityId: speakerId, voices: installed(), hint: hintOf(speakerId) });
    if (picked === undefined) return undefined;
    const profile = { ...base, id: speakerId, language, fallbacks: [picked] };
    assign(speakerId, profile);
    return profile;
  };

  const available = (profile: VoiceProfile, speakerId: string): VoiceProfile => {
    const voices = installed();
    if (profile.fallbacks.some((fallback) => isInstalled(voices, fallback))) return profile;
    const substitute = pickVoice({
      campaignId,
      entityId: speakerId,
      voices,
      hint: { gender: wantedGender(profile) },
    });
    if (substitute === undefined) return profile;
    if (!told.has(speakerId)) {
      told.add(speakerId);
      notify('A character voice is not installed, so a similar voice is used for this session.');
    }
    return { ...profile, fallbacks: [substitute, ...profile.fallbacks] };
  };

  const profileOf = (speakerId: string): VoiceProfile | undefined => {
    const profile = stored(speakerId);
    return profile === undefined ? assigned(speakerId) : available(profile, speakerId);
  };

  return { profileOf };
};
