import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextPacket, CONTEXT_BUDGETS, type PacketInput, REQUIRED_SECTION_CAPS } from './packet.ts';
import { estimateTokens } from './retrieval.ts';
import { condense, rulesetItems, selectSections } from './rules.ts';

const FILLER = 'general guidance applies to every table and every campaign. ';
const TOPICS = ['Combat', 'Magic', 'Travel', 'Crafting', 'Social Encounters', 'Downtime'];
const KEYWORDS: Record<string, string> = {
  Combat: 'initiative sword armor damage wound',
  Magic: 'spell mana ritual arcane incantation',
  Travel: 'journey wagon road weather camp',
  Crafting: 'forge anvil recipe workshop ingredient',
  'Social Encounters': 'persuade bargain charm negotiate bribe',
  Downtime: 'rest tavern recover training',
};
const rulebook = (copies: number) =>
  TOPICS.map((topic) => `# ${topic}\n${KEYWORDS[topic]} ${FILLER.repeat(copies)}`).join('\n\n');

const emptyInput = (): PacketInput => ({
  instructions: ['Narrate.'],
  ruleset: [],
  setting: ['grim'],
  style: [],
  campaignSummary: [],
  chapterSummaries: [],
  sceneSummaries: [],
  context: [],
  ledger: [],
  threads: [],
  entities: [],
  recentTurns: [],
  recentClosings: [],
  results: [],
  playerInput: ['x'],
});

test('rpg-42a.65 condense turns a huge rulebook into a short summary and a sections list', () => {
  const text = rulebook(400);
  const condensed = condense(text);
  assert.deepEqual(
    condensed.sections.map(({ title }) => title),
    TOPICS,
  );
  assert.ok(estimateTokens(condensed.summary) < estimateTokens(text) / 50);
  for (const topic of TOPICS) assert.ok(condensed.summary.includes(topic));
  assert.deepEqual(condense(text), condensed);
});

test('rpg-42a.65 a text without headings is split into paragraph sections', () => {
  const { sections } = condense('first rule about fire\n\nsecond rule about ice');
  assert.equal(sections.length, 2);
});

test('rpg-42a.65 different inputs select different sections', () => {
  const { sections } = condense(rulebook(2));
  const titles = (input: string, recent: string[] = []) =>
    selectSections(sections, input, recent, 2_000).map(({ title }) => title);
  assert.deepEqual(titles('I draw my sword and strike, ignoring the armor'), ['Combat']);
  assert.deepEqual(titles('I cast a spell and chant the incantation'), ['Magic']);
  assert.deepEqual(titles('I want to bargain and bribe the guard'), ['Social Encounters']);
  assert.deepEqual(titles('hello there'), []);
});

test('rpg-42a.65 recent turns break ties but the player input ranks first', () => {
  const { sections } = condense(rulebook(2));
  const titles = selectSections(sections, 'I swing my sword', ['we studied a ritual and a spell'], 2_000).map(
    ({ title }) => title,
  );
  assert.deepEqual(titles, ['Combat', 'Magic']);
});

test('rpg-42a.65 the budget limits how many sections are selected', () => {
  const { sections } = condense(rulebook(2));
  const all = 'sword spell journey forge bargain tavern';
  assert.equal(selectSections(sections, all, [], 2_000).length, TOPICS.length);
  assert.equal(selectSections(sections, all, [], 1).length, 0);
});

test('rpg-42a.65 a huge rulebook enters the packet as summary plus relevant sections under the cap', () => {
  const condensed = condense(rulebook(400));
  const build = (input: string) =>
    buildContextPacket(
      { ...emptyInput(), ruleset: rulesetItems(condensed, input, [], REQUIRED_SECTION_CAPS.ruleset) },
      CONTEXT_BUDGETS.standard,
    );
  const itemsOf = (input: string) => build(input).sections.find(({ name }) => name === 'ruleset')?.items ?? [];
  const combat = itemsOf('I swing my sword');
  const magic = itemsOf('I cast a spell').slice(1);
  assert.equal(combat[0], condensed.summary);
  assert.ok(combat.length > 1 && combat.some((item) => item.includes('# Combat')));
  assert.ok(magic.some((item) => item.includes('# Magic')) && !magic.some((item) => item.includes('# Combat')));
  assert.ok(estimateTokens(JSON.stringify(combat)) <= REQUIRED_SECTION_CAPS.ruleset);
  assert.equal(build('I swing my sword').truncated, 0);
});

test('rpg-42a.65 a huge rulebook with no relevant section carries only the summary', () => {
  const condensed = condense(rulebook(400));
  assert.deepEqual(rulesetItems(condensed, 'hello', [], REQUIRED_SECTION_CAPS.ruleset), [condensed.summary]);
});

test('rpg-42a.65 condense never cuts an emoji in half', () => {
  const dragons = '\u{1F409}'.repeat(600);
  const condensed = condense(`# T${dragons}\na${dragons}`);
  const texts = [condensed.summary, ...condensed.sections.flatMap(({ title, text }) => [title, text])];
  for (const text of texts) assert.equal(text, text.toWellFormed());
});

test('selects the section that mentions a short all-caps token from the player input', () => {
  const { sections } = condense(
    '# Defense\nYour AC sets how hard you are to hit.\n\n# Travel\nThe road is long and dusty.',
  );
  const chosen = selectSections(sections, 'I check my AC', [], 1_000);
  assert.deepEqual(
    chosen.map(({ title }) => title),
    ['Defense'],
  );
});

test('rpg-42a.121 condense of an empty text gives an empty summary and no sections', () => {
  assert.deepEqual(condense(''), { summary: '', sections: [] });
  assert.deepEqual(condense('  \n\n '), { summary: '', sections: [] });
});

test('rpg-42a.121 text before the first heading is kept as an introduction section', () => {
  const { sections, summary } = condense('The table uses a d20 for every check.\n\n# Combat\nsword armor damage');
  assert.deepEqual(
    sections.map(({ title }) => title),
    ['Introduction', 'Combat'],
  );
  assert.equal(sections[0]?.text, 'The table uses a d20 for every check.');
  assert.ok(summary.includes('Introduction; Combat'));
  assert.deepEqual(
    selectSections(sections, 'I roll a d20 check', [], 1_000).map(({ title }) => title),
    ['Introduction'],
  );
});

test('rpg-42a.121 section cost counts the packet escaping of angle brackets', () => {
  const section = { title: 'Combat', text: `sword ${'<'.repeat(400)}` };
  assert.equal(selectSections([section], 'sword', [], 200).length, 0);
  assert.equal(selectSections([section], 'sword', [], 2_000).length, 1);
});
