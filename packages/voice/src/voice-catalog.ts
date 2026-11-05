export type CatalogGender = 'female' | 'male';
export type CatalogAge = 'child' | 'young' | 'adult' | 'old';

export interface CatalogVoice {
  readonly gender: CatalogGender;
  readonly ages: readonly CatalogAge[];
  readonly timbre: readonly string[];
}

export interface MannerDelivery {
  readonly pace: number;
  readonly pitch: number;
}

export const AGE_ORDER: readonly CatalogAge[] = Object.freeze(['child', 'young', 'adult', 'old']);
export const MIN_MANNER_PACE = 0.85;
export const MAX_MANNER_PACE = 1.15;
export const MAX_MANNER_PITCH_SEMITONES = 2;
export const NEUTRAL_DELIVERY: MannerDelivery = Object.freeze({ pace: 1, pitch: 0 });

const GENDER_MARKER_INDEX = 1;
const GENDER_BY_MARKER: Readonly<Record<string, CatalogGender>> = Object.freeze({ f: 'female', m: 'male' });

const voice = (gender: CatalogGender, ages: readonly CatalogAge[], timbre: readonly string[]): CatalogVoice =>
  Object.freeze({ gender, ages: Object.freeze(ages), timbre: Object.freeze(timbre) });

export const VOICE_CATALOG: Readonly<Record<string, CatalogVoice>> = Object.freeze({
  af_heart: voice('female', ['young', 'adult'], ['warm', 'smooth']),
  af_alloy: voice('female', ['adult'], ['crisp', 'smooth']),
  af_aoede: voice('female', ['young', 'adult'], ['bright', 'smooth']),
  af_bella: voice('female', ['young'], ['warm', 'bright']),
  af_jessica: voice('female', ['young'], ['bright', 'playful']),
  af_kore: voice('female', ['young'], ['light', 'crisp']),
  af_nicole: voice('female', ['adult'], ['soft', 'smooth']),
  af_nova: voice('female', ['young', 'adult'], ['bright', 'crisp']),
  af_river: voice('female', ['adult'], ['smooth', 'soft']),
  af_sarah: voice('female', ['adult'], ['warm', 'soft']),
  af_sky: voice('female', ['young'], ['light', 'bright']),
  am_adam: voice('male', ['adult'], ['deep', 'rough']),
  am_echo: voice('male', ['young', 'adult'], ['smooth', 'crisp']),
  am_eric: voice('male', ['adult'], ['smooth', 'crisp']),
  am_fenrir: voice('male', ['adult', 'old'], ['deep', 'rough', 'dark']),
  am_liam: voice('male', ['young'], ['light', 'bright']),
  am_michael: voice('male', ['adult'], ['warm', 'smooth']),
  am_onyx: voice('male', ['adult', 'old'], ['deep', 'dark']),
  am_puck: voice('male', ['young'], ['playful', 'bright']),
  am_santa: voice('male', ['old'], ['warm', 'rough']),
  bf_emma: voice('female', ['adult'], ['crisp', 'smooth']),
  bf_isabella: voice('female', ['adult'], ['smooth', 'warm']),
  bf_alice: voice('female', ['young', 'adult'], ['crisp', 'light']),
  bf_lily: voice('female', ['young'], ['soft', 'light']),
  bm_george: voice('male', ['adult', 'old'], ['deep', 'smooth']),
  bm_lewis: voice('male', ['adult'], ['rough', 'crisp']),
  bm_daniel: voice('male', ['young', 'adult'], ['light', 'smooth']),
  bm_fable: voice('male', ['adult', 'old'], ['warm', 'soft']),
  pf_dora: voice('female', ['young', 'adult'], ['warm', 'smooth']),
  pm_alex: voice('male', ['young', 'adult'], ['crisp', 'bright']),
  pm_santa: voice('male', ['old'], ['warm', 'rough']),
});

export const MANNER_TIMBRE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  warm: ['warm', 'soft'],
  gruff: ['deep', 'rough'],
  nervous: ['light', 'bright'],
  calm: ['smooth', 'soft'],
  menacing: ['deep', 'dark'],
  cheerful: ['bright', 'playful'],
});

export const MANNER_DELIVERY: Readonly<Record<string, MannerDelivery>> = Object.freeze({
  warm: { pace: 0.95, pitch: 0 },
  gruff: { pace: 0.92, pitch: -1.5 },
  nervous: { pace: 1.12, pitch: 1 },
  calm: { pace: 0.9, pitch: 0 },
  menacing: { pace: 0.88, pitch: -2 },
  cheerful: { pace: 1.08, pitch: 1 },
});

export const catalogGenderOf = (voiceId: string): CatalogGender | undefined =>
  Object.hasOwn(VOICE_CATALOG, voiceId)
    ? VOICE_CATALOG[voiceId]?.gender
    : GENDER_BY_MARKER[voiceId.charAt(GENDER_MARKER_INDEX)];

export const mannerDelivery = (manner: string | undefined): MannerDelivery =>
  manner !== undefined && Object.hasOwn(MANNER_DELIVERY, manner)
    ? (MANNER_DELIVERY[manner] ?? NEUTRAL_DELIVERY)
    : NEUTRAL_DELIVERY;
