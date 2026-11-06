import { type Catalog, createTranslator } from './locale.ts';
import type { StoryMemory, StoryMemoryEntry, StoryMemoryGroup } from './protocol.ts';

export const STORY_MEMORY_GROUPS: readonly StoryMemoryGroup[] = ['person', 'place', 'thread'];

export const STORY_MEMORY_CATALOG: Catalog = {
  en: {
    'memory.heading': 'What the story remembers',
    'memory.group.person': 'People',
    'memory.group.place': 'Places',
    'memory.group.thread': 'Threads',
    'memory.empty': 'The story has not remembered anything yet.',
    'memory.unavailable': 'The story memory is not available right now.',
    'memory.corrected': 'corrected',
    'memory.correct': 'Correct this fact',
    'memory.value': 'New value',
    'memory.applied': 'Corrected: {fact}',
    'memory.rejected': 'The correction was refused: {reason}',
    'memory.usage': 'Type /memory <number> <new value> to correct a fact.',
    'memory.unknown': 'There is no fact number {index}.',
  },
  es: {
    'memory.heading': 'Lo que recuerda la historia',
    'memory.group.person': 'Personas',
    'memory.group.place': 'Lugares',
    'memory.group.thread': 'Hilos',
    'memory.empty': 'La historia aún no recuerda nada.',
    'memory.unavailable': 'La memoria de la historia no está disponible ahora.',
    'memory.corrected': 'corregido',
    'memory.correct': 'Corregir este dato',
    'memory.value': 'Nuevo valor',
    'memory.applied': 'Corregido: {fact}',
    'memory.rejected': 'Se rechazó la corrección: {reason}',
    'memory.usage': 'Escribe /memoria <número> <nuevo valor> para corregir un dato.',
    'memory.unknown': 'No existe el dato número {index}.',
  },
  'pt-BR': {
    'memory.heading': 'O que a história lembra',
    'memory.group.person': 'Pessoas',
    'memory.group.place': 'Lugares',
    'memory.group.thread': 'Fios',
    'memory.empty': 'A história ainda não lembra de nada.',
    'memory.unavailable': 'A memória da história não está disponível agora.',
    'memory.corrected': 'corrigido',
    'memory.correct': 'Corrigir este fato',
    'memory.value': 'Novo valor',
    'memory.applied': 'Corrigido: {fact}',
    'memory.rejected': 'A correção foi recusada: {reason}',
    'memory.usage': 'Digite /memoria <número> <novo valor> para corrigir um fato.',
    'memory.unknown': 'Não existe o fato número {index}.',
  },
};

export const storyMemoryText = createTranslator(STORY_MEMORY_CATALOG);

export const storyFactText = ({ entityName, kind, key, value }: StoryMemoryEntry): string =>
  `${entityName} - ${key === '' ? kind : `${kind} ${key}`}: ${value}`;

export const storyFacts = (memory: StoryMemory): readonly StoryMemoryEntry[] =>
  STORY_MEMORY_GROUPS.flatMap((group) => memory[group]);
