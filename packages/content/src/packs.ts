import { GENREPACK_CONTRACT_VERSION } from './genrepack.ts';

export const HORROR_PACK = {
  genre: {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: 'horror',
    version: '1.0.0',
    name: 'Creeping horror',
    archetypes: [
      { id: 'skeptic', name: 'Skeptic', summary: 'Explains away the impossible until it cannot be explained' },
      { id: 'survivor', name: 'Survivor', summary: 'Has seen the thing before and still has the scars' },
    ],
    narrativeConstraints: ['Show the threat indirectly before showing it fully', 'Safety tools override any scene'],
    examples: ['The scratching stopped the moment you held your breath.'],
    visualConventions: ['Low light', 'Muted palette'],
    suggestedCapabilities: ['investigation', 'tension'],
  },
  investigation: {
    tension: {
      min: 0,
      max: 10,
      start: 0,
      thresholds: [
        { at: 3, cue: 'Something is wrong and the characters feel it' },
        { at: 6, cue: 'The threat makes itself known' },
        { at: 9, cue: 'Escape or confrontation can no longer wait' },
      ],
    },
    clues: [
      { id: 'scratches', text: 'Fresh scratches inside the cellar door', pointsTo: 'cellar-entity' },
      { id: 'diary', text: 'A diary entry about voices below the floor', pointsTo: 'cellar-entity' },
      { id: 'deed', text: 'The house deed names a family that vanished', pointsTo: 'bound-family' },
      { id: 'portrait', text: 'A portrait whose faces change between visits', pointsTo: 'bound-family' },
    ],
    secrets: [
      { id: 'cellar-entity', statement: 'The entity lives in the cellar and feeds on fear' },
      { id: 'bound-family', statement: 'The vanished family is bound to the house as its servants' },
    ],
    pacing: [
      { id: 'arrival', summary: 'Settle in and notice small wrong details', requiresClues: [] },
      { id: 'descent', summary: 'Go below the house', requiresClues: ['scratches', 'diary'] },
      { id: 'reckoning', summary: 'Face what holds the house', requiresClues: ['deed', 'portrait'] },
    ],
  },
};

export const MYSTERY_PACK = {
  genre: {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: 'investigative-mystery',
    version: '1.0.0',
    name: 'Investigative mystery',
    archetypes: [
      { id: 'detective', name: 'Detective', summary: 'Reads people and rooms for what does not fit' },
      { id: 'journalist', name: 'Journalist', summary: 'Follows the story wherever it leads' },
    ],
    narrativeConstraints: ['Every solution is reachable through more than one clue', 'Play fair with the reader'],
    examples: ['The clock had been wound, but nobody admitted to touching it.'],
    visualConventions: ['Case board', 'Period detail'],
    suggestedCapabilities: ['investigation', 'social'],
  },
  investigation: {
    tension: {
      min: 0,
      max: 6,
      start: 0,
      thresholds: [
        { at: 2, cue: 'A witness grows nervous' },
        { at: 4, cue: 'The culprit starts to cover their tracks' },
        { at: 6, cue: 'A second crime is imminent' },
      ],
    },
    clues: [
      { id: 'wound-clock', text: 'The study clock was wound after the time of death', pointsTo: 'culprit' },
      { id: 'mud', text: 'Garden mud on the secretary’s shoes', pointsTo: 'culprit' },
      { id: 'will', text: 'A draft will that disinherits the secretary', pointsTo: 'motive' },
      { id: 'letter', text: 'A burned letter mentions a change to the will', pointsTo: 'motive' },
    ],
    secrets: [
      { id: 'culprit', statement: 'The secretary killed the host in the study' },
      { id: 'motive', statement: 'The secretary acted to stop the new will' },
    ],
    pacing: [
      { id: 'scene-of-crime', summary: 'Examine the study and the body', requiresClues: [] },
      { id: 'interviews', summary: 'Question the household', requiresClues: ['wound-clock'] },
      { id: 'accusation', summary: 'Confront the culprit', requiresClues: ['mud', 'will'] },
    ],
  },
};
