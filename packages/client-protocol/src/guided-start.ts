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
export const DEFAULT_ADVENTURE_NAME = 'My adventure';
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
  | { readonly kind: 'next' | 'skip' | 'back' | 'start' };
export type StartOption = {
  readonly label: string;
  readonly detail: string;
  readonly action: StartAction;
  readonly selected: boolean;
};
export type StartScreen = {
  readonly step: StartStep;
  readonly title: string;
  readonly text: readonly string[];
  readonly options: readonly StartOption[];
  readonly entry?: { readonly label: string; readonly value: string };
  readonly error?: string;
  readonly progress?: { readonly current: number; readonly total: number };
  readonly canBack: boolean;
  readonly canSkip: boolean;
  readonly canNext: boolean;
  readonly canStart: boolean;
};

export const INITIAL_DRAFT: StartDraft = Object.freeze({ path: null, step: 0, name: '', intent: '', choices: {} });

export const PRIMER = [
  'In a tabletop role-playing game, you play one character in a story you tell together.',
  'The game master, or GM, describes the world, plays everyone else and decides what happens.',
];
export const IMPORT_RULEBOOK = 'Import your rulebook.';
const IMPORT_HINT = `Want a system that is not listed? ${IMPORT_RULEBOOK} Run rpg import <file> first.`;
const UNKNOWN_EDITION = 'UnknownEdition';
const DEFAULT_PROVENANCE = 'default';
const CHOSEN = 'chosen';
const FEATURE_ON: Readonly<Record<Feature, unknown>> = {
  diceVisualization: true,
  voiceOutput: true,
  simulation: 'balanced',
};
const FEATURE_COPY: Readonly<Record<Feature, { readonly label: string; readonly detail: string }>> = {
  diceVisualization: { label: 'Dice animation', detail: 'Show each dice roll on screen.' },
  voiceOutput: { label: 'Voice narration', detail: 'The narrator reads the story aloud.' },
  simulation: { label: 'Living world', detail: 'People and places act on their own while you play.' },
};
const FIELD_LABELS: Readonly<Record<string, string>> = {
  ruleset: 'Rules',
  genre: 'Genre',
  character: 'Character',
  dice: 'Dice',
  ...Object.fromEntries(FEATURES.map((feature) => [feature, FEATURE_COPY[feature].label])),
};
const STEP_FIELDS: Partial<Record<StartStep, readonly string[]>> = {
  genre: ['genre'],
  rules: ['ruleset'],
  character: ['character'],
  features: FEATURES,
};
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

export const createCommand = (draft: StartDraft, client?: string): CreateCampaign => ({
  version: PROTOCOL_VERSION,
  type: 'CreateCampaign',
  name: draft.name || DEFAULT_ADVENTURE_NAME,
  ...planFields(draft, client),
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

const errorText = ({ code, message }: { readonly code: string; readonly message: string }) =>
  code === UNKNOWN_EDITION ? `${IMPORT_RULEBOOK} ${message}` : message;

type Page = Pick<StartScreen, 'title' | 'text' | 'options'> & Partial<StartScreen>;

const characterPage = (draft: StartDraft, { genres, rulesets }: StartOptions): Page => {
  const genre = genres.find(({ id }) => id === draft.choices.genre);
  const ruleset = rulesets.find(
    ({ id, edition }) =>
      isEdition(draft.choices.ruleset) && JSON.stringify({ id, edition }) === JSON.stringify(draft.choices.ruleset),
  );
  const sheet =
    ruleset === undefined || ruleset.sheet.length === 0 ? [] : [`Your rules track ${ruleset.sheet.join(', ')}.`];
  const value = typeof draft.choices.character === 'string' ? draft.choices.character : '';
  return {
    title: 'Pick your character',
    text: [
      genre === undefined
        ? 'Pick a genre to see ready-made characters.'
        : 'Pick a ready-made character, or describe your own.',
      ...sheet,
    ],
    options: (genre?.characters ?? []).map(({ name, summary }) =>
      choose('character', name, name, `${summary}.`, draft),
    ),
    entry: { label: 'Describe your character', value },
  };
};

const summaryPage = (draft: StartDraft, plan: Result<CampaignPlan> | undefined): Page => ({
  title: 'Ready to start',
  text: plan?.ok
    ? plan.value.entries.map(
        ({ field, value, provenance }) =>
          `${FIELD_LABELS[field] ?? field}: ${value} (${provenance === DEFAULT_PROVENANCE ? DEFAULT_PROVENANCE : CHOSEN})`,
      )
    : [],
  options: [],
  entry: { label: 'Adventure name', value: draft.name || DEFAULT_ADVENTURE_NAME },
  ...(plan === undefined || plan.ok ? {} : { error: errorText(plan.error) }),
  canStart: plan?.ok === true,
});

const PAGES: Readonly<
  Record<StartStep, (draft: StartDraft, options: StartOptions, plan?: Result<CampaignPlan>) => Page>
> = {
  path: () => ({
    title: 'New adventure',
    text: ['How do you want to start?'],
    options: [
      {
        label: 'Describe it',
        detail: 'Write one sentence about the game you want.',
        action: { kind: 'path', path: 'describe' },
        selected: false,
      },
      {
        label: 'Guide me',
        detail: 'Answer a few short questions. You can skip any of them.',
        action: { kind: 'path', path: 'guide' },
        selected: false,
      },
    ],
  }),
  describe: (draft) => ({
    title: 'Describe it',
    text: ['Say what you want to play in one sentence.', 'For example: a horror story using the Narrative rules.'],
    options: [],
    entry: { label: 'Your adventure', value: draft.intent },
  }),
  primer: () => ({ title: 'What is a tabletop RPG?', text: PRIMER, options: [], canNext: true }),
  genre: (draft, { genres }) => ({
    title: 'Pick a tone and genre',
    text: ['This sets the mood of your story.'],
    options: genres.map(({ id, name, blurb }) => choose('genre', id, name, blurb, draft)),
  }),
  rules: (draft, { rulesets }) => ({
    title: 'Pick a rules system',
    text: ['Light rules are best for your first game.', IMPORT_HINT],
    options: rulesets.map(({ id, edition, blurb, recommended }) =>
      choose(
        'ruleset',
        { id, edition },
        `${id} ${edition}${recommended ? ' (recommended for new players)' : ''}`,
        blurb,
        draft,
      ),
    ),
  }),
  character: characterPage,
  features: (draft) => ({
    title: 'Extras',
    text: ['These stay off unless you turn them on.'],
    options: FEATURES.map((field) => ({
      ...FEATURE_COPY[field],
      action: { kind: 'toggle', field },
      selected: Object.hasOwn(draft.choices, field),
    })),
    canNext: true,
  }),
  summary: (draft, _options, plan) => summaryPage(draft, plan),
};

const NO_OPTIONS: StartOptions = { genres: [], rulesets: [] };

export const startScreen = (
  draft: StartDraft,
  options: StartOptions | undefined,
  plan: Result<CampaignPlan> | undefined,
): StartScreen => {
  const step = stepOf(draft);
  const steps = stepsOf(draft.path);
  const page = PAGES[step](draft, options ?? NO_OPTIONS, plan);
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
