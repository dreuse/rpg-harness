import { DEFAULT_WHO_ROLLS, WHO_ROLLS } from '../../domain/src/gm.ts';
import {
  DEFAULT_RULES_STRICTNESS,
  DEFAULT_RULES_USAGE,
  isRulesStrictness,
  MAX_RULES_DOCUMENTS,
  MAX_RULES_NAME_LENGTH,
  RULES_STRICTNESSES,
  type RulesUsage,
  usesDice,
  usesSheet,
} from '../../domain/src/rules-usage.ts';
import { isLocale } from '../../domain/src/voice.ts';
import { type ContentKind, contentText, hasContentNames } from './content-names.ts';
import { type Catalog, createTranslator, DEFAULT_LOCALE, safeLocale } from './locale.ts';
import {
  type CampaignPlan,
  type CampaignPlay,
  type CreateCampaign,
  MAX_CAMPAIGN_NAME_LENGTH,
  MAX_INPUT_LENGTH,
  type PlanCampaign,
  PROTOCOL_VERSION,
  type Result,
  type StartOptions,
} from './protocol.ts';

export const START_DRAFT_FILE = 'guided-start.json';
export const START_PATHS = ['describe', 'guide'] as const;
export const GUIDE_STEPS = ['primer', 'genre', 'rules', 'character', 'features', 'begin', 'summary'] as const;
export const START_STEPS = { describe: ['describe', 'begin', 'summary'], guide: GUIDE_STEPS } as const;
const PLAY_FIELDS = ['language', 'narratorVoice', 'whoRolls', 'rulesStrictness'] as const;
export const RULES_SOURCE_FIELD = 'rulesSource';
export const OWN_RULES_FIELD = 'ownRules';
export const RULES_SOURCES = ['own', 'none'] as const;
const RULES_SOURCE_FIELDS = [RULES_SOURCE_FIELD, OWN_RULES_FIELD] as const;
const OWN_RULES_USAGE: RulesUsage = { resolution: 'dice', sheet: 'none' };
const NONE_RULES_USAGE: RulesUsage = { resolution: 'adjudicated', sheet: 'none' };
const OWN_FILES_VALUE = 'my own files';
export const FEATURES = ['diceVisualization', 'voiceOutput', 'simulation'] as const;

export type StartPath = (typeof START_PATHS)[number];
export type Feature = (typeof FEATURES)[number];
export type StartStep = 'path' | (typeof START_STEPS)[StartPath][number];
export type StartDraft = {
  readonly path: StartPath | null;
  readonly step: number;
  readonly name: string;
  readonly intent: string;
  readonly choices: Readonly<Record<string, unknown>>;
};
export type StartAction =
  | { readonly kind: 'path'; readonly path: StartPath }
  | { readonly kind: 'choose'; readonly field: string; readonly value: unknown }
  | { readonly kind: 'set'; readonly field: string; readonly value: unknown }
  | { readonly kind: 'preview'; readonly voice: string }
  | { readonly kind: 'toggle'; readonly field: Feature; readonly on?: boolean }
  | { readonly kind: 'enter'; readonly text: string }
  | { readonly kind: 'edit'; readonly step: number }
  | { readonly kind: 'next' | 'skip' | 'back' | 'start' };
export type StartOption = {
  readonly label: string;
  readonly detail: string;
  readonly action: StartAction;
  readonly selected: boolean;
  readonly badge?: string;
  readonly group?: string;
  readonly preview?: StartAction;
};
export type StartVoices = { readonly ids: readonly string[]; readonly current: string | undefined };
export type StartReviewItem = {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly chosen: boolean;
  readonly step: number;
};
export type StartReviewGroup = { readonly title: string; readonly items: readonly StartReviewItem[] };
export type StartScreen = {
  readonly step: StartStep;
  readonly title: string;
  readonly text: readonly string[];
  readonly notes?: readonly string[];
  readonly options: readonly StartOption[];
  readonly entry?: { readonly label: string; readonly value: string };
  readonly review?: readonly StartReviewGroup[];
  readonly error?: string;
  readonly importHint?: string;
  readonly progress?: { readonly current: number; readonly total: number };
  readonly canBack: boolean;
  readonly canSkip: boolean;
  readonly canNext: boolean;
  readonly canStart: boolean;
};

export const INITIAL_DRAFT: StartDraft = Object.freeze({ path: null, step: 0, name: '', intent: '', choices: {} });

export const START_CATALOG: Catalog = {
  en: {
    'name.default': 'My adventure',
    'primer.title': 'What is a tabletop RPG?',
    'primer.play': 'In a tabletop role-playing game, you play one character in a story you tell together.',
    'primer.gm': 'The game master, or GM, describes the world, plays everyone else and decides what happens.',
    'import.rulebook': 'Import your rulebook.',
    'import.hint': 'Want a system that is not listed? {rulebook} Run rpg import <file> first.',
    'import.error': '{rulebook} {message}',
    'provenance.default': 'default',
    'provenance.chosen': 'chosen',
    'provenance.fallback': 'fallback',
    'feature.diceVisualization': 'Dice animation',
    'feature.diceVisualization.detail': 'Show each dice roll on screen.',
    'feature.voiceOutput': 'Voice narration',
    'feature.voiceOutput.detail': 'The narrator reads the story aloud.',
    'feature.simulation': 'Living world',
    'feature.simulation.detail': 'People and places act on their own while you play.',
    'field.ruleset': 'Rules',
    'field.genre': 'Genre',
    'field.character': 'Character',
    'field.dice': 'Dice',
    'value.none': 'none',
    'value.on': 'on',
    'value.off': 'off',
    'value.rulepack': 'as the ruleset decides',
    'group.story': 'Your story',
    'group.extras': 'Extras',
    'character.title': 'Pick your character',
    'character.noGenre': 'Pick a genre to see ready-made characters.',
    'character.noReadyMade': 'Ready-made characters need a sheet on these rules. Describe your own.',
    'character.pick': 'Pick a ready-made character, or describe your own.',
    'character.sheet': 'Your rules track {fields}.',
    'character.entry': 'Describe your character',
    'summary.title': 'Ready to start',
    'summary.line': '{label}: {value} ({provenance})',
    'summary.entry': 'Adventure name',
    'path.title': 'New adventure',
    'path.question': 'How do you want to start?',
    'path.describe': 'Describe it',
    'path.describe.detail': 'Write one sentence about the game you want.',
    'path.guide': 'Guide me',
    'path.guide.detail': 'Answer a few short questions. You can skip any of them.',
    'describe.title': 'Describe it',
    'describe.prompt': 'Say what you want to play in one sentence.',
    'describe.example': 'For example: a horror story using the Narrative rules.',
    'describe.entry': 'Your adventure',
    'genre.title': 'Pick a tone and genre',
    'genre.text': 'This sets the mood of your story.',
    'rules.title': 'Pick a rules system',
    'rules.text': 'Pick how your game plays; the recommended option suits a first game.',
    'rules.badge': 'Recommended',
    'ruleset.narrative': 'Story only: no dice, no sheet',
    'ruleset.narrative.detail': 'The GM decides what happens from your story.',
    'ruleset.d20-lite': 'Classic d20',
    'ruleset.d20-lite.detail': 'Roll a twenty-sided die against a target. Your character has a sheet.',
    'ruleset.dice-pool-lite': 'Dice pool',
    'ruleset.dice-pool-lite.detail': 'Roll a pool of dice for each action. Your character has a sheet.',
    'rules.none': 'No rules: the GM decides',
    'rules.none.detail': 'The GM decides everything from your story. Nothing is rolled.',
    'rules.own': 'My own files',
    'rules.own.detail': 'The GM runs the rules from your files. Add md or txt files.',
    'rules.ownFiles': 'Rules files: {files}.',
    'rules.ownNone': 'No rules files added yet.',
    'value.ownFiles': 'my own files',
    'character.noSheet':
      'This game does not use a character sheet. Give your character a name and a short description.',
    'features.noDice': 'This game does not use dice.',
    'packs.english':
      'Built-in genres and rules are written in English. The game master still narrates in your language.',
    'features.text': 'These stay off unless you turn them on.',
    'begin.title': 'Before we begin',
    'begin.text': 'Every answer has a default. Change what you like, or skip.',
    'begin.language': 'Story language',
    'begin.voice': 'Narrator voice',
    'begin.spoken': 'Spoken story',
    'begin.spoken.off': 'Off',
    'begin.spoken.off.detail': 'The story stays in text.',
    'begin.spoken.on': 'On',
    'begin.spoken.on.detail': 'The narrator reads the story aloud.',
    'begin.dice': 'Who rolls the dice',
    'begin.strictness': 'Rules strictness',
    'whoRolls.app': 'The app',
    'whoRolls.app.detail': 'The app rolls and shows each result.',
    'whoRolls.me': 'Me',
    'whoRolls.me.detail': 'You roll your own dice and report the result.',
    'whoRolls.ask': 'Ask each time',
    'whoRolls.ask.detail': 'The game asks before every roll.',
    'strictness.as-written': 'As written',
    'strictness.as-written.detail': 'The rules apply exactly.',
    'strictness.relaxed': 'Relaxed',
    'strictness.relaxed.detail': 'The GM bends the rules for the story.',
    'strictness.off': 'Off',
    'strictness.off.detail': 'The GM decides and the rules stay out of the way.',
  },
  'pt-BR': {
    'name.default': 'Minha aventura',
    'primer.title': 'O que é um RPG de mesa?',
    'primer.play': 'Num RPG de mesa, você interpreta um personagem numa história contada em conjunto.',
    'primer.gm': 'O mestre do jogo descreve o mundo, interpreta todos os outros personagens e decide o que acontece.',
    'import.rulebook': 'Importe seu livro de regras.',
    'import.hint': 'Quer um sistema que não está na lista? {rulebook} Antes, rode rpg import <arquivo>.',
    'import.error': '{rulebook} {message}',
    'provenance.default': 'padrão',
    'provenance.chosen': 'escolhido',
    'provenance.fallback': 'alternativa',
    'feature.diceVisualization': 'Animação de dados',
    'feature.diceVisualization.detail': 'Mostra cada rolagem de dados na tela.',
    'feature.voiceOutput': 'Narração por voz',
    'feature.voiceOutput.detail': 'O narrador lê a história em voz alta.',
    'feature.simulation': 'Mundo vivo',
    'feature.simulation.detail': 'Pessoas e lugares agem por conta própria enquanto você joga.',
    'field.ruleset': 'Regras',
    'field.genre': 'Gênero',
    'field.character': 'Personagem',
    'field.dice': 'Dados',
    'value.none': 'nenhum',
    'value.on': 'ligado',
    'value.off': 'desligado',
    'value.rulepack': 'como as regras decidem',
    'group.story': 'Sua história',
    'group.extras': 'Extras',
    'character.title': 'Escolha seu personagem',
    'character.noGenre': 'Escolha um gênero para ver personagens prontos.',
    'character.noReadyMade': 'Personagens prontos precisam de uma ficha nestas regras. Descreva o seu.',
    'character.pick': 'Escolha um personagem pronto ou descreva o seu.',
    'character.sheet': 'Suas regras acompanham {fields}.',
    'character.entry': 'Descreva seu personagem',
    'summary.title': 'Pronto para começar',
    'summary.line': '{label}: {value} ({provenance})',
    'summary.entry': 'Nome da aventura',
    'path.title': 'Nova aventura',
    'path.question': 'Como você quer começar?',
    'path.describe': 'Descrever',
    'path.describe.detail': 'Escreva uma frase sobre o jogo que você quer.',
    'path.guide': 'Me guie',
    'path.guide.detail': 'Responda algumas perguntas rápidas. Você pode pular qualquer uma.',
    'describe.title': 'Descreva sua aventura',
    'describe.prompt': 'Diga em uma frase o que você quer jogar.',
    'describe.example': 'Por exemplo: uma história de terror com as regras Narrative.',
    'describe.entry': 'Sua aventura',
    'genre.title': 'Escolha o tom e o gênero',
    'genre.text': 'Isso define o clima da sua história.',
    'rules.title': 'Escolha um sistema de regras',
    'rules.text': 'Escolha como seu jogo funciona; a opção recomendada serve para o primeiro jogo.',
    'rules.badge': 'Recomendado',
    'ruleset.narrative': 'Só história: sem dados, sem ficha',
    'ruleset.narrative.detail': 'O mestre decide o que acontece a partir da sua história.',
    'ruleset.d20-lite': 'd20 clássico',
    'ruleset.d20-lite.detail': 'Role um dado de vinte lados contra um alvo. Seu personagem tem ficha.',
    'ruleset.dice-pool-lite': 'Reserva de dados',
    'ruleset.dice-pool-lite.detail': 'Role uma reserva de dados a cada ação. Seu personagem tem ficha.',
    'rules.none': 'Sem regras: o mestre decide',
    'rules.none.detail': 'O mestre decide tudo a partir da sua história. Nada é rolado.',
    'rules.own': 'Meus próprios arquivos',
    'rules.own.detail': 'O mestre segue as regras dos seus arquivos. Adicione arquivos md ou txt.',
    'rules.ownFiles': 'Arquivos de regras: {files}.',
    'rules.ownNone': 'Nenhum arquivo de regras adicionado ainda.',
    'value.ownFiles': 'meus próprios arquivos',
    'character.noSheet': 'Este jogo não usa ficha de personagem. Dê ao seu personagem um nome e uma descrição curta.',
    'features.noDice': 'Este jogo não usa dados.',
    'packs.english': 'Os gêneros e regras incluídos estão em inglês. O mestre ainda narra no seu idioma.',
    'features.text': 'Estes ficam desligados, a não ser que você os ligue.',
    'begin.title': 'Antes de começar',
    'begin.text': 'Toda resposta tem um padrão. Mude o que quiser ou pule.',
    'begin.language': 'Idioma da história',
    'begin.voice': 'Voz do narrador',
    'begin.spoken': 'História em voz alta',
    'begin.spoken.off': 'Desligada',
    'begin.spoken.off.detail': 'A história fica só em texto.',
    'begin.spoken.on': 'Ligada',
    'begin.spoken.on.detail': 'O narrador lê a história em voz alta.',
    'begin.dice': 'Quem rola os dados',
    'begin.strictness': 'Rigor das regras',
    'whoRolls.app': 'O app',
    'whoRolls.app.detail': 'O app rola e mostra cada resultado.',
    'whoRolls.me': 'Eu',
    'whoRolls.me.detail': 'Você rola seus dados e informa o resultado.',
    'whoRolls.ask': 'Perguntar sempre',
    'whoRolls.ask.detail': 'O jogo pergunta antes de cada rolagem.',
    'strictness.as-written': 'Ao pé da letra',
    'strictness.as-written.detail': 'As regras valem exatamente.',
    'strictness.relaxed': 'Flexível',
    'strictness.relaxed.detail': 'O mestre flexibiliza as regras pela história.',
    'strictness.off': 'Desligado',
    'strictness.off.detail': 'O mestre decide e as regras ficam de lado.',
  },
};
const text = createTranslator(START_CATALOG);
export const DEFAULT_ADVENTURE_NAME = text(DEFAULT_LOCALE, 'name.default');
const UNKNOWN_EDITION = 'UnknownEdition';
const BUILT_IN_EDITION = 'original';
const BUILT_IN_RULESETS = ['narrative', 'd20-lite', 'dice-pool-lite'];
const DEFAULT_PROVENANCE = 'default';
const CHOSEN = 'chosen';
const PROVENANCE_LABELS = new Set([DEFAULT_PROVENANCE, 'fallback']);
const LIST_STYLE = { type: 'unit', style: 'short' } as const;
const FEATURE_ON: Readonly<Record<Feature, unknown>> = {
  diceVisualization: true,
  voiceOutput: true,
  simulation: 'balanced',
};
const LABEL_KEYS: Readonly<Record<string, string>> = {
  ruleset: 'field.ruleset',
  genre: 'field.genre',
  character: 'field.character',
  dice: 'field.dice',
  ...Object.fromEntries(FEATURES.map((feature) => [feature, `feature.${feature}`])),
};
const fieldLabel = (locale: string, field: string) => {
  const key = LABEL_KEYS[field];
  return key === undefined ? field : text(locale, key);
};
const STEP_FIELDS: Partial<Record<StartStep, readonly string[]>> = {
  genre: ['genre'],
  rules: ['ruleset', ...RULES_SOURCE_FIELDS],
  character: ['character'],
  features: FEATURES,
  begin: PLAY_FIELDS,
};
const FIELD_STEPS: Readonly<Record<string, StartStep>> = {
  ruleset: 'rules',
  dice: 'rules',
  genre: 'genre',
  character: 'character',
  ...Object.fromEntries(FEATURES.map((feature) => [feature, 'features'])),
};
const FIRST_STEP = 0;
const SPOKEN_ON = 'narrator' as const;
const DICE_FEATURE: Feature = 'diceVisualization';
const VOICE_FEATURE: Feature = 'voiceOutput';
const LANGUAGE_FIELD = 'language';
const NARRATOR_FIELD = 'narratorVoice';
const DRAFT_KEYS = ['path', 'step', 'name', 'intent', 'choices'];
const NEXT = 1;
const EDITION_KEYS = ['id', 'edition'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (limit: number) => (value: unknown) => typeof value === 'string' && value.length <= limit;
const isEdition = (value: unknown) =>
  isRecord(value) &&
  Object.keys(value).length === EDITION_KEYS.length &&
  isText(MAX_INPUT_LENGTH)(value.id) &&
  isText(MAX_INPUT_LENGTH)(value.edition);
const isFileNames = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= MAX_RULES_DOCUMENTS &&
  value.every((name) => typeof name === 'string' && name !== '' && name.length <= MAX_RULES_NAME_LENGTH);
const CHOICE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  language: isLocale,
  narratorVoice: (value: unknown) => isText(MAX_INPUT_LENGTH)(value) && value !== '',
  whoRolls: (value: unknown) => WHO_ROLLS.some((known) => known === value),
  rulesStrictness: isRulesStrictness,
  genre: isText(MAX_INPUT_LENGTH),
  character: isText(MAX_INPUT_LENGTH),
  ruleset: isEdition,
  [RULES_SOURCE_FIELD]: (value: unknown) => RULES_SOURCES.some((known) => known === value),
  [OWN_RULES_FIELD]: isFileNames,
  ...Object.fromEntries(FEATURES.map((feature) => [feature, (value: unknown) => value === FEATURE_ON[feature]])),
};

const stepsOf = (path: StartPath | null): readonly StartStep[] => (path === null ? ['path'] : START_STEPS[path]);

export const stepOf = ({ path, step }: StartDraft): StartStep => stepsOf(path)[step] ?? 'path';

const advance = (draft: StartDraft): StartDraft => ({
  ...draft,
  step: Math.min(draft.step + NEXT, stepsOf(draft.path).length - NEXT),
});

const without = (choices: StartDraft['choices'], fields: readonly string[]) =>
  Object.fromEntries(Object.entries(choices).filter(([field]) => !fields.includes(field)));

const entered = (draft: StartDraft, text: string): StartDraft => {
  const value = text.trim();
  const step = stepOf(draft);
  if (step === 'summary') return { ...draft, name: value.slice(0, MAX_CAMPAIGN_NAME_LENGTH) };
  if (step === 'describe') return advance({ ...draft, intent: value.slice(0, MAX_INPUT_LENGTH) });
  if (step !== 'character') return draft;
  const choices = without(draft.choices, ['character']);
  return advance({
    ...draft,
    choices: value === '' ? choices : { ...choices, character: value.slice(0, MAX_INPUT_LENGTH) },
  });
};

const editAt = (draft: StartDraft, step: number): StartDraft =>
  draft.path !== null && Number.isInteger(step) && step >= FIRST_STEP && step < stepsOf(draft.path).length
    ? { ...draft, step }
    : draft;

const replacing = ({ choices }: StartDraft, { field, value }: { field: string; value: unknown }) => {
  if (field === 'ruleset') return without(choices, RULES_SOURCE_FIELDS);
  if (field !== RULES_SOURCE_FIELD) return choices;
  return without(choices, value === 'own' ? ['ruleset'] : ['ruleset', OWN_RULES_FIELD]);
};

export const nextDraft = (draft: StartDraft, action: StartAction): StartDraft => {
  if (action.kind === 'path') return { ...draft, path: action.path, step: 0 };
  if (action.kind === 'back')
    return draft.step === 0 ? { ...draft, path: null, step: 0 } : { ...draft, step: draft.step - NEXT };
  if (action.kind === 'next') return advance(draft);
  if (action.kind === 'skip') {
    const intent = stepOf(draft) === 'describe' ? '' : draft.intent;
    return advance({ ...draft, intent, choices: without(draft.choices, STEP_FIELDS[stepOf(draft)] ?? []) });
  }
  if (action.kind === 'set')
    return {
      ...draft,
      choices: {
        ...(action.field === LANGUAGE_FIELD ? without(draft.choices, [NARRATOR_FIELD]) : replacing(draft, action)),
        [action.field]: action.value,
      },
    };
  if (action.kind === 'choose')
    return advance({ ...draft, choices: { ...replacing(draft, action), [action.field]: action.value } });
  if (action.kind === 'toggle') {
    if (action.on === Object.hasOwn(draft.choices, action.field)) return draft;
    const choices = without(draft.choices, [action.field]);
    return {
      ...draft,
      choices: Object.hasOwn(draft.choices, action.field)
        ? choices
        : { ...choices, [action.field]: FEATURE_ON[action.field] },
    };
  }
  if (action.kind === 'enter') return entered(draft, action.text);
  if (action.kind === 'edit') return editAt(draft, action.step);
  return draft;
};

const planFields = ({ path, intent, choices }: StartDraft, client?: string) => {
  if (path === 'describe') return intent === '' ? {} : { intent };
  const planned = {
    ...without(choices, [...PLAY_FIELDS, ...RULES_SOURCE_FIELDS]),
    ...(choices[RULES_SOURCE_FIELD] === undefined ? {} : { ruleset: null }),
  };
  return { choices: client === undefined ? planned : { ...planned, client } };
};

const playOf = ({ choices }: StartDraft): CampaignPlay => {
  const whoRolls = WHO_ROLLS.find((known) => known === choices.whoRolls);
  const rulesStrictness = RULES_STRICTNESSES.find((known) => known === choices.rulesStrictness);
  return {
    ...(whoRolls === undefined ? {} : { whoRolls }),
    ...(rulesStrictness === undefined ? {} : { rulesStrictness }),
    ...(Object.hasOwn(choices, VOICE_FEATURE) ? { spokenOutput: SPOKEN_ON } : {}),
  };
};

export const planCommand = (draft: StartDraft, client?: string): PlanCampaign => ({
  version: PROTOCOL_VERSION,
  type: 'PlanCampaign',
  ...planFields(draft, client),
});

export const createCommand = (draft: StartDraft, client?: string, locale = DEFAULT_LOCALE): CreateCampaign => {
  const play = playOf(draft);
  const language = typeof draft.choices.language === 'string' ? draft.choices.language : safeLocale(locale);
  const ownFiles = draft.choices[RULES_SOURCE_FIELD] === 'own' ? draft.choices[OWN_RULES_FIELD] : undefined;
  return {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: draft.name || text(locale, 'name.default'),
    ...planFields(draft, client),
    language,
    ...(Object.keys(play).length === 0 ? {} : { play }),
    ...(Array.isArray(ownFiles) && ownFiles.length > 0 ? { rulesDocuments: ownFiles as string[] } : {}),
  };
};

export const parseStartDraft = (raw: unknown): StartDraft => {
  if (!isRecord(raw) || Object.keys(raw).some((key) => !DRAFT_KEYS.includes(key))) return INITIAL_DRAFT;
  const { path, step, name, intent, choices } = raw;
  const validPath = path === null || START_PATHS.some((known) => known === path);
  if (!validPath || !Number.isInteger(step) || (step as number) < 0) return INITIAL_DRAFT;
  if ((step as number) >= stepsOf(path as StartPath | null).length) return INITIAL_DRAFT;
  if (!isText(MAX_CAMPAIGN_NAME_LENGTH)(name) || !isText(MAX_INPUT_LENGTH)(intent) || !isRecord(choices))
    return INITIAL_DRAFT;
  const valid = Object.entries(choices).every(([field, value]) => CHOICE_CHECKS[field]?.(value) === true);
  return valid ? ({ path, step, name, intent, choices } as StartDraft) : INITIAL_DRAFT;
};

export const loadStartDraft = (read: () => string): StartDraft => {
  try {
    return parseStartDraft(JSON.parse(read()));
  } catch {
    return INITIAL_DRAFT;
  }
};

const choose = (field: string, value: unknown, label: string, detail: string, draft: StartDraft): StartOption => ({
  label,
  detail,
  action: { kind: 'choose', field, value },
  selected: JSON.stringify(draft.choices[field]) === JSON.stringify(value),
});

const errorText = (locale: string, { code, message }: { readonly code: string; readonly message: string }) =>
  code === UNKNOWN_EDITION
    ? text(locale, 'import.error', { rulebook: text(locale, 'import.rulebook'), message })
    : message;

type Page = Pick<StartScreen, 'title' | 'text' | 'options'> & Partial<StartScreen>;

const PACK_LANGUAGE = 'en';

const packNotice = (locale: string) =>
  new Intl.Locale(safeLocale(locale)).language === PACK_LANGUAGE || hasContentNames(locale)
    ? []
    : [text(locale, 'packs.english')];

const RULES_SOURCE_USAGE: Readonly<Record<string, RulesUsage>> = { own: OWN_RULES_USAGE, none: NONE_RULES_USAGE };

const sourceUsageOf = ({ choices }: StartDraft) => {
  const source = choices[RULES_SOURCE_FIELD];
  return typeof source === 'string' && Object.hasOwn(RULES_SOURCE_USAGE, source)
    ? RULES_SOURCE_USAGE[source]
    : undefined;
};

const usageOf = (draft: StartDraft, options: StartOptions) =>
  sourceUsageOf(draft) ??
  options.rulesets.find(
    ({ id, edition }) =>
      isEdition(draft.choices.ruleset) && JSON.stringify({ id, edition }) === JSON.stringify(draft.choices.ruleset),
  )?.usage ??
  DEFAULT_RULES_USAGE;

type Ruleset = StartOptions['rulesets'][number];

const isBuiltIn = ({ id, edition }: Pick<Ruleset, 'id' | 'edition'>) =>
  edition === BUILT_IN_EDITION && BUILT_IN_RULESETS.includes(id);

export const rulesetLabel = (locale: string, ruleset: Pick<Ruleset, 'id' | 'edition'>) =>
  isBuiltIn(ruleset) ? text(locale, `ruleset.${ruleset.id}`) : `${ruleset.id} ${ruleset.edition}`;

const humanized = (id: string) => {
  const words = id.replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const genreLabel = (locale: string, id: string, imported = false) =>
  imported ? humanized(id) : contentText(locale, 'genre', id, humanized(id));

const rulesetDetail = (locale: string, ruleset: Ruleset) =>
  isBuiltIn(ruleset) ? text(locale, `ruleset.${ruleset.id}.detail`) : ruleset.blurb;

const rulesetValue = (locale: string, value: string, { rulesets }: StartOptions) => {
  const ruleset = rulesets.find(({ id, edition }) => `${id} ${edition}` === value);
  return ruleset === undefined ? value : rulesetLabel(locale, ruleset);
};

const archetypeText = (locale: string, kind: ContentKind, id: string | undefined, fallback: string) =>
  id === undefined ? fallback : contentText(locale, kind, id, fallback);

const characterLabel = (locale: string, value: string, { genres }: StartOptions) => {
  const known = genres.flatMap(({ imported, characters }) => (imported === true ? [] : characters));
  return archetypeText(locale, 'archetype', known.find(({ name }) => name === value)?.id, value);
};

const characterPage = (draft: StartDraft, options: StartOptions, locale: string): Page => {
  const { genres, rulesets } = options;
  const genre = genres.find(({ id }) => id === draft.choices.genre);
  const ruleset = rulesets.find(
    ({ id, edition }) =>
      isEdition(draft.choices.ruleset) && JSON.stringify({ id, edition }) === JSON.stringify(draft.choices.ruleset),
  );
  const sheet = !usesSheet(usageOf(draft, options))
    ? [text(locale, 'character.noSheet')]
    : ruleset === undefined || ruleset.sheet.length === 0
      ? []
      : [
          text(locale, 'character.sheet', {
            fields: new Intl.ListFormat(safeLocale(locale), LIST_STYLE).format(
              ruleset.sheet.map((label) => (isBuiltIn(ruleset) ? contentText(locale, 'stat', label, label) : label)),
            ),
          }),
        ];
  const value = typeof draft.choices.character === 'string' ? draft.choices.character : '';
  const hidden = ruleset?.readyMade === false;
  return {
    title: text(locale, 'character.title'),
    text: [
      text(locale, genre === undefined ? 'character.noGenre' : hidden ? 'character.noReadyMade' : 'character.pick'),
      ...sheet,
    ],
    options: (hidden ? [] : (genre?.characters ?? [])).map(({ id, name, summary }) => {
      const key = genre?.imported === true ? undefined : id;
      return choose(
        'character',
        name,
        archetypeText(locale, 'archetype', key, name),
        `${archetypeText(locale, 'archetype.summary', key, summary)}.`,
        draft,
      );
    }),
    entry: { label: text(locale, 'character.entry'), value },
  };
};

export const DICE_LABELS = { rulepack: 'as the ruleset decides', on: 'on', off: 'off' } as const;

const VALUE_KEYS: Readonly<Record<string, string>> = {
  none: 'value.none',
  [DICE_LABELS.on]: 'value.on',
  [DICE_LABELS.off]: 'value.off',
  [DICE_LABELS.rulepack]: 'value.rulepack',
};

const shown = (locale: string, field: string, value: string, options: StartOptions) => {
  if (field === 'ruleset' && value === OWN_FILES_VALUE) return text(locale, 'value.ownFiles');
  if (field === 'ruleset') return rulesetValue(locale, value, options);
  if (field === 'genre' && value !== 'none')
    return genreLabel(
      locale,
      value,
      options.genres.some(({ id, imported }) => id === value && imported === true),
    );
  if (field === 'character') return characterLabel(locale, value, options);
  const key = VALUE_KEYS[value];
  return key === undefined ? value : text(locale, key);
};

const entriesOf = ({ choices }: StartDraft, entries: CampaignPlan['entries']) =>
  choices[RULES_SOURCE_FIELD] === 'own'
    ? entries.map((entry) => (entry.field === 'ruleset' ? { ...entry, value: OWN_FILES_VALUE } : entry))
    : entries;

const reviewOf = (
  draft: StartDraft,
  { entries, options }: CampaignPlan,
  locale: string,
): readonly StartReviewGroup[] => {
  const items = entriesOf(draft, entries).map(
    ({ field, value, provenance }): StartReviewItem => ({
      field,
      label: fieldLabel(locale, field),
      value: shown(locale, field, value, options),
      chosen: provenance !== DEFAULT_PROVENANCE,
      step: Math.max(FIRST_STEP, stepsOf(draft.path).indexOf(FIELD_STEPS[field] ?? 'path')),
    }),
  );
  const extra = ({ field }: StartReviewItem) => FEATURES.some((feature) => feature === field);
  return [
    { title: text(locale, 'group.story'), items: items.filter((item) => !extra(item)) },
    { title: text(locale, 'group.extras'), items: items.filter(extra) },
  ].filter((group) => group.items.length > 0);
};

const summaryPage = (draft: StartDraft, plan: Result<CampaignPlan> | undefined, locale: string): Page => ({
  title: text(locale, 'summary.title'),
  text: plan?.ok
    ? entriesOf(draft, plan.value.entries).map(({ field, value, provenance }) =>
        text(locale, 'summary.line', {
          label: fieldLabel(locale, field),
          value: shown(locale, field, value, plan.value.options),
          provenance: text(locale, `provenance.${PROVENANCE_LABELS.has(provenance) ? provenance : CHOSEN}`),
        }),
      )
    : [],
  ...(plan?.ok && plan.value.notes?.length ? { notes: plan.value.notes } : {}),
  options: [],
  entry: { label: text(locale, 'summary.entry'), value: draft.name || text(locale, 'name.default') },
  ...(plan?.ok ? { review: reviewOf(draft, plan.value, locale) } : {}),
  ...(plan === undefined || plan.ok ? {} : { error: errorText(locale, plan.error) }),
  canStart: plan?.ok === true,
});

const sourceOption = (
  draft: StartDraft,
  locale: string,
  source: 'own' | 'none',
  kind: 'set' | 'choose',
): StartOption => ({
  label: text(locale, `rules.${source}`),
  detail: text(locale, `rules.${source}.detail`),
  action: { kind, field: RULES_SOURCE_FIELD, value: source },
  selected: draft.choices[RULES_SOURCE_FIELD] === source,
});

const hasOwnFiles = ({ choices }: StartDraft) =>
  choices[RULES_SOURCE_FIELD] === 'own' &&
  isFileNames(choices[OWN_RULES_FIELD]) &&
  (choices[OWN_RULES_FIELD] as string[]).length > 0;

const ownFilesNotice = ({ choices }: StartDraft, locale: string) => {
  if (choices[RULES_SOURCE_FIELD] !== 'own') return [];
  const files = isFileNames(choices[OWN_RULES_FIELD]) ? (choices[OWN_RULES_FIELD] as string[]) : [];
  return [
    files.length === 0 ? text(locale, 'rules.ownNone') : text(locale, 'rules.ownFiles', { files: files.join(', ') }),
  ];
};

const PAGES: Readonly<
  Record<
    StartStep,
    (
      draft: StartDraft,
      options: StartOptions,
      plan: Result<CampaignPlan> | undefined,
      locale: string,
      voices: StartVoices | undefined,
      canPickFiles: boolean,
    ) => Page
  >
> = {
  path: (_draft, _options, _plan, locale) => ({
    title: text(locale, 'path.title'),
    text: [text(locale, 'path.question')],
    options: START_PATHS.map((path) => ({
      label: text(locale, `path.${path}`),
      detail: text(locale, `path.${path}.detail`),
      action: { kind: 'path', path },
      selected: false,
    })),
  }),
  describe: (draft, _options, _plan, locale) => ({
    title: text(locale, 'describe.title'),
    text: [text(locale, 'describe.prompt'), text(locale, 'describe.example')],
    options: [],
    entry: { label: text(locale, 'describe.entry'), value: draft.intent },
  }),
  primer: (_draft, _options, _plan, locale) => ({
    title: text(locale, 'primer.title'),
    text: [text(locale, 'primer.play'), text(locale, 'primer.gm')],
    options: [],
    canNext: true,
  }),
  genre: (draft, { genres }, _plan, locale) => ({
    title: text(locale, 'genre.title'),
    text: [text(locale, 'genre.text'), ...packNotice(locale)],
    options: genres.map(({ id, name, blurb, imported }) =>
      imported === true
        ? choose('genre', id, name, blurb, draft)
        : choose(
            'genre',
            id,
            contentText(locale, 'genre', id, name),
            contentText(locale, 'genre.blurb', id, blurb),
            draft,
          ),
    ),
  }),
  rules: (draft, { rulesets }, _plan, locale, _voices, canPickFiles) => ({
    ...(hasOwnFiles(draft) ? { canNext: true } : {}),
    title: text(locale, 'rules.title'),
    text: [text(locale, 'rules.text'), ...packNotice(locale), ...ownFilesNotice(draft, locale)],
    importHint: text(locale, 'import.hint', { rulebook: text(locale, 'import.rulebook') }),
    options: [
      ...[...rulesets]
        .sort((first, second) => Number(second.recommended) - Number(first.recommended))
        .map((ruleset) => ({
          ...choose(
            'ruleset',
            { id: ruleset.id, edition: ruleset.edition },
            rulesetLabel(locale, ruleset),
            rulesetDetail(locale, ruleset),
            draft,
          ),
          ...(ruleset.recommended ? { badge: text(locale, 'rules.badge') } : {}),
        })),
      ...(canPickFiles ? [sourceOption(draft, locale, 'own', 'set')] : []),
      sourceOption(draft, locale, 'none', 'choose'),
    ],
  }),
  character: (draft, options, _plan, locale) => characterPage(draft, options, locale),
  features: (draft, options, _plan, locale) => ({
    title: text(locale, 'group.extras'),
    text: [
      text(locale, 'features.text'),
      ...(usesDice(usageOf(draft, options)) ? [] : [text(locale, 'features.noDice')]),
    ],
    options: FEATURES.filter((field) => field !== DICE_FEATURE || usesDice(usageOf(draft, options))).map((field) => ({
      label: text(locale, `feature.${field}`),
      detail: text(locale, `feature.${field}.detail`),
      action: { kind: 'toggle', field },
      selected: Object.hasOwn(draft.choices, field),
    })),
    canNext: true,
  }),
  begin: (draft, options, _plan, locale, voices) => beginPage(draft, options, locale, voices),
  summary: (draft, _options, plan, locale) => summaryPage(draft, plan, locale),
};

const settable = (
  draft: StartDraft,
  group: string,
  field: string,
  value: string,
  label: string,
  detail: string,
  fallback: string,
): StartOption => ({
  label,
  detail,
  group,
  action: { kind: 'set', field, value },
  selected: (draft.choices[field] ?? fallback) === value,
});

const languageOptions = (draft: StartDraft, locale: string) =>
  [...new Set([safeLocale(locale), ...Object.keys(START_CATALOG)])].map((tag) =>
    settable(
      draft,
      text(locale, 'begin.language'),
      'language',
      tag,
      new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag,
      tag,
      safeLocale(locale),
    ),
  );

const voiceOptions = (draft: StartDraft, locale: string, { ids, current }: StartVoices): StartOption[] =>
  ids.map((id) => ({
    ...settable(draft, text(locale, 'begin.voice'), 'narratorVoice', id, id, '', current ?? ''),
    preview: { kind: 'preview', voice: id },
  }));

const choiceOptions = (
  draft: StartDraft,
  locale: string,
  group: string,
  field: string,
  values: readonly string[],
  fallback: string,
  prefix: string,
) =>
  values.map((value) =>
    settable(
      draft,
      text(locale, group),
      field,
      value,
      text(locale, `${prefix}.${value}`),
      text(locale, `${prefix}.${value}.detail`),
      fallback,
    ),
  );

const spokenOption = (draft: StartDraft, locale: string, on: boolean): StartOption => ({
  label: text(locale, `begin.spoken.${on ? 'on' : 'off'}`),
  detail: text(locale, `begin.spoken.${on ? 'on' : 'off'}.detail`),
  group: text(locale, 'begin.spoken'),
  action: { kind: 'toggle', field: VOICE_FEATURE, on },
  selected: Object.hasOwn(draft.choices, VOICE_FEATURE) === on,
});

const spokenOptions = (draft: StartDraft, locale: string, voices: StartVoices): StartOption[] => [
  spokenOption(draft, locale, false),
  spokenOption(draft, locale, true),
  ...(Object.hasOwn(draft.choices, VOICE_FEATURE) ? voiceOptions(draft, locale, voices) : []),
];

const beginPage = (
  draft: StartDraft,
  options: StartOptions,
  locale: string,
  voices: StartVoices | undefined,
): Page => ({
  title: text(locale, 'begin.title'),
  text: [text(locale, 'begin.text')],
  options: [
    ...languageOptions(draft, locale),
    ...(voices === undefined ? [] : spokenOptions(draft, locale, voices)),
    ...(usesDice(usageOf(draft, options))
      ? choiceOptions(draft, locale, 'begin.dice', 'whoRolls', WHO_ROLLS, DEFAULT_WHO_ROLLS, 'whoRolls')
      : []),
    ...choiceOptions(
      draft,
      locale,
      'begin.strictness',
      'rulesStrictness',
      RULES_STRICTNESSES,
      DEFAULT_RULES_STRICTNESS,
      'strictness',
    ),
  ],
  canNext: true,
});

const NO_OPTIONS: StartOptions = { genres: [], rulesets: [] };

export const startScreen = (
  draft: StartDraft,
  options: StartOptions | undefined,
  plan: Result<CampaignPlan> | undefined,
  locale = DEFAULT_LOCALE,
  voices?: StartVoices,
  canPickFiles = false,
): StartScreen => {
  const step = stepOf(draft);
  const steps = stepsOf(draft.path);
  const page = PAGES[step](draft, options ?? NO_OPTIONS, plan, locale, voices, canPickFiles);
  const ending = step === 'summary' || step === 'path';
  return {
    step,
    canBack: step !== 'path',
    canSkip: !ending,
    canNext: false,
    canStart: false,
    ...(draft.path === null ? {} : { progress: { current: draft.step + NEXT, total: steps.length } }),
    ...page,
  };
};
