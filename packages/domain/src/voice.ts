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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isLocale = (value: unknown): value is string => {
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
  return { id, language, pace, style, pronunciations: { ...pronunciations }, fallbacks: picked };
};
