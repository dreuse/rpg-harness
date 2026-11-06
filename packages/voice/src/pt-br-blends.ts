import type { VoiceBlend } from './kokoro-provider.ts';
import type { CatalogAge, CatalogGender } from './voice-catalog.ts';

export interface NamedBlend extends VoiceBlend {
  readonly id: string;
  readonly gender: CatalogGender;
  readonly ages: readonly CatalogAge[];
  readonly timbre: readonly string[];
  readonly licence: string;
}

export const PT_BR_BASE_VOICES: readonly string[] = Object.freeze(['pf_dora', 'pm_alex', 'pm_santa']);

export const KOKORO_VOICE_LICENCE = 'Apache-2.0';

const blend = (
  id: string,
  first: string,
  second: string,
  weight: number,
  gender: CatalogGender,
  ages: readonly CatalogAge[],
  timbre: readonly string[],
): NamedBlend =>
  Object.freeze({
    id,
    first,
    second,
    weight,
    gender,
    ages: Object.freeze(ages),
    timbre: Object.freeze(timbre),
    licence: KOKORO_VOICE_LICENCE,
  });

export const PT_BR_BLENDS: readonly NamedBlend[] = Object.freeze([
  blend('pf_clara', 'pf_dora', 'af_bella', 0.4, 'female', ['young'], ['bright', 'warm']),
  blend('pf_helena', 'pf_dora', 'bf_emma', 0.35, 'female', ['adult'], ['crisp', 'smooth']),
  blend('pf_marta', 'pf_dora', 'af_sarah', 0.4, 'female', ['adult'], ['warm', 'soft']),
  blend('pm_bruno', 'pm_alex', 'am_adam', 0.4, 'male', ['adult'], ['deep', 'rough']),
  blend('pm_caio', 'pm_alex', 'am_liam', 0.35, 'male', ['young'], ['light', 'bright']),
  blend('pm_otavio', 'pm_santa', 'am_onyx', 0.4, 'male', ['old'], ['deep', 'dark']),
]);

export const PT_BR_BLEND_PARTNERS: readonly string[] = Object.freeze(
  [...new Set(PT_BR_BLENDS.map(({ second }) => second))].sort(),
);

export const namedBlendOf = (voiceId: string): VoiceBlend | undefined => {
  const found = PT_BR_BLENDS.find(({ id }) => id === voiceId);
  return found && { first: found.first, second: found.second, weight: found.weight };
};
