export interface SceneSoundInput {
  readonly location: string;
  readonly mood: readonly string[];
}

export interface SoundSelection {
  readonly ambience?: string;
  readonly music: string;
}

export interface MoodSounds {
  readonly ambience?: string;
  readonly music?: string;
}

export interface SoundTable {
  readonly locations: Readonly<Record<string, string>>;
  readonly moods: Readonly<Record<string, MoodSounds>>;
}

export type SoundTableExtension = Partial<SoundTable>;

export const DEFAULT_MUSIC_KEY = 'calm';

export const BASE_SOUND_TABLE: SoundTable = Object.freeze({
  locations: Object.freeze({
    tavern: 'tavern',
    inn: 'tavern',
    forest: 'forest',
    woods: 'forest',
    city: 'city',
    town: 'city',
    village: 'city',
    market: 'city',
    cave: 'cave',
    dungeon: 'cave',
    ruins: 'cave',
    sea: 'sea',
    harbour: 'sea',
    harbor: 'sea',
    coast: 'sea',
    ship: 'sea',
    storm: 'storm',
    river: 'stream',
    stream: 'stream',
    brook: 'stream',
    castle: 'city',
    keep: 'city',
    fortress: 'city',
    courtyard: 'city',
    road: 'forest',
    path: 'forest',
    trail: 'forest',
    plains: 'forest',
    meadow: 'forest',
    docks: 'sea',
    dock: 'sea',
    pier: 'sea',
    port: 'sea',
    wharf: 'sea',
    taverna: 'tavern',
    estalagem: 'tavern',
    floresta: 'forest',
    mata: 'forest',
    cidade: 'city',
    vila: 'city',
    mercado: 'city',
    caverna: 'cave',
    masmorra: 'cave',
    ruinas: 'cave',
    mar: 'sea',
    porto: 'sea',
    cais: 'sea',
    navio: 'sea',
    tempestade: 'storm',
    rio: 'stream',
    riacho: 'stream',
    castelo: 'city',
    fortaleza: 'city',
    patio: 'city',
    estrada: 'forest',
    caminho: 'forest',
    trilha: 'forest',
    planicie: 'forest',
    campo: 'forest',
    doca: 'sea',
  }),
  moods: Object.freeze({
    combat: { ambience: 'battle', music: 'combat' },
    battle: { ambience: 'battle', music: 'combat' },
    tense: { ambience: 'tension', music: 'tension' },
    tension: { ambience: 'tension', music: 'tension' },
    suspense: { ambience: 'tension', music: 'tension' },
    exploration: { music: 'exploration' },
    travel: { music: 'exploration' },
    rain: { ambience: 'rain' },
    calm: { music: 'calm' },
    combate: { ambience: 'battle', music: 'combat' },
    batalha: { ambience: 'battle', music: 'combat' },
    tenso: { ambience: 'tension', music: 'tension' },
    tensao: { ambience: 'tension', music: 'tension' },
    exploracao: { music: 'exploration' },
    viagem: { music: 'exploration' },
    chuva: { ambience: 'rain' },
    calmo: { music: 'calm' },
  }),
});

const WORD_SEPARATOR = /[^\p{L}]+/u;

const DIACRITICS = /\p{M}/gu;

const fold = (text: string): string => text.normalize('NFD').replace(DIACRITICS, '').toLowerCase();

const foldKeys = <T>(table: Readonly<Record<string, T>> = {}): Record<string, T> =>
  Object.fromEntries(Object.entries(table).map(([key, value]) => [fold(key), value]));

const own = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined =>
  Object.hasOwn(table, name) ? table[name] : undefined;

export const selectSounds = (scene: SceneSoundInput, extension: SoundTableExtension = {}): SoundSelection => {
  const locations = { ...BASE_SOUND_TABLE.locations, ...foldKeys(extension.locations) };
  const moods = { ...BASE_SOUND_TABLE.moods, ...foldKeys(extension.moods) };
  const matches = scene.mood.flatMap((tag) => {
    const sounds = own(moods, fold(tag));
    return sounds === undefined ? [] : [sounds];
  });
  const locationWords = fold(scene.location).split(WORD_SEPARATOR).filter(Boolean);
  const fromLocation = locationWords.map((word) => own(locations, word)).find((key) => key !== undefined);
  const ambience = matches.find((sounds) => sounds.ambience !== undefined)?.ambience ?? fromLocation;
  const music = matches.find((sounds) => sounds.music !== undefined)?.music ?? DEFAULT_MUSIC_KEY;
  return ambience === undefined ? { music } : { ambience, music };
};

export interface SceneSoundTags {
  readonly locationKind?: string;
  readonly moodTags?: readonly string[];
}

export const sceneSoundOf = (title: string | undefined, tags: SceneSoundTags = {}): SceneSoundInput => {
  const words = fold(title ?? '')
    .split(WORD_SEPARATOR)
    .filter(Boolean);
  const fromTitle = words.find((word) => Object.hasOwn(BASE_SOUND_TABLE.locations, word)) ?? '';
  if (tags.locationKind === undefined && tags.moodTags === undefined) return { location: fromTitle, mood: words };
  return { location: tags.locationKind ?? fromTitle, mood: tags.moodTags ?? [] };
};
