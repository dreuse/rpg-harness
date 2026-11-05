import { createHash } from 'node:crypto';
import { type KokoroCapabilities, speaksLanguage } from './kokoro-provider.ts';
import type { TtsProvider } from './tts.ts';
import type { VoiceProfile } from './voice.ts';
import {
  AGE_ORDER,
  type CatalogAge,
  catalogGenderOf,
  MANNER_DELIVERY,
  MANNER_TIMBRE,
  VOICE_CATALOG,
} from './voice-catalog.ts';

export type InstalledVoice = VoiceProfile['fallbacks'][number];

export interface VoiceHint {
  readonly gender?: string | undefined;
  readonly age?: string | undefined;
  readonly manner?: string | undefined;
}

export interface PickInput {
  readonly campaignId: string;
  readonly entityId: string;
  readonly voices: readonly InstalledVoice[];
  readonly hint?: VoiceHint | undefined;
  readonly taken?: readonly InstalledVoice[] | undefined;
}

export interface NpcVoicesOptions {
  readonly campaignId: string;
  readonly language: string;
  readonly base: VoiceProfile;
  readonly installed: () => readonly InstalledVoice[];
  readonly stored: (speakerId: string) => VoiceProfile | undefined;
  readonly assign: (speakerId: string, profile: VoiceProfile) => void;
  readonly hintOf: (speakerId: string) => VoiceHint | undefined;
  readonly takenBy?: ((speakerId: string) => readonly InstalledVoice[]) | undefined;
  readonly notify: (message: string) => void;
}

const AGE_WEIGHT = 2;
const NO_TAKEN: readonly InstalledVoice[] = Object.freeze([]);
const HASH_ALGORITHM = 'sha256';
const HASH_SEPARATOR = '\0';
const HASH_PREFIX_BYTES = 4;
const NO_HINT: VoiceHint = Object.freeze({});

const genderOf = ({ voiceId }: InstalledVoice): string | undefined => catalogGenderOf(voiceId);

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

const unused = (voices: readonly InstalledVoice[], taken: readonly InstalledVoice[]): readonly InstalledVoice[] => {
  const free = voices.filter((voice) => !taken.some((other) => identityOf(other) === identityOf(voice)));
  return free.length > 0 ? free : voices;
};

const ageDistance = (ages: readonly CatalogAge[], wanted: string): number =>
  Math.min(...ages.map((age) => Math.abs(AGE_ORDER.indexOf(age) - AGE_ORDER.indexOf(wanted as CatalogAge))));

const scoreOf = ({ voiceId }: InstalledVoice, { age, manner }: VoiceHint): number => {
  const entry = Object.hasOwn(VOICE_CATALOG, voiceId) ? VOICE_CATALOG[voiceId] : undefined;
  if (entry === undefined) return 0;
  const ageScore =
    age !== undefined && AGE_ORDER.some((known) => known === age) ? -AGE_WEIGHT * ageDistance(entry.ages, age) : 0;
  const words = manner !== undefined && Object.hasOwn(MANNER_TIMBRE, manner) ? (MANNER_TIMBRE[manner] ?? []) : [];
  return ageScore + entry.timbre.filter((word) => words.includes(word)).length;
};

const bestMatches = (voices: readonly InstalledVoice[], hint: VoiceHint): readonly InstalledVoice[] => {
  const scores = voices.map((voice) => scoreOf(voice, hint));
  const best = Math.max(...scores);
  return voices.filter((_, index) => scores[index] === best);
};

export const pickVoice = ({
  campaignId,
  entityId,
  voices,
  hint = NO_HINT,
  taken = NO_TAKEN,
}: PickInput): InstalledVoice | undefined => {
  const sorted = matching([...voices].sort(byIdentity), hint.gender);
  if (sorted.length === 0) return undefined;
  const pool = bestMatches(unused(sorted, taken), hint);
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

const wantedGender = (profile: VoiceProfile): string | undefined =>
  profile.fallbacks.map(genderOf).find((gender) => gender !== undefined);

const mannerOf = (manner: string | undefined): VoiceProfile['manner'] =>
  manner !== undefined && Object.hasOwn(MANNER_DELIVERY, manner) ? (manner as VoiceProfile['manner']) : undefined;

export const createNpcVoices = (options: NpcVoicesOptions) => {
  const { campaignId, language, base, installed, stored, assign, hintOf, takenBy, notify } = options;
  const told = new Set<string>();

  const assigned = (speakerId: string): VoiceProfile | undefined => {
    const hint = hintOf(speakerId);
    const taken = takenBy?.(speakerId);
    const picked = pickVoice({ campaignId, entityId: speakerId, voices: installed(), hint, taken });
    if (picked === undefined) return undefined;
    const manner = mannerOf(hint?.manner);
    const profile = {
      ...base,
      id: speakerId,
      language,
      fallbacks: [picked],
      ...(manner === undefined ? {} : { manner }),
    };
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
