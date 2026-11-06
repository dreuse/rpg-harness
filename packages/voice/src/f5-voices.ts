import type { CatalogGender } from './voice-catalog.ts';

export interface F5Clip {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface F5Voice {
  readonly id: string;
  readonly gender: CatalogGender;
  readonly refText: string;
  readonly seconds: number;
  readonly clip: F5Clip;
  readonly archive: string;
  readonly member: string;
  readonly source: string;
  readonly licence: string;
  readonly attribution: string;
}

export const FLEURS_REPO = 'google/fleurs';
export const FLEURS_REVISION = '70bb2e84b976b7e960aa89f1c648e09c59f894dd';
export const FLEURS_PT_BR_AUDIO_DIR = 'data/pt_br/audio';
export const FLEURS_ARCHIVE_READ_LIMIT_BYTES: Readonly<Record<string, number>> = Object.freeze({
  dev: 62_300_000,
  train: 113_200_000,
});

const VOICE_LICENCE = 'CC-BY-4.0';
const VOICE_ATTRIBUTION =
  'Google FLEURS pt_br, CC BY 4.0, anonymous read-speech volunteer. Conneau et al., FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech, arXiv:2205.12446';
const CLIP_DIR = 'voices';

const voice = (
  id: string,
  gender: CatalogGender,
  archive: string,
  file: string,
  refText: string,
  seconds: number,
  sha256: string,
  bytes: number,
): F5Voice =>
  Object.freeze({
    id,
    gender,
    refText,
    seconds,
    clip: Object.freeze({ path: `${CLIP_DIR}/${id}.wav`, sha256, bytes }),
    archive,
    member: `${archive}/${file}`,
    source: `https://huggingface.co/datasets/${FLEURS_REPO}/blob/${FLEURS_REVISION}/${FLEURS_PT_BR_AUDIO_DIR}/${archive}.tar.gz#${archive}/${file}`,
    licence: VOICE_LICENCE,
    attribution: VOICE_ATTRIBUTION,
  });

export const F5_VOICES: readonly F5Voice[] = Object.freeze([
  voice(
    'f5-pt-f1',
    'female',
    'train',
    '10037811280993524975.wav',
    'por alguns trocados algumas crianças lhe contarão a história',
    5.88,
    '3ffc02e569d3794458183d3a1912180795b86310a2be0f39538e574dad117189',
    376_378,
  ),
  voice(
    'f5-pt-f2',
    'female',
    'train',
    '11084584502097351417.wav',
    'a maioria dos hóspedes da pousada eram cidadãos dos emirados árabes unidos',
    8.16,
    'fcf372dfe679fd013fd216c16e6e80dea0ea39e7b117f5e58bd9027814168e9c',
    522_298,
  ),
  voice(
    'f5-pt-m1',
    'male',
    'dev',
    '1331833229962432141.wav',
    'os espanhóis iniciaram o período de colonização que durou três séculos',
    6.12,
    '169a25c13fe054bfde45c3adb5712b6c2ecd8c0c911fedea7c30a6d945ff6c0d',
    391_738,
  ),
  voice(
    'f5-pt-m2',
    'male',
    'dev',
    '11868703931408793172.wav',
    'você pode ver as pirâmides no escuro e também no silêncio antes de o show começar',
    8.16,
    'a593c0305f27d69f063712fceb3daeffaeda8cbcc4b5f8ee700ebafbb7ec897c',
    522_298,
  ),
]);
