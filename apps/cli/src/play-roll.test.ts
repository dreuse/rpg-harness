import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { createEngineGateway, FAKE_GAME_MASTER, type GameMaster } from './engine-gateway.ts';
import type { GmProposal } from './gm-proposals.ts';

const CAMPAIGN = 'hollow-lantern';
const D20_PITCH = 'A fantasy story using the d20-lite rules';
const SETUP = 'Old Tam sets down his mug and stares at you.';
const AFTER_ROLL = 'Your blade glances off the bar as Old Tam steps back.';
const FIRST_INPUT = 'I slash at Old Tam';
const ROLL_COMMAND = '/roll';
const REPORTED_INPUT = 'I rolled 17';
const FIRST_RESPONSE_INDEX = 1;
const MARKED_OFFER: GmProposal = {
  kind: 'check',
  id: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
  needsCheck: true,
};

const play = async (t: TestContext, whoRolls: string, inputs: readonly string[]) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-play-roll-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const describeHero = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, D20_PITCH, describeHero));
  createEngineGateway(dataDir).settings(CAMPAIGN, { whoRolls });
  let calls = 0;
  const gm: GameMaster = {
    request: async () => {
      calls += 1;
      const narration = calls === 1 ? SETUP : AFTER_ROLL;
      return { narration, segments: [{ text: narration }], proposals: calls === 1 ? [MARKED_OFFER] : [] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const lines = async function* () {
    yield* inputs;
  };
  const errors: unknown[] = [];
  const output: string[] = [];
  for await (const text of createEngineGateway(dataDir, gm).open(CAMPAIGN, 'play', lines(), (error) =>
    errors.push(error),
  ))
    output.push(text);
  return { output: output.slice(FIRST_RESPONSE_INDEX), errors };
};

const ROLL_RESULT = /d20 -> \d+.*total \d+.*outcome/;

describe('rpg-asjw.1 plain play rolls', () => {
  it('rolls for the player in app mode and prints the result and follow-up narration', async (t) => {
    const { output } = await play(t, 'app', [FIRST_INPUT]);
    const text = output.join('\n');
    assert.match(text, ROLL_RESULT);
    assert.ok(text.includes(SETUP));
    assert.ok(text.includes(AFTER_ROLL));
    assert.ok(text.indexOf(ROLL_RESULT.exec(text)?.[0] ?? '') < text.indexOf(AFTER_ROLL));
  });

  it('offers the roll in ask mode and rolls on /roll', async (t) => {
    const { output, errors } = await play(t, 'ask', [FIRST_INPUT, ROLL_COMMAND]);
    assert.deepEqual(errors, []);
    const [first, second] = output;
    assert.ok(first?.includes(MARKED_OFFER.kind === 'check' ? MARKED_OFFER.label : ''));
    assert.match(second ?? '', ROLL_RESULT);
    assert.ok(second?.includes(AFTER_ROLL));
  });

  it('asks the player to roll in me mode and accepts a reported number', async (t) => {
    const { output, errors } = await play(t, 'me', [FIRST_INPUT, REPORTED_INPUT]);
    assert.deepEqual(errors, []);
    const [first, second] = output;
    assert.match(first ?? '', /Roll 1d20 yourself/);
    assert.match(second ?? '', /d20 -> 17/);
    assert.ok(second?.includes(AFTER_ROLL));
  });
});
