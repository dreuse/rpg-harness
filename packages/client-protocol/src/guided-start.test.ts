import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCommand,
  DEFAULT_ADVENTURE_NAME,
  GUIDE_STEPS,
  genreLabel,
  INITIAL_DRAFT,
  loadStartDraft,
  nextDraft,
  parseStartDraft,
  planCommand,
  rulesetLabel,
  START_CATALOG,
  START_STEPS,
  type StartAction,
  type StartDraft,
  type StartScreen,
  skipAction,
  startScreen,
  stepOf,
} from './guided-start.ts';
import { DEFAULT_LOCALE, missingKeys } from './locale.ts';
import {
  type CampaignPlan,
  failure,
  MAX_CAMPAIGN_NAME_LENGTH,
  PROTOCOL_VERSION,
  type Result,
  type StartOptions,
} from './protocol.ts';

const OPTIONS: StartOptions = {
  genres: [
    {
      id: 'fantasy',
      name: 'Fantasy',
      blurb: 'The standing stones hum.',
      characters: [{ id: 'hedge-witch', name: 'Hedge witch', summary: 'Trades remedies for secrets' }],
    },
    { id: 'horror', name: 'Creeping horror', blurb: 'The scratching stopped.', characters: [] },
  ],
  rulesets: [
    {
      id: 'd20-lite',
      edition: 'original',
      blurb: 'Rules for checks and dice.',
      recommended: false,
      readyMade: true,
      sheet: ['Might'],
    },
    {
      id: 'narrative',
      edition: 'original',
      blurb: 'Light rules.',
      recommended: true,
      readyMade: true,
      sheet: [],
      usage: { resolution: 'adjudicated', sheet: 'none' },
    },
  ],
};
const PLAN: Result<CampaignPlan> = {
  ok: true,
  value: {
    version: PROTOCOL_VERSION,
    options: OPTIONS,
    entries: [
      { field: 'ruleset', value: 'narrative original', provenance: 'explicit' },
      { field: 'genre', value: 'none', provenance: 'default' },
    ],
  },
};
const MAX_SENTENCE_WORDS = 20;
const PRIMER_SENTENCES = 2;
const SENTENCE_END = /(?<=[.!?])\s+/;
const WORD = /\S+/g;

const run = (actions: readonly StartAction[], from: StartDraft = INITIAL_DRAFT) => actions.reduce(nextDraft, from);
const skipAll = run([{ kind: 'path', path: 'guide' }, ...GUIDE_STEPS.slice(1).map(() => ({ kind: 'skip' }) as const)]);
const textOf = (screen: StartScreen) => [
  screen.title,
  ...screen.text,
  ...screen.options.flatMap(({ label, detail }) => [label, detail]),
  ...(screen.entry === undefined ? [] : [screen.entry.label]),
];

test('rpg-42a.14 guide path skipping every step sends no choices, so the engine applies documented defaults', () => {
  assert.equal(stepOf(skipAll), 'summary');
  assert.deepEqual(createCommand(skipAll), {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: DEFAULT_ADVENTURE_NAME,
    choices: {},
    language: DEFAULT_LOCALE,
  });
  assert.deepEqual(planCommand(skipAll), { version: PROTOCOL_VERSION, type: 'PlanCampaign', choices: {} });
  assert.deepEqual(planCommand(skipAll, 'tui').choices, { client: 'tui' });
  assert.deepEqual(createCommand(skipAll, 'desktop').choices, { client: 'desktop' });
  const described = run([{ kind: 'path', path: 'describe' }, { kind: 'skip' }]);
  assert.deepEqual(createCommand(described), {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: DEFAULT_ADVENTURE_NAME,
    language: DEFAULT_LOCALE,
  });
});

test('rpg-42a.14 each guide step is skippable, choices advance and back returns to the previous step', () => {
  const chosen = run([
    { kind: 'path', path: 'guide' },
    { kind: 'next' },
    { kind: 'choose', field: 'genre', value: 'fantasy' },
    { kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } },
    { kind: 'enter', text: 'Ash, a tired knight' },
    { kind: 'toggle', field: 'voiceOutput' },
    { kind: 'next' },
    { kind: 'next' },
    { kind: 'enter', text: 'Ashfall' },
  ]);
  assert.equal(stepOf(chosen), 'summary');
  assert.deepEqual(createCommand(chosen), {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: 'Ashfall',
    choices: {
      genre: 'fantasy',
      ruleset: { id: 'narrative', edition: 'original' },
      character: 'Ash, a tired knight',
      voiceOutput: true,
    },
    language: DEFAULT_LOCALE,
    play: { spokenOutput: 'narrator' },
  });
  const back = run([{ kind: 'back' }, { kind: 'back' }, { kind: 'back' }, { kind: 'back' }], chosen);
  assert.equal(stepOf(back), 'rules');
  assert.deepEqual(run([{ kind: 'skip' }], back).choices.ruleset, undefined);
  const start = run(
    START_STEPS.guide.map(() => ({ kind: 'back' }) as const),
    chosen,
  );
  assert.equal(stepOf(start), 'path');
  assert.equal(stepOf(run([{ kind: 'back' }], start)), 'path');
});

test('rpg-42a.14 optional features default off and turning one off again restores default provenance', () => {
  const features = run([
    { kind: 'path', path: 'guide' },
    { kind: 'next' },
    { kind: 'skip' },
    { kind: 'skip' },
    { kind: 'skip' },
  ]);
  const screen = startScreen(features, OPTIONS, undefined);
  assert.equal(screen.step, 'features');
  assert.ok(screen.options.every(({ selected }) => !selected));
  const on = run(
    screen.options.map(({ action }) => action),
    features,
  );
  assert.deepEqual(on.choices, { diceVisualization: true, voiceOutput: true, simulation: 'balanced' });
  assert.ok(startScreen(on, OPTIONS, undefined).options.every(({ selected }) => selected));
  assert.deepEqual(
    run(
      screen.options.map(({ action }) => action),
      on,
    ).choices,
    {},
  );
});

test('rpg-42a.14 rules step lists only installed rulesets and sends other systems to import', () => {
  const rules = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }, { kind: 'skip' }]);
  const screen = startScreen(rules, OPTIONS, undefined);
  assert.equal(screen.step, 'rules');
  assert.deepEqual(
    screen.options.map(({ action }) => action),
    [
      ...[...OPTIONS.rulesets]
        .reverse()
        .map(({ id, edition }) => ({ kind: 'choose', field: 'ruleset', value: { id, edition } })),
      { kind: 'choose', field: 'rulesSource', value: 'none' },
    ],
  );
  assert.deepEqual(
    screen.options.map(({ label, badge }) => [label, badge]),
    [
      ['Story only: no dice, no sheet', 'Recommended'],
      ['Classic d20', undefined],
      ['No rules: the GM decides', undefined],
    ],
  );
  assert.equal(screen.text.length, 1);
  assert.match(screen.text[0] ?? '', /recommended option/);
  assert.equal(
    screen.importHint,
    'Want a system that is not listed? Import your rulebook. Run rpg import <file> first.',
  );
  assert.ok(!screen.text.some((line) => line.includes('rpg import')));
});

test('rpg-42a.14 character step offers ready-made characters of the chosen genre and the sheet fields', () => {
  const character = run([
    { kind: 'path', path: 'guide' },
    { kind: 'next' },
    { kind: 'choose', field: 'genre', value: 'fantasy' },
    { kind: 'choose', field: 'ruleset', value: { id: 'd20-lite', edition: 'original' } },
  ]);
  const screen = startScreen(character, OPTIONS, undefined);
  assert.equal(screen.step, 'character');
  assert.deepEqual(screen.options[0]?.action, { kind: 'choose', field: 'character', value: 'Hedge witch' });
  assert.ok(screen.text.some((line) => line.includes('Might')));
  assert.equal(screen.entry?.value, '');
});

test('rpg-42a.19 character step hides ready-made characters on rules without a sheet for them', () => {
  const sheetless: StartOptions = {
    ...OPTIONS,
    rulesets: OPTIONS.rulesets.map((ruleset) =>
      ruleset.id === 'd20-lite' ? { ...ruleset, readyMade: false } : ruleset,
    ),
  };
  const at = (ruleset: string) =>
    startScreen(
      run([
        { kind: 'path', path: 'guide' },
        { kind: 'next' },
        { kind: 'choose', field: 'genre', value: 'fantasy' },
        { kind: 'choose', field: 'ruleset', value: { id: ruleset, edition: 'original' } },
      ]),
      sheetless,
      undefined,
    );
  const hidden = at('d20-lite');
  assert.deepEqual(hidden.options, []);
  assert.ok(hidden.text.includes('Ready-made characters need a sheet on these rules. Describe your own.'));
  assert.equal(at('narrative').options.length, 1);
});

test('rpg-42a.142 summary labels a derived setting as the fallback, not as chosen', () => {
  const derived: Result<CampaignPlan> = PLAN.ok
    ? {
        ok: true,
        value: { ...PLAN.value, entries: [{ field: 'genre', value: 'blank-world', provenance: 'fallback' }] },
      }
    : PLAN;
  assert.ok(startScreen(skipAll, OPTIONS, derived).text[0]?.endsWith('(fallback)'));
  assert.ok(startScreen(skipAll, OPTIONS, derived, 'pt-BR').text[0]?.endsWith('(alternativa)'));
});

test('rpg-42a.14 summary shows chosen or default for each setting and an unknown edition asks for an import', () => {
  const summary = startScreen(skipAll, OPTIONS, PLAN);
  assert.equal(summary.canStart, true);
  assert.deepEqual(summary.text, ['Rules: Story only: no dice, no sheet (chosen)', 'Genre: none (default)']);
  assert.equal(summary.entry?.value, DEFAULT_ADVENTURE_NAME);
  const unknown = startScreen(skipAll, OPTIONS, failure('UnknownEdition', 'Ruleset D&D 1.9 is not installed.'));
  assert.equal(unknown.canStart, false);
  assert.match(unknown.error ?? '', /^Import your rulebook\. Ruleset D&D 1\.9 is not installed\.$/);
  const rejected = startScreen(skipAll, OPTIONS, failure('Rejected', 'A campaign named Ashfall already exists.'));
  assert.equal(rejected.error, 'A campaign named Ashfall already exists.');
  assert.equal(startScreen(skipAll, OPTIONS, undefined).canStart, false);
});

test('rpg-42a.30 summary groups each setting for review with its provenance and the step that edits it', () => {
  const plan: Result<CampaignPlan> = {
    ok: true,
    value: {
      version: PROTOCOL_VERSION,
      options: OPTIONS,
      entries: [
        { field: 'ruleset', value: 'narrative original', provenance: 'explicit' },
        { field: 'dice', value: 'as the ruleset decides', provenance: 'default' },
        { field: 'voiceOutput', value: 'on', provenance: 'explicit' },
        { field: 'mystery', value: 'x', provenance: 'default' },
      ],
    },
  };
  const at = (step: string) => GUIDE_STEPS.indexOf(step as (typeof GUIDE_STEPS)[number]);
  assert.deepEqual(startScreen(skipAll, OPTIONS, plan).review, [
    {
      title: 'Your story',
      items: [
        { field: 'ruleset', label: 'Rules', value: 'Story only: no dice, no sheet', chosen: true, step: at('rules') },
        { field: 'dice', label: 'Dice', value: 'as the ruleset decides', chosen: false, step: at('rules') },
        { field: 'mystery', label: 'mystery', value: 'x', chosen: false, step: 0 },
      ],
    },
    {
      title: 'Extras',
      items: [{ field: 'voiceOutput', label: 'Voice narration', value: 'on', chosen: true, step: at('features') }],
    },
  ]);
  const described = run([{ kind: 'path', path: 'describe' }, { kind: 'skip' }, { kind: 'skip' }]);
  const steps = startScreen(described, OPTIONS, plan).review?.flatMap(({ items }) => items.map(({ step }) => step));
  assert.deepEqual(steps, [0, 0, 0, 0]);
  assert.equal(startScreen(skipAll, OPTIONS, undefined).review, undefined);
  assert.equal(startScreen(INITIAL_DRAFT, OPTIONS, plan).review, undefined);
});

test('rpg-42a.30 edit jumps to a step of the current path and ignores steps outside it', () => {
  const rules = GUIDE_STEPS.indexOf('rules');
  assert.equal(stepOf(nextDraft(skipAll, { kind: 'edit', step: rules })), 'rules');
  for (const step of [-1, GUIDE_STEPS.length, 1.5]) assert.equal(nextDraft(skipAll, { kind: 'edit', step }), skipAll);
  assert.equal(nextDraft(INITIAL_DRAFT, { kind: 'edit', step: 0 }), INITIAL_DRAFT);
});

test('rpg-42a.14 saved progress round-trips and tampered progress falls back to the start', () => {
  const draft = run([
    { kind: 'path', path: 'guide' },
    { kind: 'next' },
    { kind: 'choose', field: 'genre', value: 'x' },
  ]);
  assert.deepEqual(parseStartDraft(JSON.parse(JSON.stringify(draft))), draft);
  for (const tampered of [
    undefined,
    'guide',
    [],
    { ...draft, step: GUIDE_STEPS.length },
    { ...draft, step: -1 },
    { ...draft, step: 1.5 },
    { ...draft, path: 'shell' },
    { ...draft, path: null, step: 1 },
    { ...draft, name: 'x'.repeat(MAX_CAMPAIGN_NAME_LENGTH + 1) },
    { ...draft, intent: 7 },
    { ...draft, choices: { run: 'rm -rf' } },
    { ...draft, choices: { ruleset: 'd20-lite' } },
    { ...draft, choices: { voiceOutput: 'yes' } },
    { ...draft, extra: true },
  ]) {
    assert.deepEqual(parseStartDraft(tampered), INITIAL_DRAFT, JSON.stringify(tampered));
  }
  assert.deepEqual(
    loadStartDraft(() => JSON.stringify(draft)),
    draft,
  );
  assert.deepEqual(
    loadStartDraft(() => '{broken'),
    INITIAL_DRAFT,
  );
  assert.deepEqual(
    loadStartDraft(() => {
      throw new Error('missing');
    }),
    INITIAL_DRAFT,
  );
});

test('rpg-42a.14 guided start copy uses short plain sentences and a two-sentence primer', () => {
  const describe = run([{ kind: 'path', path: 'describe' }]);
  const guide = GUIDE_STEPS.map((_, step) => ({ ...INITIAL_DRAFT, path: 'guide' as const, step }));
  const drafts = [INITIAL_DRAFT, describe, ...guide, { ...guide[3], choices: { genre: 'fantasy' } }] as StartDraft[];
  const screens = drafts.map((draft) => startScreen(draft, OPTIONS, PLAN));
  const primer = screens.find(({ step }) => step === 'primer');
  assert.equal(primer?.text.join(' ').split(SENTENCE_END).length, PRIMER_SENTENCES);
  for (const sentence of screens.flatMap(textOf).flatMap((text) => text.split(SENTENCE_END))) {
    assert.ok((sentence.match(WORD)?.length ?? 0) <= MAX_SENTENCE_WORDS, sentence);
  }
});

test('rpg-42a.39 every guided start locale has every catalog key', () => {
  assert.deepEqual(Object.keys(START_CATALOG), ['en', 'pt-BR']);
  assert.deepEqual(missingKeys(START_CATALOG), []);
});

test('rpg-42a.39 guided start reads in Brazilian Portuguese and names the default adventure in it', () => {
  const path = startScreen(INITIAL_DRAFT, OPTIONS, undefined, 'pt-BR');
  assert.equal(path.title, 'Nova aventura');
  assert.deepEqual(
    path.options.map(({ label }) => label),
    ['Descrever', 'Me guie'],
  );
  const rules = startScreen(
    run([{ kind: 'path', path: 'guide' }, { kind: 'next' }, { kind: 'skip' }]),
    OPTIONS,
    undefined,
    'pt-BR',
  );
  assert.deepEqual(
    [rules.options[0]?.label, rules.options[0]?.badge],
    ['Só história: sem dados, sem ficha', 'Recomendado'],
  );
  const summary = startScreen(skipAll, OPTIONS, PLAN, 'pt-BR');
  assert.deepEqual(summary.text, ['Regras: Só história: sem dados, sem ficha (escolhido)', 'Gênero: nenhum (padrão)']);
  assert.equal(summary.entry?.value, 'Minha aventura');
  assert.deepEqual(
    summary.review?.map(({ title }) => title),
    ['Sua história'],
  );
  const unknown = startScreen(skipAll, OPTIONS, failure('UnknownEdition', 'D&D 1.9'), 'pt-BR');
  assert.equal(unknown.error, 'Importe seu livro de regras. D&D 1.9');
  assert.equal(createCommand(skipAll, undefined, 'pt-BR').name, 'Minha aventura');
  assert.equal(createCommand(skipAll, undefined, 'pt-BR').language, 'pt-BR');
  assert.equal(createCommand({ ...skipAll, name: 'Ashfall' }, undefined, 'pt-BR').name, 'Ashfall');
});

const NARRATIVE_CHOICE = { kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } } as const;
const D20_CHOICE = { kind: 'choose', field: 'ruleset', value: { id: 'd20-lite', edition: 'original' } } as const;
const toRules = [
  { kind: 'path', path: 'guide' },
  { kind: 'next' },
  { kind: 'choose', field: 'genre', value: 'fantasy' },
] as const;

test('rpg-42a.54 rules cards use player names and never show internal ids', () => {
  const screen = startScreen(run(toRules), OPTIONS, undefined);
  assert.equal(screen.step, 'rules');
  const visible = [
    ...screen.text,
    ...screen.options.flatMap(({ label, detail, badge }) => [label, detail, badge ?? '']),
  ];
  for (const internal of ['d20-lite', 'dice-pool-lite', 'narrative', 'original'])
    assert.ok(!visible.some((line) => line.includes(internal)), internal);
  assert.equal(screen.options[1]?.label, 'Classic d20');
});

test('rpg-42a.54 an imported ruleset keeps its own id and edition as the name', () => {
  const imported = { id: 'acme', edition: '2e', blurb: 'Acme rules.', recommended: false, readyMade: true, sheet: [] };
  const screen = startScreen(run(toRules), { ...OPTIONS, rulesets: [...OPTIONS.rulesets, imported] }, undefined);
  assert.deepEqual([screen.options[2]?.label, screen.options[2]?.detail], ['acme 2e', 'Acme rules.']);
});

test('rpg-42a.38 character step says a sheetless game uses a name and description only', () => {
  const sheetless = startScreen(run([...toRules, NARRATIVE_CHOICE]), OPTIONS, undefined);
  assert.equal(sheetless.step, 'character');
  assert.ok(
    sheetless.text.includes(
      'This game does not use a character sheet. Give your character a name and a short description.',
    ),
  );
  const full = startScreen(run([...toRules, D20_CHOICE]), OPTIONS, undefined);
  assert.ok(!full.text.some((line) => line.includes('does not use a character sheet')));
});

test('rpg-42a.38 features step drops the dice animation for a diceless ruleset', () => {
  const featureLabels = (ruleset: typeof NARRATIVE_CHOICE | typeof D20_CHOICE) =>
    startScreen(run([...toRules, ruleset, { kind: 'skip' }]), OPTIONS, undefined).options.map(({ label }) => label);
  assert.deepEqual(featureLabels(NARRATIVE_CHOICE), ['Voice narration', 'Living world']);
  assert.deepEqual(featureLabels(D20_CHOICE), ['Dice animation', 'Voice narration', 'Living world']);
  assert.ok(
    startScreen(run([...toRules, NARRATIVE_CHOICE, { kind: 'skip' }]), OPTIONS, undefined).text.includes(
      'This game does not use dice.',
    ),
  );
});

test('rpg-42a.117 genre and rules pages drop the English notice for languages with translated packs', () => {
  const genre = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }]);
  const rules = run([{ kind: 'skip' }], genre);
  for (const draft of [genre, rules])
    for (const locale of ['pt-BR', 'es'])
      for (const notice of ['en', 'pt-BR'])
        assert.ok(
          !startScreen(draft, OPTIONS, undefined, locale).text.includes(
            String(START_CATALOG[notice]?.['packs.english']),
          ),
          `${locale} ${notice}`,
        );
});

test('rpg-42a.40 genre and rules pages tell players without translated packs that built-in packs are in English', () => {
  const genre = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }]);
  const rules = run([{ kind: 'skip' }], genre);
  assert.deepEqual([stepOf(genre), stepOf(rules)], ['genre', 'rules']);
  for (const draft of [genre, rules]) {
    assert.ok(startScreen(draft, OPTIONS, undefined, 'fr').text.includes(String(START_CATALOG.en?.['packs.english'])));
    assert.ok(
      !startScreen(draft, OPTIONS, undefined, DEFAULT_LOCALE).text.includes(
        String(START_CATALOG.en?.['packs.english']),
      ),
    );
  }
});

const BEGIN_STEP = GUIDE_STEPS.indexOf('begin');
const atBegin = (...actions: readonly StartAction[]) =>
  run(actions, { ...INITIAL_DRAFT, path: 'guide', step: BEGIN_STEP });
const selectedLabels = (screen: StartScreen) =>
  screen.options.filter(({ selected }) => selected).map(({ label }) => label);
const NO_VOICES = { ids: [], current: undefined };
const VOICES = { ids: ['af_heart', 'am_adam'], current: 'af_heart' };

test('rpg-42a.88 the begin step comes after the optional steps and before the summary on both paths', () => {
  assert.deepEqual(GUIDE_STEPS.slice(-2), ['begin', 'summary']);
  assert.deepEqual(START_STEPS.describe, ['describe', 'begin', 'summary']);
  assert.equal(stepOf(run([{ kind: 'next' }], atBegin())), 'summary');
});

test('rpg-42a.88 begin step prefills the app language, app-rolled dice and as-written rules', () => {
  const screen = startScreen(atBegin(), OPTIONS, undefined, 'pt-BR', NO_VOICES);
  assert.equal(screen.step, 'begin');
  assert.equal(screen.canNext, true);
  const answer = (field: string) =>
    screen.options.find(({ selected, action }) => selected && action.kind === 'set' && action.field === field)?.action;
  assert.deepEqual(answer('language'), { kind: 'set', field: 'language', value: 'pt-BR' });
  assert.deepEqual(answer('whoRolls'), { kind: 'set', field: 'whoRolls', value: 'app' });
  assert.deepEqual(answer('rulesStrictness'), { kind: 'set', field: 'rulesStrictness', value: 'as-written' });
  assert.deepEqual(
    screen.options.find(({ action }) => action.kind === 'toggle' && action.on === true)?.selected,
    false,
  );
});

test('rpg-42a.99 spoken story is an Off/On pair, Off by default, and the voice list shows only when On', () => {
  const spoken = (draft: StartDraft) =>
    startScreen(draft, OPTIONS, undefined, DEFAULT_LOCALE, VOICES).options.filter(
      ({ action }) => action.kind === 'toggle',
    );
  const voiceLabels = (draft: StartDraft) =>
    startScreen(draft, OPTIONS, undefined, DEFAULT_LOCALE, VOICES)
      .options.filter(({ action }) => action.kind === 'set' && action.field === 'narratorVoice')
      .map(({ label }) => label);
  assert.deepEqual(
    spoken(atBegin()).map(({ label, selected }) => [label, selected]),
    [
      ['Off', true],
      ['On', false],
    ],
  );
  assert.deepEqual(voiceLabels(atBegin()), []);
  const on = atBegin({ kind: 'toggle', field: 'voiceOutput', on: true });
  assert.equal(nextDraft(on, { kind: 'toggle', field: 'voiceOutput', on: true }), on);
  assert.deepEqual(
    spoken(on).map(({ selected }) => selected),
    [false, true],
  );
  assert.deepEqual(voiceLabels(on), ['af_heart', 'am_adam']);
  const off = nextDraft(on, { kind: 'toggle', field: 'voiceOutput', on: false });
  assert.deepEqual(off.choices, {});
  const labels = startScreen(on, OPTIONS, undefined, DEFAULT_LOCALE, VOICES).options.map(({ label }) => label);
  assert.ok(labels.indexOf('On') < labels.indexOf('af_heart'));
});

test('rpg-42a.99 changing the story language drops a narrator voice picked for the previous language', () => {
  const picked = atBegin({ kind: 'set', field: 'narratorVoice', value: 'am_adam' });
  assert.equal(picked.choices.narratorVoice, 'am_adam');
  const switched = nextDraft(picked, { kind: 'set', field: 'language', value: 'pt-BR' });
  assert.deepEqual(switched.choices, { language: 'pt-BR' });
});

test('rpg-42a.88 chosen play settings reach CreateCampaign as language and play, not as plan choices', () => {
  const draft = atBegin(
    { kind: 'set', field: 'language', value: 'pt-BR' },
    { kind: 'set', field: 'whoRolls', value: 'me' },
    { kind: 'set', field: 'rulesStrictness', value: 'relaxed' },
    { kind: 'toggle', field: 'voiceOutput' },
  );
  const command = createCommand(draft, 'desktop', 'en');
  assert.equal(command.language, 'pt-BR');
  assert.deepEqual(command.play, { whoRolls: 'me', rulesStrictness: 'relaxed', spokenOutput: 'narrator' });
  assert.deepEqual(command.choices, { voiceOutput: true, client: 'desktop' });
  assert.deepEqual(planCommand(draft, 'desktop').choices, { voiceOutput: true, client: 'desktop' });
});

test('rpg-42a.88 skipping the begin step keeps the defaults and sends no play settings', () => {
  const chosen = atBegin(
    { kind: 'set', field: 'language', value: 'pt-BR' },
    { kind: 'set', field: 'whoRolls', value: 'ask' },
  );
  const skipped = run([{ kind: 'skip' }], chosen);
  assert.equal(stepOf(skipped), 'summary');
  assert.deepEqual(skipped.choices, {});
  const command = createCommand(skipped, undefined, 'en');
  assert.equal(command.language, 'en');
  assert.equal('play' in command, false);
  assert.equal(createCommand(skipAll).language, DEFAULT_LOCALE);
});

test('rpg-42a.88 the voice question appears only when voices are installed and offers a preview for each', () => {
  const group = (screen: StartScreen) =>
    screen.options.filter(({ action }) => action.kind === 'set' && action.field === 'narratorVoice');
  assert.deepEqual(group(startScreen(atBegin(), OPTIONS, undefined)), []);
  const voiceOn = { kind: 'toggle', field: 'voiceOutput', on: true } as const;
  const voiced = group(startScreen(atBegin(voiceOn), OPTIONS, undefined, DEFAULT_LOCALE, VOICES));
  assert.deepEqual(
    voiced.map(({ label, selected }) => [label, selected]),
    [
      ['af_heart', true],
      ['am_adam', false],
    ],
  );
  assert.deepEqual(voiced[1]?.preview, { kind: 'preview', voice: 'am_adam' });
  const picked = atBegin(voiceOn, { kind: 'set', field: 'narratorVoice', value: 'am_adam' });
  assert.deepEqual(
    selectedLabels(startScreen(picked, OPTIONS, undefined, DEFAULT_LOCALE, VOICES)).filter((label) =>
      VOICES.ids.includes(label),
    ),
    ['am_adam'],
  );
  assert.equal(nextDraft(picked, { kind: 'preview', voice: 'af_heart' }), picked);
});

test('rpg-42a.88 a ruleset without dice hides the dice roller question', () => {
  const diceless = atBegin({ kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } });
  const rollers = (draft: StartDraft) =>
    startScreen(draft, OPTIONS, undefined).options.filter(
      ({ action }) => action.kind === 'set' && action.field === 'whoRolls',
    );
  assert.equal(rollers(run([{ kind: 'back' }, { kind: 'back' }], diceless)).length, 0);
  assert.equal(rollers(atBegin()).length, 3);
});

test('rpg-42a.88 saved progress rejects tampered play settings', () => {
  const draft = atBegin({ kind: 'set', field: 'whoRolls', value: 'me' });
  assert.deepEqual(parseStartDraft(JSON.parse(JSON.stringify(draft))), draft);
  for (const choices of [{ whoRolls: 'god' }, { rulesStrictness: 'chaos' }, { language: 7 }, { narratorVoice: '' }])
    assert.deepEqual(parseStartDraft({ ...draft, choices }), INITIAL_DRAFT, JSON.stringify(choices));
});

test('rpg-42a.53 built-in genre, character and stat names read in Brazilian Portuguese', () => {
  const genre = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }]);
  const genres = startScreen(genre, OPTIONS, undefined, 'pt-BR');
  assert.deepEqual(
    genres.options.map(({ label, detail }) => [label, detail]),
    [
      ['Fantasia', 'As pedras eretas zumbem quando a lua passa da serra, e esta noite ela está cheia.'],
      ['Terror crescente', 'O arranhar parou no instante em que você prendeu a respiração.'],
    ],
  );
  const character = startScreen(run([...toRules, D20_CHOICE]), OPTIONS, undefined, 'pt-BR');
  assert.equal(character.step, 'character');
  assert.deepEqual(
    character.options.map(({ label }) => label),
    ['Bruxa do campo'],
  );
  assert.ok(character.text.includes('Suas regras acompanham Força.'));
  assert.equal(character.options[0]?.action.kind, 'choose');
  assert.deepEqual(character.options[0]?.action.value, 'Hedge witch');
});

test('rpg-42a.148 characters translate by archetype id, never by display name or for imported genres', () => {
  const labelsFor = (genre: StartOptions['genres'][number]) =>
    startScreen(run([...toRules, D20_CHOICE]), { ...OPTIONS, genres: [genre] }, undefined, 'pt-BR').options.map(
      ({ label }) => label,
    );
  const [fantasy] = OPTIONS.genres;
  assert.ok(fantasy);
  assert.deepEqual(labelsFor({ ...fantasy, characters: [{ name: 'Hedge witch', summary: 'x' }] }), ['Hedge witch']);
  assert.deepEqual(labelsFor({ ...fantasy, imported: true }), ['Hedge witch']);
});

test('rpg-42a.53 plan values read in Brazilian Portuguese while the saved values stay the ids', () => {
  const plan: Result<CampaignPlan> = {
    ok: true,
    value: {
      ...(PLAN.ok ? PLAN.value : { version: PROTOCOL_VERSION, options: OPTIONS }),
      entries: [
        { field: 'genre', value: 'fantasy', provenance: 'explicit' },
        { field: 'character', value: 'Hedge witch', provenance: 'explicit' },
        { field: 'dice', value: 'as the ruleset decides', provenance: 'default' },
        { field: 'voiceOutput', value: 'off', provenance: 'default' },
        { field: 'simulation', value: 'none', provenance: 'default' },
      ],
    },
  };
  assert.deepEqual(startScreen(skipAll, OPTIONS, plan, 'pt-BR').text, [
    'Gênero: Fantasia (escolhido)',
    'Personagem: Bruxa do campo (escolhido)',
    'Dados: como as regras decidem (padrão)',
    'Narração por voz: desligado (padrão)',
    'Mundo vivo: nenhum (padrão)',
  ]);
  assert.deepEqual(startScreen(skipAll, OPTIONS, plan).text.slice(0, 3), [
    'Genre: Fantasy (chosen)',
    'Character: Hedge witch (chosen)',
    'Dice: as the ruleset decides (default)',
  ]);
});

test('rpg-42a.69 an unknown genre id reads as a humanized name and built-in rulesets keep their player name', () => {
  assert.equal(genreLabel('en', 'investigative-mystery'), 'Investigative mystery');
  assert.equal(genreLabel('pt-BR', 'fantasy'), 'Fantasia');
  assert.equal(rulesetLabel('en', { id: 'd20-lite', edition: 'original' }), 'Classic d20');
  assert.equal(rulesetLabel('en', { id: 'custom', edition: '5e' }), 'custom 5e');
});

test('rpg-42a.126 imported genre and ruleset names are not translated', () => {
  const imported: StartOptions = {
    genres: [{ ...OPTIONS.genres[0]!, imported: true }],
    rulesets: [{ ...OPTIONS.rulesets[0]!, id: 'my-rules', edition: 'custom' }],
  };
  const genre = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }]);
  assert.equal(startScreen(genre, imported, undefined, 'pt-BR').options[0]?.label, 'Fantasy');
  const character = startScreen(
    run([...toRules, { ...D20_CHOICE, value: { id: 'my-rules', edition: 'custom' } }]),
    imported,
    undefined,
    'pt-BR',
  );
  assert.ok(character.text.some((line) => line.includes('Might')));
  assert.ok(!character.text.some((line) => line.includes('Força')));
});

test('rpg-asjw.12 skipping the rules step chooses the recommended ruleset and other steps just skip', () => {
  const rules = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }, { kind: 'skip' }]);
  assert.deepEqual(skipAction(startScreen(rules, OPTIONS, undefined)), {
    kind: 'choose',
    field: 'ruleset',
    value: { id: 'narrative', edition: 'original' },
  });
  assert.deepEqual(skipAction(startScreen(run([{ kind: 'path', path: 'guide' }]), OPTIONS, undefined)), {
    kind: 'skip',
  });
});
