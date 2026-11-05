import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { DEFAULT_ADVENTURE_NAME, START_DRAFT_FILE } from '../../../packages/client-protocol/src/guided-start.ts';
import { FANTASY_PACK } from '../../../packages/content/src/packs.ts';
import { campaignLanguageOf } from '../../../packages/engine/src/engine.ts';
import { gmSettingsOf } from '../../../packages/engine/src/gm-settings.ts';
import { voiceSettingsOf } from '../../../packages/engine/src/voice-settings.ts';
import {
  createCampaignFrom,
  createEngineGateway,
  FAKE_GAME_MASTER,
  type GameMaster,
  listCampaignSummaries,
  readCampaignState,
} from './engine-gateway.ts';
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
const NARRATIVE = '1';
const HORROR_INTENT = 'A horror story using the Narrative rules';
const DICE_ANIMATION_INTENT = 'A fantasy story using the d20-lite rules with dice animation';
const GUIDED_NAME = 'Ashfall';
const PLAYER_ACTION = 'I look around';
const PITCH = 'a fantasy adventure in a drowned chapel';
const PITCH_NARRATION = 'Water laps at the pews of the drowned chapel.';
const PITCH_GM: GameMaster = {
  request: async () => ({
    narration: PITCH_NARRATION,
    segments: [{ text: PITCH_NARRATION }],
    proposals: [
      {
        kind: 'entity',
        id: 'drowned-chapel',
        entityKind: 'location',
        name: 'The Drowned Chapel',
        visibility: 'player',
      },
    ],
  }),
  summarizer: FAKE_GAME_MASTER.summarizer,
};
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
  const out = await answer(dataDir, [DESCRIBE, HORROR_INTENT, CONTINUE, CONTINUE, START]);
  assert.match(out.at(-2) ?? '', /Genre: horror \(chosen\)/);
  assert.match(out.at(-1) ?? '', /rpg play "My adventure"/);
  assert.equal(summaryOf(dataDir, DEFAULT_ADVENTURE_NAME)?.genre?.id, 'horror');
  assert.ok((await playOneTurn(dataDir, DEFAULT_ADVENTURE_NAME)).length > 1);
  assert.ok(!existsSync(join(dataDir, START_DRAFT_FILE)));
});

test('rpg-42a.8 tui describe it path saves dice animation on from free text', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [DESCRIBE, DICE_ANIMATION_INTENT, CONTINUE, CONTINUE, START]);
  assert.match(out.at(-2) ?? '', /Dice animation: on/);
  const { events } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.deepEqual(visualizationPreferenceOf(events), { enabled: true });
});

test('rpg-42a.14 tui guide me path walks numbered steps and creates a playable campaign', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [GUIDE, CONTINUE, FIRST, NARRATIVE, FIRST, CONTINUE, CONTINUE, GUIDED_NAME, START]);
  assert.match(out[1] ?? '', /^Step 1 of 7: What is a tabletop RPG\?/);
  assert.match(out[3] ?? '', /Import your rulebook/);
  assert.match(out[3] ?? '', /1\. Story only: no dice, no sheet \[Recommended\]/);
  const summary = summaryOf(dataDir, GUIDED_NAME);
  assert.deepEqual([summary?.ruleset?.id, summary?.ruleset?.provenance], ['narrative', 'explicit']);
  assert.deepEqual([summary?.genre?.id, summary?.genre?.provenance], ['fantasy', 'explicit']);
  assert.equal(readCampaignState(dataDir, GUIDED_NAME).characters[0]?.name, FANTASY_PACK.genre.archetypes[0]?.name);
  assert.ok((await playOneTurn(dataDir, GUIDED_NAME)).length > 1);
});

test('rpg-42a.14 tui skipping every step shows documented defaults with default provenance', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [GUIDE, CONTINUE, SKIP, SKIP, SKIP, CONTINUE, SKIP, START]);
  const summary = out.at(-2)?.split('\n') ?? [];
  for (const line of SKIPPED_SUMMARY) assert.ok(summary.includes(line), line);
  assert.equal(summaryOf(dataDir, DEFAULT_ADVENTURE_NAME)?.health, 'ok');
});

test('rpg-42a.14 tui never substitutes an uninstalled edition and asks for an import', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [DESCRIBE, 'Play D&D 1.9 in a noir mystery', CONTINUE, CONTINUE, START]);
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
  assert.match(reopened[0] ?? '', /^Step 4 of 7: Pick your character/);
  assert.ok(reopened[0]?.includes(`1. ${FANTASY_PACK.genre.archetypes[0]?.name}`));
});

test('rpg-42a.46 tui describe it path opens from the GM with the pitch', async (t) => {
  const dataDir = tempDataDir(t);
  const out: string[] = [];
  const pitchLines = lines([DESCRIBE, PITCH, CONTINUE, CONTINUE, START]);
  for await (const text of guidedStart(dataDir, pitchLines, (target, command, client) =>
    createCampaignFrom(target, command, client, PITCH_GM),
  ))
    out.push(text);
  const { currentScene, turns } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.equal(currentScene?.title, 'The Drowned Chapel');
  assert.equal(turns[0]?.narration, PITCH_NARRATION);
  assert.match(out.at(-1) ?? '', /rpg play "My adventure"/);
});

const PORTUGUESE_OPTION = '2';
const ME_ROLLS_OPTION = '4';
const RELAXED_OPTION = '7';
const TO_BEGIN = [GUIDE, CONTINUE, SKIP, SKIP, SKIP, CONTINUE];
const OPENING_LANGUAGE = 'pt-BR';

const recordingGm = (
  requests: { language?: string | undefined; yielded: number }[],
  yielded: () => number,
): GameMaster => ({
  request: async (packet) => {
    requests.push({
      language: JSON.stringify(packet).includes(OPENING_LANGUAGE) ? OPENING_LANGUAGE : undefined,
      yielded: yielded(),
    });
    return { narration: PITCH_NARRATION, segments: [{ text: PITCH_NARRATION }] };
  },
  summarizer: FAKE_GAME_MASTER.summarizer,
});

test('rpg-42a.88 tui asks before the first scene and requests the opening only after Begin, in the chosen language', async (t) => {
  const dataDir = tempDataDir(t);
  const requests: { language?: string | undefined; yielded: number }[] = [];
  const out: string[] = [];
  const input = [...TO_BEGIN, PORTUGUESE_OPTION, ME_ROLLS_OPTION, RELAXED_OPTION, CONTINUE, START];
  const gm = recordingGm(requests, () => out.length);
  for await (const text of guidedStart(dataDir, lines(input), (target, command, client) =>
    createCampaignFrom(target, command, client, gm),
  ))
    out.push(text);
  assert.match(out[TO_BEGIN.length] ?? '', /Before we begin/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.yielded, input.length);
  assert.equal(requests[0]?.language, OPENING_LANGUAGE);
  const { changes } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.equal(campaignLanguageOf(changes), OPENING_LANGUAGE);
  assert.equal(voiceSettingsOf(changes), undefined);
  assert.deepEqual(gmSettingsOf(changes), { whoRolls: 'me', rulesStrictness: 'relaxed' });
});

test('rpg-42a.88 tui skip on the begin step keeps the defaults and saves no play settings', async (t) => {
  const dataDir = tempDataDir(t);
  const out = await answer(dataDir, [...TO_BEGIN, SKIP, START]);
  assert.match(out[TO_BEGIN.length] ?? '', /Before we begin/);
  const { changes } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.equal(campaignLanguageOf(changes), 'en');
  assert.equal(voiceSettingsOf(changes), undefined);
  assert.deepEqual(gmSettingsOf(changes), {});
});

test('rpg-42a.88 chosen spoken output is saved as voice settings in the campaign language before the opening', async (t) => {
  const dataDir = tempDataDir(t);
  const command = {
    version: 1,
    type: 'CreateCampaign',
    name: GUIDED_NAME,
    language: OPENING_LANGUAGE,
    play: { spokenOutput: 'narrator' },
  } as const;
  await createCampaignFrom(dataDir, command);
  const { changes } = readCampaignState(dataDir, GUIDED_NAME);
  assert.deepEqual(voiceSettingsOf(changes), {
    microphone: 'off',
    spokenOutput: 'narrator',
    locale: OPENING_LANGUAGE,
    speed: 1,
  });
});

test('rpg-42a.88 tui begin step lists each question with its default marked in English and Portuguese', async (t) => {
  const dataDir = tempDataDir(t);
  const english = (await answer(dataDir, [...TO_BEGIN])).at(-1);
  assert.match(english ?? '', /Story language:\n {2}1\. English \(on\)/);
  assert.match(english ?? '', /Who rolls the dice:\n {2}3\. The app \(on\)/);
  assert.match(english ?? '', /Rules strictness:\n {2}6\. As written \(on\)/);
  const out: string[] = [];
  for await (const text of guidedStart(dataDir, lines([]), createCampaignFrom, 'pt-BR')) out.push(text);
  assert.match(out[0] ?? '', /Antes de começar/);
});
