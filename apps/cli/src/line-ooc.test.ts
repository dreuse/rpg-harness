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
