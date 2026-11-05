import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  type CampaignSnapshot,
  type ClientEvent,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { VISUALIZATION_EVENT, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import { GM_ROLLED } from '../../../packages/domain/src/campaign.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
import { createSeededRng, replayRoll } from '../../../packages/rules/src/dice.ts';
import {
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import { GM_ROLL_PROMPT } from './gm-api.ts';
import type { GmProposal } from './gm-proposals.ts';
import { type Capabilities, INITIAL_STATE, renderScreen, rollFrames, type TuiData } from './tui.ts';

const CAMPAIGN = 'hollow-lantern';
const D20_PITCH = 'A fantasy story using the d20-lite rules with dice animation';
const NO_RULEBOOK_PITCH = 'A fantasy story with no rulebook';
const TUI_CLIENT = 'tui';
const SCREEN_ROLL_STEPS = 2;
const isVisualization = (event: unknown) => (event as { type?: string }).type === VISUALIZATION_EVENT;
const SCREEN: Capabilities = { width: 100, height: 40, colors: 'none', unicode: false, interactive: false };
const SEED = 11;
const FIRST_INPUT = 'I look around the tavern';
const SECOND_INPUT = 'I wait to see what Old Tam does';
const INTRODUCTION = 'A stout man polishes a mug behind the bar.';
const TAM: GmProposal = { kind: 'entity', id: 'old-tam', entityKind: 'npc', name: 'Old Tam', visibility: 'player' };
const TAM_SWING: GmProposal = {
  kind: 'gm-roll',
  id: 'tam-swing',
  roller: 'old-tam',
  reason: 'Old Tam swings his cudgel at the intruder',
  visibility: 'shown',
  ruleId: 'attack.melee',
};
const TAM_LISTENS: GmProposal = {
  kind: 'gm-roll',
  id: 'tam-listens',
  roller: 'old-tam',
  reason: 'Does Old Tam hear the lock click',
  visibility: 'secret',
  expression: '1d20+2',
};
const HIT_OUTCOME: GmProposal = { kind: 'outcome', id: TAM_SWING.id, text: 'the swing at the intruder' };
const SECRET_NUMBER_MARKER = 'lock click';

type Reply = { readonly narration: string; readonly proposals?: readonly GmProposal[] };
type Script = readonly (Reply | ((packet: ContextPacket) => Reply))[];

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-gm-roll-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const resultLines = (packet: ContextPacket) =>
  packet.sections.filter(({ name }) => name === 'results').flatMap(({ items }) => items);

const rolledTotal = (packet: ContextPacket) => {
  const line = resultLines(packet).find((item) => item.startsWith(GM_ROLLED)) ?? assert.fail('no GM roll in packet');
  const payload = JSON.parse(line.slice(GM_ROLLED.length)) as { resolution: { rolls: { total: number }[] } };
  return payload.resolution.rolls[0]?.total ?? assert.fail();
};

const hollowLantern = async (t: TestContext, script: Script, seed = SEED, pitch = D20_PITCH) => {
  const dataDir = tempDataDir(t);
  const describe = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, pitch, describe, TUI_CLIENT));
  const packets: ContextPacket[] = [];
  const gm: GameMaster = {
    request: async (packet) => {
      packets.push(packet);
      const step = script[Math.min(packets.length, script.length) - 1];
      const reply = typeof step === 'function' ? step(packet) : (step ?? { narration: FAKE_GM_REPLY });
      return { ...reply, segments: [{ text: reply.narration }] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm, createSeededRng(seed));
  t.after(close);
  const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
  const snapshot = () => {
    const result = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(result.ok);
    return result.value;
  };
  const events: unknown[] = [];
  session.subscribeEvents({ ...envelope, type: 'SubscribeEvents' }, (event) => events.push(event));
  const say = async (input: string) => {
    const before = snapshot();
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: before.revision,
      sceneId: before.currentScene?.id ?? '',
      actorId: before.characters[0]?.id ?? '',
      input,
    });
    assert.ok(submitted.ok, submitted.ok ? '' : submitted.error.message);
    await narrate();
  };
  const eventsOfType = (type: string) => readCampaignState(dataDir, CAMPAIGN).events.filter((e) => e.type === type);
  return { say, snapshot, packets, events, eventsOfType, session, envelope };
};

const screenOf = (snapshot: CampaignSnapshot, received: readonly unknown[]) => {
  const mechanics = received.filter((event): event is VisualizationEvent => isVisualization(event));
  const data: TuiData = {
    snapshot,
    sheet: [],
    events: received.filter((event): event is ClientEvent => !isVisualization(event)),
    mechanics,
  };
  return [
    ...renderScreen(INITIAL_STATE, data, SCREEN),
    ...mechanics.flatMap((event) => rollFrames(event, SCREEN_ROLL_STEPS)),
  ].join('\n');
};

const narratedFromRoll = (packet: ContextPacket): Reply => ({
  narration: `Old Tam swings and the engine rolled ${rolledTotal(packet)}.`,
  proposals: [HIT_OUTCOME],
});

describe('rpg-42a.89 the engine rolls for the GM and NPCs', () => {
  it('rolls an NPC attack from a GM proposal, then the GM narrates the engine result in the same turn', async (t) => {
    const { say, snapshot, packets, events, eventsOfType } = await hollowLantern(t, [
      { narration: INTRODUCTION, proposals: [TAM] },
      { narration: 'Old Tam raises the cudgel.', proposals: [TAM_SWING] },
      narratedFromRoll,
    ]);
    await say(FIRST_INPUT);
    await say(SECOND_INPUT);
    assert.equal(packets.length, 3);
    assert.ok(
      packets[1]?.sections.some(({ name, items }) => name === 'instructions' && items.includes(GM_ROLL_PROMPT)),
    );
    const [rolled] = eventsOfType(GM_ROLLED);
    assert.equal(eventsOfType(GM_ROLLED).length, 1);
    assert.equal(rolled?.payload.roller, 'old-tam');
    assert.equal(rolled?.payload.rollerName, 'Old Tam');
    assert.equal(rolled?.payload.visibility, 'shown');
    const total = rolledTotal(packets[2] as ContextPacket);
    const stored = (rolled?.payload.resolution as { rolls: unknown[] } | undefined)?.rolls[0];
    const replayed = replayRoll(stored);
    assert.ok(replayed.ok && replayed.event.total === total && replayed.event.pool.dice[0]?.sides === 20);
    assert.equal(snapshot().turns.at(-1)?.narration, `Old Tam swings and the engine rolled ${total}.`);
    const shown = events.filter(
      (event): event is { type: string; final: { roller?: string; total?: number } } =>
        (event as { type: string }).type === VISUALIZATION_EVENT,
    );
    assert.match(screenOf(snapshot(), events), /rolled by Old Tam/);
    assert.equal(shown.at(-1)?.final.roller, 'Old Tam');
    assert.equal(shown.at(-1)?.final.total, total);
  });

  it('keeps a secret roll out of the player snapshot, events, roll tray feed and terminal screen', async (t) => {
    const { say, snapshot, packets, events, eventsOfType } = await hollowLantern(t, [
      { narration: INTRODUCTION, proposals: [TAM] },
      { narration: 'Old Tam tilts his head.', proposals: [TAM_LISTENS] },
      (packet) => ({ narration: `The room is quiet; the die said ${rolledTotal(packet)}.` }),
    ]);
    await say(FIRST_INPUT);
    await say(SECOND_INPUT);
    const [rolled] = eventsOfType(GM_ROLLED);
    assert.equal(rolled?.payload.visibility, 'secret');
    const gmLine = resultLines(packets[2] as ContextPacket).find((item) => item.startsWith(GM_ROLLED));
    assert.match(gmLine ?? '', /secret/);
    const view = snapshot();
    const player = JSON.stringify(events);
    assert.doesNotMatch(player, new RegExp(`${GM_ROLLED}|${SECRET_NUMBER_MARKER}|tam-listens`));
    assert.equal(
      events.some((event) => (event as { type: string }).type === VISUALIZATION_EVENT),
      false,
    );
    assert.doesNotMatch(JSON.stringify(view), new RegExp(`${SECRET_NUMBER_MARKER}|tam-listens|${GM_ROLLED}`));
    const screen = screenOf(view, events);
    assert.doesNotMatch(screen, new RegExp(`${SECRET_NUMBER_MARKER}|tam-listens`));
  });

  it('rolls the same dice for the same seed and replays the shown roll to a later subscriber', async (t) => {
    const script: Script = [
      { narration: INTRODUCTION, proposals: [TAM] },
      { narration: 'Old Tam raises the cudgel.', proposals: [TAM_SWING] },
      narratedFromRoll,
    ];
    const totals: number[] = [];
    for (const _ of [1, 2]) {
      const { say, packets } = await hollowLantern(t, script);
      await say(FIRST_INPUT);
      await say(SECOND_INPUT);
      totals.push(rolledTotal(packets[2] as ContextPacket));
    }
    assert.equal(totals[0], totals[1]);
    const { say, session, envelope } = await hollowLantern(t, script);
    await say(FIRST_INPUT);
    await say(SECOND_INPUT);
    const replayed: unknown[] = [];
    session.subscribeEvents({ ...envelope, type: 'SubscribeEvents', fromRevision: 0 }, (event) => replayed.push(event));
    const labelled = replayed.filter(
      (event) =>
        (event as { type: string }).type === VISUALIZATION_EVENT &&
        (event as { final: { roller?: string } }).final.roller === 'Old Tam',
    );
    assert.ok(labelled.length >= 1);
  });

  it('replays rolls to a late subscriber in the order they happened, GM and player rolls alike', async (t) => {
    const { say, session, envelope } = await hollowLantern(t, [
      { narration: INTRODUCTION, proposals: [TAM] },
      { narration: 'Old Tam raises the cudgel.', proposals: [TAM_SWING] },
      narratedFromRoll,
      { narration: 'You lunge.' },
    ]);
    await say(FIRST_INPUT);
    await say(SECOND_INPUT);
    await say('I attack Old Tam with my sword');
    const replayed: { resultId: string; final: { roller?: string } }[] = [];
    session.subscribeEvents({ ...envelope, type: 'SubscribeEvents', fromRevision: 0 }, (event) => {
      if (isVisualization(event) && (event as { replayed?: true }).replayed === true)
        replayed.push(event as unknown as (typeof replayed)[number]);
    });
    assert.deepEqual(
      replayed.map(({ final }) => final.roller),
      ['Old Tam', undefined],
    );
  });

  it('refuses a roll for an unknown roller, a rule the pack lacks and a campaign without dice', async (t) => {
    const refused: Script = [
      { narration: INTRODUCTION, proposals: [TAM] },
      {
        narration: 'Nothing is rolled.',
        proposals: [
          { ...TAM_SWING, id: 'ghost', roller: 'nobody' },
          { ...TAM_SWING, id: 'vorpal', ruleId: 'attack.vorpal' },
          { ...TAM_LISTENS, id: 'bad-dice', visibility: 'shown', expression: 'roll 1d20' },
        ],
      },
    ];
    const { say, eventsOfType, packets } = await hollowLantern(t, refused);
    await say(FIRST_INPUT);
    await say(SECOND_INPUT);
    assert.equal(eventsOfType(GM_ROLLED).length, 0);
    assert.equal(packets.length, 2);
    const plain = await hollowLantern(
      t,
      [
        { narration: INTRODUCTION, proposals: [TAM] },
        { narration: 'Tam nods.', proposals: [TAM_SWING] },
      ],
      SEED,
      NO_RULEBOOK_PITCH,
    );
    await plain.say(FIRST_INPUT);
    await plain.say(SECOND_INPUT);
    assert.equal(plain.packets.length, 2);
  });
});
