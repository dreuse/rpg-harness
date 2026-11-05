import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { DEFAULT_ADVENTURE_NAME, START_DRAFT_FILE } from '../../../packages/client-protocol/src/guided-start.ts';
import { FANTASY_PACK } from '../../../packages/content/src/packs.ts';
import { createCampaignFrom, createEngineGateway, listCampaignSummaries, readCampaignState } from './engine-gateway.ts';
import { visualizationPreferenceOf } from './roll-visualization.ts';
import { guidedStart } from './tui-start.ts';

const TEMP_PREFIX = 'rpg-guided-start-';
const DESCRIBE = '1';
const GUIDE = '2';
const CONTINUE = '';
const SKIP = 's';
const QUIT = 'q';
const START = 'y';
const FIRST = '1';
const NARRATIVE = '3';
const HORROR_INTENT = 'A horror story using the Narrative rules';
const DICE_ANIMATION_INTENT = 'A fantasy story using the d20-lite rules with dice animation';
const GUIDED_NAME = 'Ashfall';
const PLAYER_ACTION = 'I look around';
const SKIPPED_SUMMARY = [
  'Rules: none (default)',
  'Genre: none (default)',
  'Character: none (default)',
  'Dice: as the ruleset decides (default)',
  'Dice animation: off (default)',
  'Voice narration: off (default)',
  'Living world: off (default)',
];

const lines = async function* (input: readonly string[]) {
  yield* input;
};

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const answer = async (dataDir: string, input: readonly string[]) => {
  const out: string[] = [];
  for await (const text of guidedStart(dataDir, lines(input), createCampaignFrom)) out.push(text);
  return out;
};

const summaryOf = (dataDir: string, name: string) => listCampaignSummaries(dataDir).find((item) => item.name === name);

const playOneTurn = async (dataDir: string, name: string) => {
  const out: string[] = [];
  for await (const text of createEngineGateway(dataDir).open(name, 'play', lines([PLAYER_ACTION]), assert.ifError))
    out.push(text);
  return out;
};

test('rpg-42a.14 tui describe it path creates a playable campaign from one sentence', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [DESCRIBE, HORROR_INTENT, START]);
  assert.match(out.at(-2) ?? '', /Genre: horror \(chosen\)/);
  assert.match(out.at(-1) ?? '', /rpg play "My adventure"/);
  assert.equal(summaryOf(dataDir, DEFAULT_ADVENTURE_NAME)?.genre?.id, 'horror');
  assert.ok((await playOneTurn(dataDir, DEFAULT_ADVENTURE_NAME)).length > 1);
  assert.ok(!existsSync(join(dataDir, START_DRAFT_FILE)));
});

test('rpg-42a.8 tui describe it path saves dice animation on from free text', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [DESCRIBE, DICE_ANIMATION_INTENT, START]);
  assert.match(out.at(-2) ?? '', /Dice animation: on/);
  const { events } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.deepEqual(visualizationPreferenceOf(events), { enabled: true });
});

test('rpg-42a.14 tui guide me path walks numbered steps and creates a playable campaign', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [GUIDE, CONTINUE, FIRST, NARRATIVE, FIRST, CONTINUE, GUIDED_NAME, START]);
  assert.match(out[1] ?? '', /^Step 1 of 6: What is a tabletop RPG\?/);
  assert.match(out[3] ?? '', /Import your rulebook/);
  assert.match(out[3] ?? '', /3\. narrative original \(recommended for new players\)/);
  const summary = summaryOf(dataDir, GUIDED_NAME);
  assert.deepEqual([summary?.ruleset?.id, summary?.ruleset?.provenance], ['narrative', 'explicit']);
  assert.deepEqual([summary?.genre?.id, summary?.genre?.provenance], ['fantasy', 'explicit']);
  assert.equal(readCampaignState(dataDir, GUIDED_NAME).characters[0]?.name, FANTASY_PACK.genre.archetypes[0]?.name);
  assert.ok((await playOneTurn(dataDir, GUIDED_NAME)).length > 1);
});

test('rpg-42a.14 tui skipping every step shows documented defaults with default provenance', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [GUIDE, CONTINUE, SKIP, SKIP, SKIP, CONTINUE, START]);
  const summary = out.at(-2)?.split('\n') ?? [];
  for (const line of SKIPPED_SUMMARY) assert.ok(summary.includes(line), line);
  assert.equal(summaryOf(dataDir, DEFAULT_ADVENTURE_NAME)?.health, 'ok');
});

test('rpg-42a.14 tui never substitutes an uninstalled edition and asks for an import', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [DESCRIBE, 'Play D&D 1.9 in a noir mystery', START]);
  assert.match(out.join('\n'), /Import your rulebook\. Ruleset D&D 1\.9 is not installed/);
  assert.deepEqual(listCampaignSummaries(dataDir), []);
});

test('rpg-42a.14 tui closing mid-wizard and reopening restores the step outside campaign data', async (t) => {
  const dataDir = tempDataDir(t);
  const stopped = await answer(dataDir, [GUIDE, CONTINUE, FIRST, QUIT]);
  assert.match(stopped.at(-1) ?? '', /rpg start/);
  await answer(dataDir, [SKIP]);
  assert.deepEqual(readdirSync(dataDir), [START_DRAFT_FILE]);
  const reopened = await answer(dataDir, []);
  assert.match(reopened[0] ?? '', /^Step 4 of 6: Pick your character/);
  assert.ok(reopened[0]?.includes(`1. ${FANTASY_PACK.genre.archetypes[0]?.name}`));
});
