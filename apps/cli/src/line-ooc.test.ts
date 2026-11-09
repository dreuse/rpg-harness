import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createEngineGateway, FAKE_GAME_MASTER, type GameMaster, readCampaignState } from './engine-gateway.ts';

const NAME = 'Line ooc';
const PITCH = 'a fantasy adventure in a drowned chapel';
const QUESTION = '((is the door locked?))';
const OOC_REPLY_LABEL = 'GM (out of character):';
const NARRATION = 'The chapel creaks.';
const IGNORE = () => undefined;

const lines = async function* (input: readonly string[]) {
  yield* input;
};

const collect = async (stream: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const text of stream) out.push(text);
  return out;
};

test('rpg-asjw.31 line-mode play answers an out-of-character question without a turn or new plot', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-line-ooc-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let requests = 0;
  const gm: GameMaster = {
    request: async () => {
      requests++;
      return { narration: NARRATION, segments: [{ text: NARRATION }] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const gateway = createEngineGateway(dataDir, gm);
  for await (const _ of gateway.create(NAME, PITCH, async () => ''));
  const before = readCampaignState(dataDir, NAME);
  const requestsBefore = requests;
  const out = await collect(gateway.open(NAME, 'play', lines([QUESTION]), IGNORE, 'en'));
  const after = readCampaignState(dataDir, NAME);
  assert.ok(out.some((text) => text.startsWith(OOC_REPLY_LABEL)));
  assert.equal(requests, requestsBefore);
  assert.equal(after.turns.length, before.turns.length);
  assert.equal(after.revision, before.revision);
  const resumed = await collect(gateway.open(NAME, 'resume', lines([]), IGNORE, 'en'));
  assert.doesNotMatch(resumed.join('\n'), /is the door locked/);
});

const TABLE_NOTE_SUMMARY = 'Note: no fall damage';
const APPLIED_LABEL = 'Done: ';
const UNDONE_PATTERN = /Undone|undone|reverted/i;

test('rpg-asjw.37 line-mode /gm lists a proposal, applies it on /gm yes and undoes it on /gm revert', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-line-gm-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const gm: GameMaster = {
    request: async () => ({ narration: NARRATION, segments: [{ text: NARRATION }] }),
    summarizer: FAKE_GAME_MASTER.summarizer,
    oocReply: async () => ({
      reply: 'Sure.',
      proposals: [{ kind: 'table_note', summary: TABLE_NOTE_SUMMARY, note: 'no fall damage' }],
    }),
  };
  const gateway = createEngineGateway(dataDir, gm);
  for await (const _ of gateway.create(NAME, PITCH, async () => ''));
  const before = readCampaignState(dataDir, NAME).revision;
  const out = await collect(
    gateway.open(NAME, 'play', lines(['/gm no fall damage please', '/gm yes', '/gm revert']), IGNORE, 'en'),
  );
  const text = out.join('\n');
  assert.ok(text.includes(TABLE_NOTE_SUMMARY));
  assert.ok(text.includes(APPLIED_LABEL));
  assert.match(text, UNDONE_PATTERN);
  assert.ok(readCampaignState(dataDir, NAME).revision > before);
});
