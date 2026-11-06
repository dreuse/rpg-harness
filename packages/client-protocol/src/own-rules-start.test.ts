import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCommand,
  INITIAL_DRAFT,
  nextDraft,
  parseStartDraft,
  planCommand,
  START_CATALOG,
  type StartAction,
  type StartDraft,
  startScreen,
} from './guided-start.ts';
import { missingKeys } from './locale.ts';
import { type CampaignPlan, PROTOCOL_VERSION, parseCommand, type Result, type StartOptions } from './protocol.ts';

const OPTIONS: StartOptions = {
  genres: [],
  rulesets: [
    {
      id: 'd20-lite',
      edition: 'original',
      blurb: 'Rules for checks and dice.',
      recommended: true,
      readyMade: true,
      sheet: ['Might'],
    },
  ],
};
const D20 = { id: 'd20-lite', edition: 'original' };
const FILES = ['two-dice.md', 'combat.txt'];
const OWN: StartAction = { kind: 'set', field: 'rulesSource', value: 'own' };
const NONE: StartAction = { kind: 'choose', field: 'rulesSource', value: 'none' };
const run = (actions: readonly StartAction[], from: StartDraft = INITIAL_DRAFT) => actions.reduce(nextDraft, from);
const atRules = run([{ kind: 'path', path: 'guide' }, { kind: 'next' }, { kind: 'skip' }]);
const ownDraft = run([OWN, { kind: 'set', field: 'ownRules', value: FILES }], atRules);
const planOf = (value: string): Result<CampaignPlan> => ({
  ok: true,
  value: {
    version: PROTOCOL_VERSION,
    options: OPTIONS,
    entries: [{ field: 'ruleset', value, provenance: 'explicit' }],
  },
});

test('rpg-42a.82 rules step offers none always and my own files only where the client can pick files', () => {
  const labels = (canPickFiles: boolean) =>
    startScreen(atRules, OPTIONS, undefined, 'en', undefined, canPickFiles).options.map(({ label }) => label);
  assert.deepEqual(labels(false), ['Classic d20', 'No rules: the GM decides']);
  assert.deepEqual(labels(true), ['Classic d20', 'My own files', 'No rules: the GM decides']);
});

test('rpg-42a.82 choosing my own files stays on the step, marks the option and lists the added files', () => {
  const chosen = run([OWN], atRules);
  assert.equal(chosen.step, atRules.step);
  const before = startScreen(chosen, OPTIONS, undefined, 'en', undefined, true);
  assert.equal(before.options.find(({ selected }) => selected)?.label, 'My own files');
  assert.ok(before.text.some((line) => /No rules files added yet/.test(line)));
  const after = startScreen(ownDraft, OPTIONS, undefined, 'en', undefined, true);
  assert.ok(after.text.some((line) => line.includes('two-dice.md, combat.txt')));
});

test('rpg-42a.82 the rules step can move on only after own files were added', () => {
  const next = (draft: StartDraft) => startScreen(draft, OPTIONS, undefined, 'en', undefined, true).canNext;
  assert.equal(next(run([OWN], atRules)), false);
  assert.equal(next(ownDraft), true);
  assert.equal(next(atRules), false);
});

test('rpg-42a.82 own files and none send no ruleset to the plan and own files ride on create only', () => {
  assert.deepEqual(planCommand(ownDraft).choices, { ruleset: null });
  assert.deepEqual(planCommand(run([NONE], atRules)).choices, { ruleset: null });
  assert.deepEqual(createCommand(ownDraft).rulesDocuments, FILES);
  assert.equal('rulesDocuments' in createCommand(run([NONE], ownDraft)), false);
  assert.equal('rulesDocuments' in createCommand(run([OWN], atRules)), false);
});

test('rpg-42a.82 picking a built-in ruleset drops the own files choice and the reverse', () => {
  const builtIn = run([{ kind: 'choose', field: 'ruleset', value: D20 }], ownDraft);
  assert.deepEqual(builtIn.choices, { ruleset: D20 });
  const back = run([OWN], builtIn);
  assert.deepEqual(back.choices, { rulesSource: 'own' });
});

test('rpg-42a.82 own files show as a rules choice in the summary and need no sheet', () => {
  const summary = startScreen({ ...ownDraft, path: 'guide', step: 6 }, OPTIONS, planOf('none'), 'en', undefined, true);
  assert.ok(summary.text.some((line) => line.includes('my own files')));
  assert.ok(!summary.text.some((line) => line.includes('Rules: none')));
});

test('rpg-42a.82 a saved draft with the new choices loads and a bad one is dropped', () => {
  assert.deepEqual(parseStartDraft(JSON.parse(JSON.stringify(ownDraft))), ownDraft);
  const bad = { ...ownDraft, choices: { rulesSource: 'own', ownRules: [1] } };
  assert.deepEqual(parseStartDraft(bad), INITIAL_DRAFT);
  assert.deepEqual(parseStartDraft({ ...ownDraft, choices: { rulesSource: 'built-in' } }), INITIAL_DRAFT);
});

test('rpg-42a.82 CreateCampaign accepts a list of rules file names and refuses other shapes', () => {
  const create = { version: PROTOCOL_VERSION, type: 'CreateCampaign', name: 'Ashfall' };
  assert.equal(parseCommand({ ...create, rulesDocuments: FILES }).ok, true);
  assert.equal(parseCommand({ ...create, rulesDocuments: 'two-dice.md' }).ok, false);
  assert.equal(parseCommand({ ...create, rulesDocuments: [''] }).ok, false);
  assert.equal(parseCommand({ ...create, rulesDocuments: Array.from({ length: 21 }, (_, i) => `f${i}.md`) }).ok, false);
});

test('rpg-42a.82 every locale has the new rules texts', () => {
  assert.deepEqual(missingKeys(START_CATALOG), []);
});
