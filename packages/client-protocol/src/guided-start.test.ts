import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCommand,
  DEFAULT_ADVENTURE_NAME,
  GUIDE_STEPS,
  INITIAL_DRAFT,
  loadStartDraft,
  nextDraft,
  parseStartDraft,
  planCommand,
  START_CATALOG,
  START_STEPS,
  type StartAction,
  type StartDraft,
  type StartScreen,
  startScreen,
  stepOf,
} from './guided-start.ts';
import { missingKeys } from './locale.ts';
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
      characters: [{ name: 'Hedge witch', summary: 'Trades remedies for secrets' }],
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
    { id: 'narrative', edition: 'original', blurb: 'Light rules.', recommended: true, readyMade: true, sheet: [] },
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
  });
  assert.deepEqual(planCommand(skipAll), { version: PROTOCOL_VERSION, type: 'PlanCampaign', choices: {} });
  assert.deepEqual(planCommand(skipAll, 'tui').choices, { client: 'tui' });
  assert.deepEqual(createCommand(skipAll, 'desktop').choices, { client: 'desktop' });
  const described = run([{ kind: 'path', path: 'describe' }, { kind: 'skip' }]);
  assert.deepEqual(createCommand(described), {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: DEFAULT_ADVENTURE_NAME,
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
  });
  const back = run([{ kind: 'back' }, { kind: 'back' }, { kind: 'back' }], chosen);
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
    OPTIONS.rulesets.map(({ id, edition }) => ({ kind: 'choose', field: 'ruleset', value: { id, edition } })),
  );
  assert.match(screen.options[1]?.label ?? '', /recommended/);
  assert.doesNotMatch(screen.options[0]?.label ?? '', /recommended/);
  assert.ok(screen.text.some((line) => line.includes('Import your rulebook')));
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

test('rpg-42a.14 summary shows chosen or default for each setting and an unknown edition asks for an import', () => {
  const summary = startScreen(skipAll, OPTIONS, PLAN);
  assert.equal(summary.canStart, true);
  assert.deepEqual(summary.text, ['Rules: narrative original (chosen)', 'Genre: none (default)']);
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
        { field: 'ruleset', label: 'Rules', value: 'narrative original', chosen: true, step: at('rules') },
        { field: 'dice', label: 'Dice', value: 'as the ruleset decides', chosen: false, step: at('rules') },
        { field: 'mystery', label: 'mystery', value: 'x', chosen: false, step: 0 },
      ],
    },
    {
      title: 'Extras',
      items: [{ field: 'voiceOutput', label: 'Voice narration', value: 'on', chosen: true, step: at('features') }],
    },
  ]);
  const described = run([{ kind: 'path', path: 'describe' }, { kind: 'skip' }]);
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
  assert.equal(rules.options[1]?.label, 'narrative original (recomendado para iniciantes)');
  const summary = startScreen(skipAll, OPTIONS, PLAN, 'pt-BR');
  assert.deepEqual(summary.text, ['Regras: narrative original (escolhido)', 'Gênero: none (padrão)']);
  assert.equal(summary.entry?.value, 'Minha aventura');
  assert.deepEqual(
    summary.review?.map(({ title }) => title),
    ['Sua história'],
  );
  const unknown = startScreen(skipAll, OPTIONS, failure('UnknownEdition', 'D&D 1.9'), 'pt-BR');
  assert.equal(unknown.error, 'Importe seu livro de regras. D&D 1.9');
  assert.equal(createCommand(skipAll, undefined, 'pt-BR').name, 'Minha aventura');
  assert.equal(createCommand({ ...skipAll, name: 'Ashfall' }, undefined, 'pt-BR').name, 'Ashfall');
});
