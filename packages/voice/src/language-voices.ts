import {
  KOKORO_CAPABILITIES,
  KOKORO_ONNX_PROVIDER_ID,
  KOKORO_PROVIDER_ID,
  type KokoroCapabilities,
  MLX_KOKORO_CAPABILITIES,
  MLX_KOKORO_PROVIDER_ID,
  speaksLanguage,
} from './kokoro-provider.ts';
import type { PtBrRoute } from './pt-br-route.ts';
import type { TtsProvider } from './tts.ts';
import type { VoiceProfile } from './voice.ts';

export interface LanguageVoices {
  readonly providerId: string;
  readonly capabilities: KokoroCapabilities;
  readonly narrator: string;
}

const PT_BR_PROVIDER_IDS: Readonly<Record<PtBrRoute, string>> = Object.freeze({
  mlx: MLX_KOKORO_PROVIDER_ID,
  onnx: KOKORO_ONNX_PROVIDER_ID,
});

export const languageVoicesFor = (route: PtBrRoute): readonly LanguageVoices[] =>
  Object.freeze([
    { providerId: KOKORO_PROVIDER_ID, capabilities: KOKORO_CAPABILITIES, narrator: 'af_heart' },
    { providerId: PT_BR_PROVIDER_IDS[route], capabilities: MLX_KOKORO_CAPABILITIES, narrator: 'pf_dora' },
  ]);

const NOTICE_LOCALE = 'en';

const languageName = (language: string): string => {
  try {
    return new Intl.DisplayNames(NOTICE_LOCALE, { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
};

export const voicesFor = (language: string, route: PtBrRoute): LanguageVoices | undefined =>
  languageVoicesFor(route).find((entry) => speaksLanguage(entry.capabilities, language));

export const voiceLocaleFor = (campaignLanguage: string, fallback: string): string =>
  voicesFor(campaignLanguage, 'mlx') === undefined ? fallback : campaignLanguage;

export const narratorFallback = (language: string, route: PtBrRoute): VoiceProfile['fallbacks'][number] | undefined => {
  const voices = voicesFor(language, route);
  return voices && { providerId: voices.providerId, voiceId: voices.narrator };
};

export const noVoiceNotice = (
  language: string,
  providers: readonly Pick<TtsProvider, 'id' | 'healthy'>[],
  route: PtBrRoute,
): string | undefined => {
  const voices = voicesFor(language, route);
  const name = languageName(language);
  if (!voices) return `No spoken voice exists for ${name} yet. The story stays in text.`;
  const provider = providers.find((candidate) => candidate.id === voices.providerId);
  if (provider && provider.healthy?.() !== false) return undefined;
  return `${name} voices are not available on this computer. The story stays in text.`;
};
