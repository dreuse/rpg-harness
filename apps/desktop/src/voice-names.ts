import { KOKORO_ONNX_PROVIDER_ID, KOKORO_PROVIDER_ID } from '../../../packages/voice/src/kokoro-provider.ts';
import { translate } from './accessibility.ts';

export const BRAZILIAN_PROVIDER_ID = 'kokoro-mlx';
const CHATTERBOX_ID = 'chatterbox';
const F5_ID = 'f5-tts';

type VoiceName = { readonly name?: string; readonly kind: string };

const US_FEMALE = 'us-female';
const US_MALE = 'us-male';
const UK_FEMALE = 'uk-female';
const UK_MALE = 'uk-male';
const BR_FEMALE = 'br-female';
const BR_MALE = 'br-male';
const NOT_LISTED = -1;
const FIRST_NUMBER = 1;

export const VOICE_NAMES: Readonly<Record<string, VoiceName>> = Object.freeze({
  [KOKORO_PROVIDER_ID]: { kind: 'builtIn' },
  [BRAZILIAN_PROVIDER_ID]: { kind: 'brazilian' },
  [KOKORO_ONNX_PROVIDER_ID]: { kind: 'brazilian' },
  [CHATTERBOX_ID]: { kind: 'expressive' },
  [F5_ID]: { kind: 'expressive' },
  af_heart: { name: 'Heart', kind: US_FEMALE },
  af_alloy: { name: 'Alloy', kind: US_FEMALE },
  af_aoede: { name: 'Aoede', kind: US_FEMALE },
  af_bella: { name: 'Bella', kind: US_FEMALE },
  af_jessica: { name: 'Jessica', kind: US_FEMALE },
  af_kore: { name: 'Kore', kind: US_FEMALE },
  af_nicole: { name: 'Nicole', kind: US_FEMALE },
  af_nova: { name: 'Nova', kind: US_FEMALE },
  af_river: { name: 'River', kind: US_FEMALE },
  af_sarah: { name: 'Sarah', kind: US_FEMALE },
  af_sky: { name: 'Sky', kind: US_FEMALE },
  am_adam: { name: 'Adam', kind: US_MALE },
  am_echo: { name: 'Echo', kind: US_MALE },
  am_eric: { name: 'Eric', kind: US_MALE },
  am_fenrir: { name: 'Fenrir', kind: US_MALE },
  am_liam: { name: 'Liam', kind: US_MALE },
  am_michael: { name: 'Michael', kind: US_MALE },
  am_onyx: { name: 'Onyx', kind: US_MALE },
  am_puck: { name: 'Puck', kind: US_MALE },
  am_santa: { name: 'Santa', kind: US_MALE },
  bf_emma: { name: 'Emma', kind: UK_FEMALE },
  bf_isabella: { name: 'Isabella', kind: UK_FEMALE },
  bf_alice: { name: 'Alice', kind: UK_FEMALE },
  bf_lily: { name: 'Lily', kind: UK_FEMALE },
  bm_george: { name: 'George', kind: UK_MALE },
  bm_lewis: { name: 'Lewis', kind: UK_MALE },
  bm_daniel: { name: 'Daniel', kind: UK_MALE },
  bm_fable: { name: 'Fable', kind: UK_MALE },
  pf_dora: { name: 'Dora', kind: BR_FEMALE },
  pm_alex: { name: 'Alex', kind: BR_MALE },
  pm_santa: { name: 'Santa', kind: BR_MALE },
  pf_clara: { name: 'Clara', kind: BR_FEMALE },
  pf_helena: { name: 'Helena', kind: BR_FEMALE },
  pf_marta: { name: 'Marta', kind: BR_FEMALE },
  pm_bruno: { name: 'Bruno', kind: BR_MALE },
  pm_caio: { name: 'Caio', kind: BR_MALE },
  pm_otavio: { name: 'Otávio', kind: BR_MALE },
  pf_luiza: { name: 'Luiza', kind: BR_FEMALE },
  pf_beatriz: { name: 'Beatriz', kind: BR_FEMALE },
  pm_davi: { name: 'Davi', kind: BR_MALE },
  pm_henrique: { name: 'Henrique', kind: BR_MALE },
});

const named = (id: string) => (Object.hasOwn(VOICE_NAMES, id) ? VOICE_NAMES[id] : undefined);

const numbered = (locale: string, key: string, id: string, listed: readonly string[]) => {
  const index = listed.indexOf(id);
  return translate(locale, index === NOT_LISTED ? `${key}.other` : key, { number: index + FIRST_NUMBER });
};

export const providerName = (locale: string, id: string, listed: readonly string[]) => {
  const known = named(id);
  return known === undefined
    ? numbered(locale, 'voice.unknownProvider', id, listed)
    : translate(locale, `voice.kind.${known.kind}`);
};

export const voiceName = (locale: string, id: string, listed: readonly string[]) => {
  const known = named(id);
  return known?.name === undefined
    ? numbered(locale, 'voice.unknownVoice', id, listed)
    : translate(locale, 'voice.named', { name: known.name, kind: translate(locale, `voice.kind.${known.kind}`) });
};

export const packName = (locale: string, id: string, size: number) => {
  const kind = named(id)?.kind;
  return translate(locale, kind === undefined ? 'voice.pack' : `voice.pack.${kind}`, { size });
};
