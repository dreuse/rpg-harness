export const LANGUAGES = ['en', 'pt-BR'] as const;
export const PASSAGE_KINDS = ['narration', 'npc', 'emotional'] as const;

export type Language = (typeof LANGUAGES)[number];
export type PassageKind = (typeof PASSAGE_KINDS)[number];
export type Passage = { id: string; language: Language; kind: PassageKind; text: string };

export const PASSAGES: readonly Passage[] = [
  {
    id: 'en-narration',
    language: 'en',
    kind: 'narration',
    text: 'The rain had not stopped for three days when the caravan reached the gates of Varrow. Torches hissed under the arches, and the guards watched the wagons roll past without a word. Somewhere beyond the walls, a bell rang twice, then fell silent.',
  },
  { id: 'en-npc-warning', language: 'en', kind: 'npc', text: 'Keep your voice down. The captain hears everything.' },
  { id: 'en-npc-innkeeper', language: 'en', kind: 'npc', text: 'Two silver for the room. Breakfast is extra.' },
  {
    id: 'en-emotional',
    language: 'en',
    kind: 'emotional',
    text: 'You left them there! You left them to burn, and you never even looked back!',
  },
  {
    id: 'pt-BR-narration',
    language: 'pt-BR',
    kind: 'narration',
    text: 'A chuva não parava havia três dias quando a caravana chegou aos portões de Varrow. As tochas chiavam sob os arcos, e os guardas observavam as carroças passarem sem dizer uma palavra. Em algum lugar além das muralhas, um sino tocou duas vezes e depois se calou.',
  },
  { id: 'pt-BR-npc-warning', language: 'pt-BR', kind: 'npc', text: 'Fala baixo. O capitão escuta tudo.' },
  {
    id: 'pt-BR-npc-innkeeper',
    language: 'pt-BR',
    kind: 'npc',
    text: 'Duas moedas de prata pelo quarto. O café da manhã é à parte.',
  },
  {
    id: 'pt-BR-emotional',
    language: 'pt-BR',
    kind: 'emotional',
    text: 'Você deixou eles lá! Deixou eles queimando e nem olhou para trás!',
  },
];
