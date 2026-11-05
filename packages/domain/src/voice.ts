export const NARRATOR_SPEAKER = 'narrator';

export interface VoiceFallback {
  readonly providerId: string;
  readonly voiceId: string;
}

export interface VoiceProfile {
  readonly id: string;
  readonly language: string;
  readonly pace: number;
  readonly style: string;
  readonly pronunciations: Readonly<Record<string, string>>;
  readonly fallbacks: readonly VoiceFallback[];
  readonly manner?: VoiceManner;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
export const isLocale = (value: unknown): value is string => {
  if (!isFilled(value)) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
};
const isPronunciations = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((spoken) => typeof spoken === 'string');
const toFallback = (value: unknown): VoiceFallback | undefined =>
  isRecord(value) && isFilled(value.providerId) && isFilled(value.voiceId)
    ? { providerId: value.providerId, voiceId: value.voiceId }
    : undefined;

export const toVoiceProfile = (value: unknown): VoiceProfile | undefined => {
  if (!isRecord(value)) return undefined;
  const { id, language, pace, style, pronunciations, fallbacks } = value;
  if (!isFilled(id) || !isLocale(language) || typeof style !== 'string') return undefined;
  if (typeof pace !== 'number' || !Number.isFinite(pace) || pace <= 0) return undefined;
  if (!isPronunciations(pronunciations) || !Array.isArray(fallbacks)) return undefined;
  const picked = fallbacks.map(toFallback);
  if (!picked.every((fallback) => fallback !== undefined)) return undefined;
  const manner = oneOf(VOICE_MANNERS, value.manner);
  return {
    id,
    language,
    pace,
    style,
    pronunciations: { ...pronunciations },
    fallbacks: picked,
    ...(manner === undefined ? {} : { manner }),
  };
};

export const VOICE_GENDERS = ['female', 'male', 'neutral'] as const;
export const VOICE_AGES = ['child', 'young', 'adult', 'old'] as const;
export const VOICE_MANNERS = ['warm', 'gruff', 'nervous', 'calm', 'menacing', 'cheerful'] as const;
export const VOICE_TRAITS_FIELD = 'voiceTraits';
export type VoiceGender = (typeof VOICE_GENDERS)[number];
export type VoiceAge = (typeof VOICE_AGES)[number];
export type VoiceManner = (typeof VOICE_MANNERS)[number];

export interface VoiceTraits {
  readonly gender?: VoiceGender;
  readonly age?: VoiceAge;
  readonly manner?: VoiceManner;
}

const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  options.find((option) => option === value);

export const toVoiceTraits = (value: unknown): VoiceTraits | undefined => {
  if (!isRecord(value)) return undefined;
  const gender = oneOf(VOICE_GENDERS, value.gender);
  const age = oneOf(VOICE_AGES, value.age);
  const manner = oneOf(VOICE_MANNERS, value.manner);
  const traits = {
    ...(gender === undefined ? {} : { gender }),
    ...(age === undefined ? {} : { age }),
    ...(manner === undefined ? {} : { manner }),
  };
  return Object.keys(traits).length === 0 ? undefined : traits;
};

export const MICROPHONE_MODES = ['off', 'push-to-talk', 'hands-free'] as const;
export const SPOKEN_OUTPUT_MODES = ['off', 'narrator', 'dialogue', 'full', 'cinematic'] as const;
export const MIN_VOICE_SPEED = 0.5;
export const MAX_VOICE_SPEED = 2;
export type MicrophoneMode = (typeof MICROPHONE_MODES)[number];
export type SpokenOutputMode = (typeof SPOKEN_OUTPUT_MODES)[number];
const MICROPHONE_OFF: MicrophoneMode = 'off';

export interface SavedVoiceSettings {
  readonly microphone: MicrophoneMode;
  readonly spokenOutput: SpokenOutputMode;
  readonly locale: string;
  readonly speed: number;
  readonly consentGrantedAt?: string;
  readonly npcVoices?: Readonly<Record<string, VoiceFallback>>;
}

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  options.some((option) => option === value);

const toNpcVoices = (value: unknown): Record<string, VoiceFallback> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([name, voice]) => [name, toFallback(voice)] as const);
  if (entries.some(([name, voice]) => name === '' || voice === undefined)) return undefined;
  return Object.fromEntries(entries.flatMap(([name, voice]) => (voice === undefined ? [] : [[name, voice]])));
};

export const toSavedVoiceSettings = (value: unknown): SavedVoiceSettings | undefined => {
  if (!isRecord(value)) return undefined;
  const { microphone, spokenOutput, locale, speed, consentGrantedAt, npcVoices } = value;
  if (!isOneOf(MICROPHONE_MODES, microphone) || !isOneOf(SPOKEN_OUTPUT_MODES, spokenOutput)) return undefined;
  if (!isLocale(locale) || typeof speed !== 'number' || !(speed >= MIN_VOICE_SPEED && speed <= MAX_VOICE_SPEED))
    return undefined;
  if (consentGrantedAt !== undefined && !isFilled(consentGrantedAt)) return undefined;
  if (consentGrantedAt === undefined && microphone !== MICROPHONE_OFF) return undefined;
  const voices = npcVoices === undefined ? {} : toNpcVoices(npcVoices);
  if (voices === undefined) return undefined;
  return {
    microphone,
    spokenOutput,
    locale,
    speed,
    ...(consentGrantedAt === undefined ? {} : { consentGrantedAt }),
    ...(Object.keys(voices).length === 0 ? {} : { npcVoices: voices }),
  };
};
