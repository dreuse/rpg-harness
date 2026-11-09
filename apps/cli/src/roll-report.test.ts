import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { CHECK_RESOLVED, ROLL_REPORTED } from '../../../packages/domain/src/campaign.ts';
import { D20_SIDES } from '../../../packages/rules/src/d20-lite.ts';
import {
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import type { GmProposal } from './gm-proposals.ts';
import { CLI_CATALOG } from './messages.ts';
import { resultsOf } from './roll-visualization.ts';
import { runTui } from './tui.ts';

const CAMPAIGN = 'hollow-lantern';
const D20_PITCH = 'A fantasy story using the d20-lite rules';
const GM_ONLY_PITCH = 'A fantasy story with no rulebook';
const SETUP = 'Old Tam sets down his mug and stares at you.';
const FIRST_INPUT = 'I slashed my sword on his head';
const ATTACK_OFFER: GmProposal = {
  kind: 'check',
  id: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
};
const REPORTED = 17;
const NEW_CHECK_ATTRIBUTE = 'agility';

const physicalTable = async (t: TestContext, whoRolls: string, pitch = D20_PITCH, offer = true) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-roll-report-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const describeHero = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, pitch, describeHero));
  let calls = 0;
  const gm: GameMaster = {
    request: async () => {
      calls += 1;
      const reply = { narration: calls === 1 ? SETUP : FAKE_GM_REPLY };
      return { ...reply, segments: [{ text: reply.narration }], proposals: calls === 1 && offer ? [ATTACK_OFFER] : [] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm);
  t.after(close);
  const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
  const snapshot = () => {
    const result = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(result.ok);
    return result.value;
  };
  const say = async (input: string, extra: { rollOfferId?: string; reportedRoll?: number[] } = {}) => {
    const before = snapshot();
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: before.revision,
      sceneId: before.currentScene?.id ?? '',
      actorId: before.characters[0]?.id ?? '',
      input,
      ...extra,
    });
    if (submitted.ok) await narrate();
    return submitted;
  };
  const saved = session.saveGmSettings({
    ...envelope,
    type: 'SaveGmSettings',
    actionId: 'who-rolls',
    expectedRevision: snapshot().revision,
    whoRolls,
  } as never);
  assert.ok(saved.ok, saved.ok ? '' : saved.error.message);
  const eventsOfType = (type: string) => readCampaignState(dataDir, CAMPAIGN).events.filter((e) => e.type === type);
  return { say, snapshot, eventsOfType, session, campaignId, narrate, gmCalls: () => calls };
};

const drawsOf = (events: readonly { readonly payload: Readonly<Record<string, unknown>> }[]) =>
  (events[0]?.payload.resolution as { rolls: { draws: number[][] }[] } | undefined)?.rolls[0]?.draws;

const attributeOf = (events: readonly { readonly payload: Readonly<Record<string, unknown>> }[]) =>
  (events[0]?.payload.resolution as { attribute?: { id: string } } | undefined)?.attribute?.id;

describe('rpg-42a.83 physical dice', () => {
  it('shows the dice expression on the pending offer when the player rolls', async (t) => {
    const { say, snapshot } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    assert.equal(snapshot().rollOffer?.expression, `1d${D20_SIDES}`);
  });

  it('resolves the offered check from a reported value and marks it as player-rolled', async (t) => {
    const { say, snapshot, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const done = await say('Rolled it', { rollOfferId: 'tam-attack', reportedRoll: [REPORTED] });
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[REPORTED]]);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 1);
    assert.equal(snapshot().rollOffer, undefined);
    const [result] = resultsOf(eventsOfType(CHECK_RESOLVED)[0]?.payload, 'public');
    assert.equal(result?.source, 'player');
  });

  it('rejects an out-of-range report in the campaign language and writes nothing', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const rejected = await say('Rolled it', { rollOfferId: 'tam-attack', reportedRoll: [D20_SIDES + 1] });
    assert.ok(!rejected.ok);
    assert.match(rejected.error.message, /1d20.*1.*20/);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
  });

  it('accepts a typed "I rolled 17" for the pending check', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const done = await say('I rolled 17');
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[REPORTED]]);
  });

  for (const typed of ['saqué 17', 'saque 17', 'tiré 17', 'tire un 17', 'salió 17']) {
    it(`accepts the Spanish report "${typed}" for the pending check`, async (t) => {
      const { say, eventsOfType } = await physicalTable(t, 'me');
      await say(FIRST_INPUT);
      const done = await say(typed);
      assert.ok(done.ok, done.ok ? '' : done.error.message);
      assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[REPORTED]]);
    });
  }

  it('accepts the Spanish "lo intento" as taking the pending offer', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'app');
    await say(FIRST_INPUT);
    const done = await say('di que lo intentas');
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 1);
  });

  it('does not take the pending offer for a Portuguese "tiro o chapéu"', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'app');
    await say(FIRST_INPUT);
    await say('tiro o chapéu e entro');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });

  it('resolves a new action with its own check from an embedded report', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const done = await say('I shoot the goblin, I rolled 14');
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[14]]);
    assert.equal(attributeOf(eventsOfType(CHECK_RESOLVED)), NEW_CHECK_ATTRIBUTE);
  });

  it('does not resolve the offer from an attempt word in a new action with a report', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const done = await say('I try to sneak past the goblin, I rolled 14');
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[14]]);
    assert.equal(attributeOf(eventsOfType(CHECK_RESOLVED)), NEW_CHECK_ATTRIBUTE);
  });

  it('binds a non-bare report with no check of its own to the offer', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const done = await say('ok, I rolled 17');
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[REPORTED]]);
  });

  it('asks for the roll instead of rolling for the player', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const refused = await say('Yes, go ahead', { rollOfferId: 'tam-attack' });
    assert.ok(!refused.ok);
    assert.match(refused.error.message, /1d20/);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });

  it('lets the app roll when the player picks "ask each time" and reports nothing', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'ask');
    await say(FIRST_INPUT);
    await say('Yes, go ahead', { rollOfferId: 'tam-attack' });
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 1);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
  });

  it('does not read "I rolled 17" as a report when the app rolls', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'app');
    await say(FIRST_INPUT);
    await say('I rolled 17');
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
  });

  it('records a report without a RulePack and resolves nothing', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me', GM_ONLY_PITCH, false);
    const done = await say('I rolled for the lock', { reportedRoll: [REPORTED] });
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 1);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });

  it('validates a report sent without the offer id against the pending offer', async (t) => {
    const { say, snapshot, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const rejected = await say('Rolled it', { reportedRoll: [D20_SIDES + 1] });
    assert.ok(!rejected.ok);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
    assert.ok(snapshot().rollOffer);
  });

  it('resolves a self-started check from a roll typed in the same action', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me', D20_PITCH, false);
    const done = await say('I attack the goblin, I rolled 14');
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[14]]);
  });

  it('ignores a typed roll once the player has acted after the offer', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    await say('I look at the bar');
    await say('I rolled 17');
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });
});

const BARE_REPORT_INPUTS = [`${REPORTED}`, ` ${REPORTED} `, `${REPORTED}.`];
const REJECTED_NUMBERS = ['0', `${D20_SIDES + 1}`, '99999', '-3', '15.5'];
const FREE_TEXT = 'abc';
const PLAIN_TERMINAL = { width: 100, height: 40, colors: 'none', unicode: false, interactive: false } as const;

describe('rpg-asjw.24 bare number answers an open roll offer in me mode', () => {
  for (const typed of BARE_REPORT_INPUTS)
    it(`resolves the offer from "${typed}" with no extra GM call`, async (t) => {
      const { say, snapshot, eventsOfType, gmCalls } = await physicalTable(t, 'me');
      await say(FIRST_INPUT);
      const before = gmCalls();
      const done = await say(typed);
      assert.ok(done.ok, done.ok ? '' : done.error.message);
      assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[REPORTED]]);
      assert.equal(eventsOfType(ROLL_REPORTED).length, 1);
      assert.equal(snapshot().rollOffer, undefined);
      assert.equal(gmCalls(), before + 1);
    });

  for (const typed of REJECTED_NUMBERS)
    it(`rejects "${typed}" locally in the campaign language and keeps the offer open`, async (t) => {
      const { say, snapshot, eventsOfType, gmCalls } = await physicalTable(t, 'me');
      await say(FIRST_INPUT);
      const before = gmCalls();
      const rejected = await say(typed);
      assert.ok(!rejected.ok);
      assert.match(rejected.error.message, /1d20.*1.*20/);
      assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
      assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
      assert.equal(gmCalls(), before);
      assert.ok(snapshot().rollOffer);
    });

  it('leaves a bare number alone when the app rolls', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'app');
    await say(FIRST_INPUT);
    await say(`${REPORTED}`);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
  });

  it('leaves a bare number alone when no offer is open', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me', D20_PITCH, false);
    const done = await say(`${REPORTED}`);
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.equal(eventsOfType(ROLL_REPORTED).length, 0);
  });

  it('still treats other text as a normal action', async (t) => {
    const { say, eventsOfType } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const done = await say(FREE_TEXT);
    assert.ok(done.ok, done.ok ? '' : done.error.message);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });

  for (const [locale, messages] of Object.entries(CLI_CATALOG))
    for (const key of ['tui.rollOfferPhysical', 'rollReport.needed'] as const)
      it(`parses the ${locale} example in ${key}`, async (t) => {
        const [, example] = /"([^"]+)"/.exec(messages[key] ?? '') ?? [];
        assert.ok(example, `${locale} ${key} has a quoted example`);
        const { say, eventsOfType } = await physicalTable(t, 'me');
        await say(FIRST_INPUT);
        const done = await say(example);
        assert.ok(done.ok, done.ok ? '' : done.error.message);
        assert.equal(eventsOfType(ROLL_REPORTED).length, 1);
      });

  it('resolves the offer from a bare number typed in the TUI', async (t) => {
    const { say, snapshot, eventsOfType, session, campaignId, narrate } = await physicalTable(t, 'me');
    await say(FIRST_INPUT);
    const output: string[] = [];
    const lines = (async function* () {
      yield `${D20_SIDES + 1}`;
      yield `${REPORTED}`;
      yield 'q';
    })();
    await runTui(
      session,
      campaignId,
      { capabilities: PLAIN_TERMINAL, lines, write: (text) => output.push(text) },
      narrate,
    );
    assert.match(output.join(''), /1d20.*1.*20/);
    assert.deepEqual(drawsOf(eventsOfType(CHECK_RESOLVED)), [[REPORTED]]);
    assert.equal(snapshot().rollOffer, undefined);
  });
});
