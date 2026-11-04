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

export const MODERN_ADVENTURE_PACK = {
  genre: {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: 'modern-adventure',
    version: '1.0.0',
    name: 'Modern adventure',
    archetypes: [
      { id: 'fixer', name: 'Fixer', summary: 'Knows someone in every city and owes most of them' },
      { id: 'reporter', name: 'Reporter', summary: 'Chases the story past where the police stop' },
      { id: 'pilot', name: 'Pilot', summary: 'Gets people in and out when the roads close' },
    ],
    narrativeConstraints: [
      'Keep events grounded in the present-day world',
      'Consequences follow real-world logic: injuries heal slowly, money runs out',
    ],
    examples: ['Your phone buzzes twice: a dead drop address and a flight that leaves in forty minutes.'],
    visualConventions: ['Contemporary cities', 'Natural lighting'],
    suggestedCapabilities: ['social', 'travel', 'investigation'],
  },
};

export const FANTASY_PACK = {
  genre: {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: 'fantasy',
    version: '1.0.0',
    name: 'Fantasy',
    archetypes: [
      { id: 'hedge-witch', name: 'Hedge witch', summary: 'Trades remedies for secrets at the edge of the village' },
      { id: 'exiled-knight', name: 'Exiled knight', summary: 'Keeps an oath to a lord who cast them out' },
      { id: 'river-smuggler', name: 'River smuggler', summary: 'Moves goods and people past the toll keeps' },
    ],
    narrativeConstraints: ['Wonders have a cost and a history', 'Old oaths and bloodlines shape who holds power'],
    examples: ['The standing stones hum when the moon clears the ridge, and tonight it is full.'],
    visualConventions: ['Hand-drawn maps', 'Candlelit halls'],
    suggestedCapabilities: ['travel', 'social', 'exploration'],
  },
  story: {
    tone: ['Mythic', 'Hopeful against old darkness'],
    openingScenes: [
      'A bell tolls in a drowned chapel that has been silent for a hundred years',
      'The heir to the barony arrives at your inn, alone and bleeding, asking for sanctuary',
    ],
    conflicts: [
      'Two noble houses claim the same crown after the old queen dies without a named heir',
      'The forest folk demand the return of a relic the village church keeps on its altar',
    ],
  },
};

export const SCIENCE_FICTION_PACK = {
  genre: {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: 'science-fiction',
    version: '1.0.0',
    name: 'Science fiction',
    archetypes: [
      {
        id: 'station-engineer',
        name: 'Station engineer',
        summary: 'Keeps the life support running on a failing budget',
      },
      {
        id: 'corporate-envoy',
        name: 'Corporate envoy',
        summary: 'Negotiates for a company that owns the colony charter',
      },
      { id: 'drift-salvager', name: 'Drift salvager', summary: 'Strips derelict ships and sells what still works' },
    ],
    narrativeConstraints: [
      'Distance and light-lag shape every decision',
      'Technology solves problems and creates new ones',
    ],
    examples: ['The relay pings back twelve minutes late, and the message is in your own voice.'],
    visualConventions: ['Clean interfaces', 'Starfields and hard shadows'],
    suggestedCapabilities: ['travel', 'social', 'investigation'],
  },
  story: {
    tone: ['Cerebral', 'Isolated and wondering'],
    openingScenes: [
      'Your mining tug docks at an outpost where every crew member is asleep and no one will wake',
      'A colony ship answers a hail after forty years of silence and asks for you by name',
    ],
    conflicts: [
      'The colony votes on independence while the charter company holds the only water reclaimers',
      'An artificial mind on the station asks for legal personhood before its scheduled reset',
    ],
  },
};

export const BLANK_WORLD_PACK = {
  genre: {
    contractVersion: GENREPACK_CONTRACT_VERSION,
    id: 'blank-world',
    version: '1.0.0',
    name: 'Blank world',
    archetypes: [],
    narrativeConstraints: [],
    examples: [],
    visualConventions: [],
    suggestedCapabilities: [],
  },
};
