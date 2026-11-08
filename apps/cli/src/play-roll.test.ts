import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { VISUALIZATION_EVENT, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import { createEngineGateway, FAKE_GAME_MASTER, type GameMaster } from './engine-gateway.ts';
import type { GmProposal } from './gm-proposals.ts';
import { rollLine } from './tui.ts';

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

const play = async (t: TestContext, whoRolls: string, inputs: readonly string[], offer = true, locale = 'en') => {
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
      return { narration, segments: [{ text: narration }], proposals: calls === 1 && offer ? [MARKED_OFFER] : [] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const lines = async function* () {
    yield* inputs;
  };
  const errors: unknown[] = [];
  const output: string[] = [];
  for await (const text of createEngineGateway(dataDir, gm).open(
    CAMPAIGN,
    'play',
    lines(),
    (error) => errors.push(error),
    locale,
  ))
    output.push(text);
  return { output: output.slice(FIRST_RESPONSE_INDEX), errors };
};

const ROLL_RESULT = /^Roll: d20 \d+ [+-] Might \d+ = -?\d+ vs \d+: [a-z]+$/m;

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
    assert.match(second ?? '', /^Roll: d20 17 [+-] Might/m);
    assert.ok(second?.includes(AFTER_ROLL));
  });
});

const OWN_CHECK_INPUT = 'I grab the rope and swing across to the loft';
const PLAYER_LINE = `: ${OWN_CHECK_INPUT}`;
const ROLL_LINE_PT = /^Rolagem: d20 \d+ [+-] Força \d+ = -?\d+ contra \d+: \p{L}+$/mu;
const NO_ROLL_LINE = /Roll: |Rolagem: /;

describe('rpg-asjw.10 plain play own checks', () => {
  it('prints one localized roll line after the player line in app mode', async (t) => {
    const { output } = await play(t, 'app', [OWN_CHECK_INPUT], false);
    const text = output.join('\n');
    assert.match(text, ROLL_RESULT);
    assert.doesNotMatch(text, /dice:|Die \d|Total \d/);
    assert.ok(text.indexOf(PLAYER_LINE) >= 0);
    assert.ok(text.indexOf(PLAYER_LINE) < text.search(ROLL_RESULT));
    assert.equal(text.match(/Roll: /g)?.length, 1);
  });

  it('prints the roll line in Portuguese', async (t) => {
    const { output } = await play(t, 'app', [OWN_CHECK_INPUT], false, 'pt-BR');
    assert.match(output.join('\n'), ROLL_LINE_PT);
  });

  it('asks before rolling in ask mode and rolls on Enter', async (t) => {
    const { output, errors } = await play(t, 'ask', [OWN_CHECK_INPUT, ''], false);
    assert.deepEqual(errors, []);
    const [prompt, rolled] = output;
    assert.match(prompt ?? '', /Roll 1d20 now\?/);
    assert.doesNotMatch(prompt ?? '', NO_ROLL_LINE);
    assert.ok(rolled?.includes(PLAYER_LINE));
    assert.match(rolled ?? '', ROLL_RESULT);
  });

  it('skips the roll in ask mode on s', async (t) => {
    const { output, errors } = await play(t, 'ask', [OWN_CHECK_INPUT, 's'], false);
    assert.deepEqual(errors, []);
    const [prompt, skipped] = output;
    assert.match(prompt ?? '', /Roll 1d20 now\?/);
    assert.ok(skipped?.includes(PLAYER_LINE));
    assert.doesNotMatch(skipped ?? '', NO_ROLL_LINE);
  });

  it('asks for the number in me mode and uses it', async (t) => {
    const { output, errors } = await play(t, 'me', [OWN_CHECK_INPUT, 'x', '14'], false);
    assert.deepEqual(errors, []);
    const [prompt, again, rolled] = output;
    assert.match(prompt ?? '', /Roll 1d20 and type the number/);
    assert.match(again ?? '', /Roll 1d20 and type the number/);
    assert.ok(rolled?.includes(PLAYER_LINE));
    assert.match(rolled ?? '', /^Roll: d20 14 [+-] Might/m);
  });

  it('asks in Portuguese', async (t) => {
    const { output } = await play(t, 'ask', [OWN_CHECK_INPUT, ''], false, 'pt-BR');
    assert.match(output[0] ?? '', /Rolar 1d20 agora\?/);
    assert.match(output[1] ?? '', ROLL_LINE_PT);
  });
});

describe('rpg-asjw.10 prompt edge cases', () => {
  it('asks again after an out-of-range report in me mode', async (t) => {
    const { output, errors } = await play(t, 'me', [OWN_CHECK_INPUT, '25', '14'], false);
    assert.deepEqual(errors, []);
    const [prompt, again, rolled] = output;
    assert.match(prompt ?? '', /Roll 1d20 and type the number/);
    assert.match(again ?? '', /only give 1 to 20/);
    assert.match(again ?? '', /Roll 1d20 and type the number/);
    assert.ok(rolled?.includes(PLAYER_LINE));
    assert.match(rolled ?? '', /^Roll: d20 14 [+-] Might/m);
  });

  it('ends quietly when input closes at an open ask prompt', async (t) => {
    const { output, errors } = await play(t, 'ask', [OWN_CHECK_INPUT], false);
    assert.deepEqual(errors, []);
    assert.equal(output.length, 1);
    assert.match(output[0] ?? '', /Roll 1d20 now\?/);
  });
});

const dieFrame = (face: number) => ({ step: 0, reveal: { kind: 'die', sides: 6, face } as const });
const eventOf = (faces: readonly number[], final: VisualizationEvent['final']): VisualizationEvent => ({
  version: PROTOCOL_VERSION,
  type: VISUALIZATION_EVENT,
  resultId: 'r',
  mechanic: 'dice',
  frames: faces.map(dieFrame),
  final,
});

describe('rpg-asjw.10 rollLine', () => {
  it('omits the dice term when no die was revealed', () => {
    assert.equal(rollLine(eventOf([], { total: 7, outcome: 'success' })), 'Roll: mod 7 = 7: success');
  });

  it('lists only the kept die so the sum adds up', () => {
    const line = rollLine(eventOf([2, 5], { total: 5, outcome: 'success', breakdown: { modifiers: [], kept: 5 } }));
    assert.equal(line, 'Roll: d6 5 = 5: success');
  });
});
