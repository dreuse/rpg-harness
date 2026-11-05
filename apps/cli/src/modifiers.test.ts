import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { VISUALIZATION_EVENT, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import {
  CHECK_OFFERED,
  CHECK_RESOLVED,
  CONDITION_APPLIED,
  CONDITION_REMOVED,
  GM_ROLLED,
} from '../../../packages/domain/src/campaign.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
import { D20_LITE_VOCABULARY } from '../../../packages/rules/src/d20-lite.ts';
import { replayRoll } from '../../../packages/rules/src/dice.ts';
import { createScriptedRng } from '../../../packages/testkit/src/fixtures.ts';
import {
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import { modifiersPrompt } from './gm-api.ts';
import type { GmProposal } from './gm-proposals.ts';
import { resultsOf } from './roll-visualization.ts';

const CAMPAIGN = 'hollow-lantern';
const D20_PITCH = 'A fantasy story using the d20-lite rules with dice animation';
const SETUP = 'Old Tam sets down his mug and stares at you.';
const TUI_CLIENT = 'tui';
const POOL_PITCH = 'A fantasy story using the dice-pool-lite rules with dice animation';
const POOL_BASE_DICE = 2;
const D20 = 20;
const HALF = 0.5;
const POOL_RNG = createScriptedRng([HALF]);
const WITS_PENALTY = -3;
const DARKNESS = -2;
const FACE = 12;
const LOW_FACE = 3;
const HIGH_FACE = 17;
const DEFAULT_DC = 10;
const faceRng = (...faces: number[]) => createScriptedRng(faces.map((face) => (face - 1 + HALF) / D20));

const offer = (extra: Partial<Extract<GmProposal, { kind: 'check' }>> = {}): GmProposal => ({
  kind: 'check',
  id: 'read-map',
  ruleId: 'check.wits',
  target: 'the map',
  label: 'Read the map in the dark',
  ...extra,
});
const DARK = { id: 'darkness', reason: 'the lantern has gone out', sourceRule: 'cover-and-darkness' };

type Reply = { readonly narration: string; readonly proposals?: readonly GmProposal[] };
type Resolution = {
  bonus: number;
  keep?: string;
  target: number;
  attribute: { id: string; value: number };
  modifiers?: { id: string; reason: string; effect: unknown }[];
  rolls: unknown[];
};

const hollowLantern = async (
  t: TestContext,
  script: readonly Reply[],
  rng = faceRng(FACE),
  relaxed = false,
  pitch = D20_PITCH,
) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-modifiers-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const describe = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, pitch, describe, TUI_CLIENT));
  const packets: ContextPacket[] = [];
  const gm: GameMaster = {
    request: async (packet) => {
      packets.push(packet);
      const reply = script[Math.min(packets.length, script.length) - 1] ?? { narration: FAKE_GM_REPLY };
      return { ...reply, segments: [{ text: reply.narration }] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm, rng);
  t.after(close);
  const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
  const snapshot = () => {
    const result = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(result.ok);
    return result.value;
  };
  if (relaxed) {
    const saved = session.saveGmSettings({
      ...envelope,
      type: 'SaveGmSettings',
      actionId: 'relax',
      expectedRevision: snapshot().revision,
      rulesStrictness: 'relaxed',
    });
    assert.ok(saved.ok);
  }
  const seen: VisualizationEvent[] = [];
  session.subscribeEvents({ ...envelope, type: 'SubscribeEvents' }, (event) => {
    if ((event as { type?: string }).type === VISUALIZATION_EVENT) seen.push(event as VisualizationEvent);
  });
  const say = async (input: string, rollOfferId?: string) => {
    const before = snapshot();
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: before.revision,
      sceneId: before.currentScene?.id ?? '',
      actorId: before.characters[0]?.id ?? '',
      input,
      ...(rollOfferId === undefined ? {} : { rollOfferId }),
    });
    assert.ok(submitted.ok, submitted.ok ? '' : submitted.error.message);
    await narrate();
  };
  const eventsOfType = (type: string) => readCampaignState(dataDir, CAMPAIGN).events.filter((e) => e.type === type);
  const resolutions = () => eventsOfType(CHECK_RESOLVED).map((e) => e.payload.resolution as Resolution);
  return { say, snapshot, packets, seen, eventsOfType, resolutions };
};

describe('rpg-42a.90 modifiers and conditions on rolls', () => {
  it('lowers the total by a -2 modifier and records it on the roll event and the roll card', async (t) => {
    const { say, snapshot, resolutions, seen, eventsOfType } = await hollowLantern(t, [
      { narration: SETUP, proposals: [offer({ modifiers: [DARK] })] },
      { narration: 'You squint at the map.' },
    ]);
    await say('I look at the map');
    assert.deepEqual(
      snapshot().rollOffer?.modifiers?.map(({ id }) => id),
      ['darkness'],
    );
    await say('I try to read it', snapshot().rollOffer?.offerId);
    const [resolution] = resolutions();
    assert.equal(resolution?.bonus, WITS_PENALTY + DARKNESS);
    assert.deepEqual(
      resolution?.modifiers?.map(({ id, reason }) => [id, reason]),
      [['darkness', DARK.reason]],
    );
    const stored = replayRoll(resolution?.rolls[0]);
    assert.ok(stored.ok);
    assert.equal(stored.event.total + (resolution?.bonus ?? 0), FACE + WITS_PENALTY + DARKNESS);
    const [replayed] = resultsOf(eventsOfType(CHECK_RESOLVED)[0]?.payload, 'player');
    const card = seen.at(-1)?.final;
    assert.deepEqual([replayed?.total, replayed?.breakdown], [card?.total, card?.breakdown]);
    assert.equal(card?.total, FACE + WITS_PENALTY + DARKNESS);
    assert.deepEqual(card?.breakdown, {
      modifiers: [{ id: 'darkness', reason: DARK.reason, kind: 'flat', value: DARKNESS }],
      attribute: { id: 'wits', value: WITS_PENALTY },
      target: DEFAULT_DC,
    });
  });

  it('rejects an unknown modifier id as-written and takes it with a label when relaxed', async (t) => {
    const moonlit = { id: 'moonlit', reason: 'bright moon', sourceRule: 'PHB p.12', value: 1 };
    const strict = await hollowLantern(t, [{ narration: SETUP, proposals: [offer({ modifiers: [moonlit] })] }]);
    await strict.say('I look at the map');
    assert.equal(strict.eventsOfType(CHECK_OFFERED).length, 0);
    const loose = await hollowLantern(
      t,
      [{ narration: SETUP, proposals: [offer({ modifiers: [moonlit] })] }, { narration: 'You read it.' }],
      faceRng(FACE),
      true,
    );
    await loose.say('I look at the map');
    await loose.say('I try to read it', loose.snapshot().rollOffer?.offerId);
    assert.equal(loose.resolutions()[0]?.bonus, WITS_PENALTY + 1);
    assert.equal(loose.resolutions()[0]?.modifiers?.[0]?.id, 'moonlit');
  });

  it('keeps the higher of two d20 for advantage', async (t) => {
    const { say, snapshot, resolutions, seen } = await hollowLantern(
      t,
      [
        { narration: SETUP, proposals: [offer({ modifiers: [{ id: 'advantage', reason: 'a clear view' }] })] },
        { narration: 'You read it.' },
      ],
      faceRng(LOW_FACE, HIGH_FACE),
    );
    await say('I look at the map');
    await say('I try to read it', snapshot().rollOffer?.offerId);
    assert.equal(resolutions()[0]?.keep, 'highest');
    assert.equal(seen.at(-1)?.final.total, HIGH_FACE + WITS_PENALTY);
    assert.equal(seen.at(-1)?.final.breakdown?.kept, HIGH_FACE);
  });

  it('applies a condition to the next matching roll, then expires it', async (t) => {
    const darkened: GmProposal = {
      kind: 'condition',
      id: 'lantern-out',
      conditionId: 'darkened',
      reason: 'the lantern gutters out',
      duration: { unit: 'turns', count: 1 },
    };
    const { say, resolutions, eventsOfType, packets } = await hollowLantern(
      t,
      [
        { narration: 'The lantern gutters out.', proposals: [darkened] },
        { narration: 'You fumble through the dark.' },
        { narration: 'Your eyes adjust.' },
      ],
      faceRng(FACE),
      true,
    );
    await say('I look around');
    assert.equal(eventsOfType(CONDITION_APPLIED).length, 1);
    await say('I try to search the room');
    await say('I try to search the room again');
    const [first, second] = resolutions();
    assert.deepEqual(
      first?.modifiers?.map(({ id }) => id),
      ['darkness'],
    );
    assert.equal(first?.bonus, WITS_PENALTY + DARKNESS);
    assert.equal(second?.modifiers, undefined);
    assert.equal(second?.bonus, WITS_PENALTY);
    assert.ok(packets[0]?.sections.some(({ items }) => items.some((item) => item.includes('darkness (-2)'))));
  });

  it('ends a condition early when the GM proposes it', async (t) => {
    const wounded: GmProposal = { kind: 'condition', id: 'cut', conditionId: 'wounded', reason: 'a cut' };
    const healed: GmProposal = { kind: 'condition-end', id: 'bandaged', conditionId: 'wounded' };
    const { say, resolutions, eventsOfType } = await hollowLantern(t, [
      { narration: 'A blade grazes you.', proposals: [wounded] },
      { narration: 'You bind the cut.', proposals: [healed] },
      { narration: 'You search.' },
    ]);
    await say('I look around');
    await say('I look around again');
    assert.equal(eventsOfType(CONDITION_REMOVED).length, 1);
    await say('I try to search the room');
    assert.equal(resolutions()[0]?.modifiers, undefined);
  });

  it('adds labelled modifiers to a GM roll in relaxed mode and records them', async (t) => {
    const roll: GmProposal = {
      kind: 'gm-roll',
      id: 'tam-swing',
      roller: 'gm',
      reason: 'a guard swings in the dark',
      visibility: 'shown',
      expression: '1d20+2',
      modifiers: [{ id: 'dim-light', reason: 'dim light', sourceRule: 'Rules p.4', value: -2 }],
    };
    const { say, eventsOfType } = await hollowLantern(
      t,
      [{ narration: SETUP, proposals: [roll] }, { narration: 'The guard misses.' }],
      faceRng(FACE),
      true,
    );
    await say('I look around');
    const [rolled] = eventsOfType(GM_ROLLED);
    const resolution = rolled?.payload.resolution as Resolution;
    assert.deepEqual(
      resolution.modifiers?.map(({ id }) => id),
      ['dim-light'],
    );
    const stored = replayRoll(resolution.rolls[0]);
    assert.ok(stored.ok);
    assert.equal(stored.event.total, FACE + 2 - 2);
  });

  it('lists the modifier ids of the effective RulePack in the GM context', () => {
    const prompt = modifiersPrompt({ vocabulary: D20_LITE_VOCABULARY, strictness: 'as-written' });
    for (const { id } of D20_LITE_VOCABULARY.modifiers) assert.ok(prompt.includes(id), id);
    assert.match(prompt, /condition/);
    assert.match(prompt, /Never use a modifier id that is not listed/);
  });
  describe('dice pool checks', () => {
    const poolOffer = (modifiers: { id: string; reason: string; value?: number }[]): GmProposal =>
      offer({ ruleId: 'check.pool', modifiers });
    const poolDice = (resolution?: Resolution) =>
      (resolution?.rolls[0] as { pool: { dice: { count: number }[] } } | undefined)?.pool.dice[0]?.count;

    it('adds a die for help and records it', async (t) => {
      const { say, snapshot, resolutions } = await hollowLantern(
        t,
        [
          { narration: SETUP, proposals: [poolOffer([{ id: 'help', reason: 'an ally lends a hand' }])] },
          { narration: 'You pull together.' },
        ],
        POOL_RNG,
        false,
        POOL_PITCH,
      );
      await say('I look at the map');
      await say('I try it', snapshot().rollOffer?.offerId);
      assert.equal(poolDice(resolutions()[0]), POOL_BASE_DICE + 1);
      assert.deepEqual(
        resolutions()[0]?.modifiers?.map(({ id }) => id),
        ['help'],
      );
    });

    it('refuses a flat modifier, which a pool cannot apply', async (t) => {
      const { say, eventsOfType } = await hollowLantern(
        t,
        [{ narration: SETUP, proposals: [poolOffer([{ id: 'moonlit', reason: 'bright moon', value: 1 }])] }],
        POOL_RNG,
        true,
        POOL_PITCH,
      );
      await say('I look at the map');
      assert.equal(eventsOfType(CHECK_OFFERED).length, 0);
    });

    it('takes a die away for a wounded condition on the next roll', async (t) => {
      const wounded: GmProposal = { kind: 'condition', id: 'cut', conditionId: 'wounded', reason: 'a cut' };
      const { say, resolutions } = await hollowLantern(
        t,
        [{ narration: 'A blade grazes you.', proposals: [wounded] }, { narration: 'You push on.' }],
        POOL_RNG,
        false,
        POOL_PITCH,
      );
      await say('I look around');
      await say('I try to search the room');
      assert.equal(poolDice(resolutions()[0]), POOL_BASE_DICE - 1);
      assert.deepEqual(
        resolutions()[0]?.modifiers?.map(({ id }) => id),
        ['wounded'],
      );
    });
  });
});
