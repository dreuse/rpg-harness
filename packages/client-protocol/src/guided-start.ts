import { DEFAULT_RULES_USAGE, usesDice, usesSheet } from '../../domain/src/rules-usage.ts';
import { type Catalog, createTranslator, DEFAULT_LOCALE, safeLocale } from './locale.ts';
import {
  type CampaignPlan,
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
export const GUIDE_STEPS = ['primer', 'genre', 'rules', 'character', 'features', 'summary'] as const;
export const START_STEPS = { describe: ['describe', 'summary'], guide: GUIDE_STEPS } as const;
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
  | { readonly kind: 'toggle'; readonly field: Feature }
  | { readonly kind: 'enter'; readonly text: string }
  | { readonly kind: 'edit'; readonly step: number }
  | { readonly kind: 'next' | 'skip' | 'back' | 'start' };
export type StartOption = {
  readonly label: string;
  readonly detail: string;
  readonly action: StartAction;
  readonly selected: boolean;
};
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
  readonly options: readonly StartOption[];
  readonly entry?: { readonly label: string; readonly value: string };
  readonly review?: readonly StartReviewGroup[];
  readonly error?: string;
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
    'rules.text': 'Light rules are best for your first game.',
    'rules.recommended': '{name} (recommended for new players)',
    'rules.noDice': 'Some systems use no dice. The GM decides what happens from your story.',
    'rules.noSheet': 'Some systems have no character sheet. You only need a name and a short description.',
    'character.noSheet':
      'This game does not use a character sheet. Give your character a name and a short description.',
    'features.noDice': 'This game does not use dice.',
    'packs.english':
      'Built-in genres and rules are written in English. The game master still narrates in your language.',
    'features.text': 'These stay off unless you turn them on.',
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
    'rules.text': 'Regras leves são as melhores para o seu primeiro jogo.',
    'rules.recommended': '{name} (recomendado para iniciantes)',
    'rules.noDice': 'Alguns sistemas não usam dados. O mestre decide o que acontece a partir da sua história.',
    'rules.noSheet': 'Alguns sistemas não têm ficha de personagem. Você só precisa de um nome e uma descrição curta.',
    'character.noSheet': 'Este jogo não usa ficha de personagem. Dê ao seu personagem um nome e uma descrição curta.',
    'features.noDice': 'Este jogo não usa dados.',
    'packs.english': 'Os gêneros e regras incluídos estão em inglês. O mestre ainda narra no seu idioma.',
    'features.text': 'Estes ficam desligados, a não ser que você os ligue.',
  },
};
const text = createTranslator(START_CATALOG);
export const DEFAULT_ADVENTURE_NAME = text(DEFAULT_LOCALE, 'name.default');
const UNKNOWN_EDITION = 'UnknownEdition';
const DEFAULT_PROVENANCE = 'default';
const CHOSEN = 'chosen';
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
  rules: ['ruleset'],
  character: ['character'],
  features: FEATURES,
};
const FIELD_STEPS: Readonly<Record<string, StartStep>> = {
  ruleset: 'rules',
  dice: 'rules',
  genre: 'genre',
  character: 'character',
  ...Object.fromEntries(FEATURES.map((feature) => [feature, 'features'])),
};
const FIRST_STEP = 0;
const DICE_FEATURE: Feature = 'diceVisualization';
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
const CHOICE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  genre: isText(MAX_INPUT_LENGTH),
  character: isText(MAX_INPUT_LENGTH),
  ruleset: isEdition,
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

export const nextDraft = (draft: StartDraft, action: StartAction): StartDraft => {
  if (action.kind === 'path') return { ...draft, path: action.path, step: 0 };
  if (action.kind === 'back')
    return draft.step === 0 ? { ...draft, path: null, step: 0 } : { ...draft, step: draft.step - NEXT };
  if (action.kind === 'next') return advance(draft);
  if (action.kind === 'skip') {
    const intent = stepOf(draft) === 'describe' ? '' : draft.intent;
    return advance({ ...draft, intent, choices: without(draft.choices, STEP_FIELDS[stepOf(draft)] ?? []) });
  }
  if (action.kind === 'choose')
    return advance({ ...draft, choices: { ...draft.choices, [action.field]: action.value } });
  if (action.kind === 'toggle') {
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
  return { choices: client === undefined ? choices : { ...choices, client } };
};

export const planCommand = (draft: StartDraft, client?: string): PlanCampaign => ({
  version: PROTOCOL_VERSION,
  type: 'PlanCampaign',
  ...planFields(draft, client),
});

export const createCommand = (draft: StartDraft, client?: string, locale = DEFAULT_LOCALE): CreateCampaign => ({
  version: PROTOCOL_VERSION,
  type: 'CreateCampaign',
  name: draft.name || text(locale, 'name.default'),
  ...planFields(draft, client),
  language: safeLocale(locale),
});

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
  new Intl.Locale(safeLocale(locale)).language === PACK_LANGUAGE ? [] : [text(locale, 'packs.english')];

const usageOf = (draft: StartDraft, options: StartOptions) =>
  options.rulesets.find(
    ({ id, edition }) =>
      isEdition(draft.choices.ruleset) && JSON.stringify({ id, edition }) === JSON.stringify(draft.choices.ruleset),
  )?.usage ?? DEFAULT_RULES_USAGE;

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
            fields: new Intl.ListFormat(safeLocale(locale), LIST_STYLE).format(ruleset.sheet),
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
    options: (hidden ? [] : (genre?.characters ?? [])).map(({ name, summary }) =>
      choose('character', name, name, `${summary}.`, draft),
    ),
    entry: { label: text(locale, 'character.entry'), value },
  };
};

const reviewOf = (draft: StartDraft, { entries }: CampaignPlan, locale: string): readonly StartReviewGroup[] => {
  const items = entries.map(
    ({ field, value, provenance }): StartReviewItem => ({
      field,
      label: fieldLabel(locale, field),
      value,
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
    ? plan.value.entries.map(({ field, value, provenance }) =>
        text(locale, 'summary.line', {
          label: fieldLabel(locale, field),
          value,
          provenance: text(locale, `provenance.${provenance === DEFAULT_PROVENANCE ? DEFAULT_PROVENANCE : CHOSEN}`),
        }),
      )
    : [],
  options: [],
  entry: { label: text(locale, 'summary.entry'), value: draft.name || text(locale, 'name.default') },
  ...(plan?.ok ? { review: reviewOf(draft, plan.value, locale) } : {}),
  ...(plan === undefined || plan.ok ? {} : { error: errorText(locale, plan.error) }),
  canStart: plan?.ok === true,
});

const PAGES: Readonly<
  Record<
    StartStep,
    (draft: StartDraft, options: StartOptions, plan: Result<CampaignPlan> | undefined, locale: string) => Page
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
    options: genres.map(({ id, name, blurb }) => choose('genre', id, name, blurb, draft)),
  }),
  rules: (draft, { rulesets }, _plan, locale) => ({
    title: text(locale, 'rules.title'),
    text: [
      text(locale, 'rules.text'),
      text(locale, 'rules.noDice'),
      text(locale, 'rules.noSheet'),
      text(locale, 'import.hint', { rulebook: text(locale, 'import.rulebook') }),
      ...packNotice(locale),
    ],
    options: rulesets.map(({ id, edition, blurb, recommended }) =>
      choose(
        'ruleset',
        { id, edition },
        recommended ? text(locale, 'rules.recommended', { name: `${id} ${edition}` }) : `${id} ${edition}`,
        blurb,
        draft,
      ),
    ),
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
  summary: (draft, _options, plan, locale) => summaryPage(draft, plan, locale),
};

const NO_OPTIONS: StartOptions = { genres: [], rulesets: [] };

export const startScreen = (
  draft: StartDraft,
  options: StartOptions | undefined,
  plan: Result<CampaignPlan> | undefined,
  locale = DEFAULT_LOCALE,
): StartScreen => {
  const step = stepOf(draft);
  const steps = stepsOf(draft.path);
  const page = PAGES[step](draft, options ?? NO_OPTIONS, plan, locale);
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
