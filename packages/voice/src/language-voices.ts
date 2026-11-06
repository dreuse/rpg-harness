import { type Catalog, createTranslator, DEFAULT_LOCALE } from '../../client-protocol/src/locale.ts';
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

export const VOICE_NOTICE_CATALOG: Catalog = {
  en: {
    'voice.none': 'No spoken voice exists for {name} yet. The story stays in text.',
    'voice.unavailable': '{name} voices are not available on this computer. The story stays in text.',
  },
  es: {
    'voice.none': 'Aún no existe una voz hablada para {name}. La historia sigue en texto.',
    'voice.unavailable': 'Las voces en {name} no están disponibles en este equipo. La historia sigue en texto.',
  },
  'pt-BR': {
    'voice.none': 'Ainda não existe voz falada para {name}. A história continua em texto.',
    'voice.unavailable': 'As vozes em {name} não estão disponíveis neste computador. A história continua em texto.',
  },
};

const translate = createTranslator(VOICE_NOTICE_CATALOG);

const languageName = (language: string, locale: string): string => {
  try {
    return new Intl.DisplayNames(locale, { type: 'language' }).of(language) ?? language;
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
  locale = DEFAULT_LOCALE,
): string | undefined => {
  const voices = voicesFor(language, route);
  const name = languageName(language, locale);
  if (!voices) return translate(locale, 'voice.none', { name });
  const provider = providers.find((candidate) => candidate.id === voices.providerId);
  if (provider && provider.healthy?.() !== false) return undefined;
  return translate(locale, 'voice.unavailable', { name });
};
