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
  }),
});

const own = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined =>
  Object.hasOwn(table, name) ? table[name] : undefined;

export const selectSounds = (scene: SceneSoundInput, extension: SoundTableExtension = {}): SoundSelection => {
  const locations = { ...BASE_SOUND_TABLE.locations, ...extension.locations };
  const moods = { ...BASE_SOUND_TABLE.moods, ...extension.moods };
  const matches = scene.mood.flatMap((tag) => {
    const sounds = own(moods, tag.toLowerCase());
    return sounds === undefined ? [] : [sounds];
  });
  const ambience =
    matches.find((sounds) => sounds.ambience !== undefined)?.ambience ?? own(locations, scene.location.toLowerCase());
  const music = matches.find((sounds) => sounds.music !== undefined)?.music ?? DEFAULT_MUSIC_KEY;
  return ambience === undefined ? { music } : { ambience, music };
};
