import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { CHECK_OFFERED, CHECK_RESOLVED, DAMAGE_APPLIED } from '../../../packages/domain/src/campaign.ts';
import { NPC_SHEET_FIELD } from '../../../packages/engine/src/damage.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { D20_LITE_MANIFEST, D20_SIDES } from '../../../packages/rules/src/d20-lite.ts';
import type { Rng } from '../../../packages/rules/src/dice.ts';
import {
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import { noCheckPrompt, RULES_RETRY_PROMPT } from './gm-api.ts';
import type { GmProposal } from './gm-proposals.ts';
import { narrationOf } from './gm-segments.ts';

const CAMPAIGN = 'hollow-lantern';
const D20_PITCH = 'A fantasy story using the d20-lite rules';
const FIRST_INPUT = 'I slashed my sword on his head';
const ACCEPT_INPUT = 'i will attempt the attack';
const SETUP = 'Old Tam sets down his mug and stares at you.';
const AFTER_ROLL = 'Your blade glances off the bar as Old Tam steps back, shouting for the watch.';
const ATTACK_OFFER: GmProposal = {
  kind: 'check',
  id: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
};
const OUTCOME: GmProposal = { kind: 'outcome', id: 'tam-result', text: 'the attack on Old Tam' };
const NO_DICE = 0;

type Script = readonly { readonly narration: string; readonly proposals?: readonly GmProposal[] }[];

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-check-offer-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const hollowLantern = async (
  t: TestContext,
  script: Script,
  pitch = D20_PITCH,
  settings: Parameters<ReturnType<typeof createEngineGateway>['settings']>[1] = {},
  setup: { readonly rng?: Rng; readonly before?: (dataDir: string) => void } = {},
) => {
  const dataDir = tempDataDir(t);
  const describe = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, pitch, describe));
  setup.before?.(dataDir);
  createEngineGateway(dataDir).settings(CAMPAIGN, settings);
  const packets: ContextPacket[] = [];
  const gm: GameMaster = {
    request: async (packet) => {
      packets.push(packet);
      const reply = script[Math.min(packets.length, script.length) - 1] ?? { narration: FAKE_GM_REPLY };
      return { ...reply, segments: [{ text: reply.narration }] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm, setup.rng);
  t.after(close);
  const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
  const snapshot = () => {
    const result = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(result.ok);
    return result.value;
  };
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
  return { say, snapshot, packets, eventsOfType, dataDir };
};

const rolledSides = (events: readonly { readonly payload: Readonly<Record<string, unknown>> }[]) => {
  const resolution = events[0]?.payload.resolution as { rolls: { pool: { dice: { sides: number }[] } }[] } | undefined;
  return resolution?.rolls[0]?.pool.dice[0]?.sides ?? NO_DICE;
};

describe('rpg-42a.74 GM-proposed checks', () => {
  it('replays the Hollow Lantern transcript: an offer on turn 1, a d20 attack roll after the accept', async (t) => {
    const { say, snapshot, packets, eventsOfType } = await hollowLantern(t, [
      { narration: SETUP, proposals: [ATTACK_OFFER] },
      { narration: AFTER_ROLL, proposals: [OUTCOME] },
    ]);
    await say(FIRST_INPUT);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.equal(eventsOfType(CHECK_OFFERED).length, 1);
    const { rollOffer } = snapshot();
    assert.deepEqual(rollOffer, {
      offerId: ATTACK_OFFER.id,
      ruleId: 'attack.melee',
      target: 'Old Tam',
      label: ATTACK_OFFER.kind === 'check' ? ATTACK_OFFER.label : '',
    });
    assert.equal(snapshot().turns.at(-1)?.narration, SETUP);
    await say(ACCEPT_INPUT);
    assert.equal(rolledSides(eventsOfType(CHECK_RESOLVED)), D20_SIDES);
    assert.equal(snapshot().rollOffer, undefined);
    assert.equal(packets.length, 2);
    assert.ok(
      packets[1]?.sections.some(
        ({ name, items }) => name === 'results' && items.some((i) => i.includes(CHECK_RESOLVED)),
      ),
    );
    assert.equal(snapshot().turns.at(-1)?.narration, AFTER_ROLL);
  });

  it('accepts the offer by id, as the roll button and /roll do, whatever the text says', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(t, [
      { narration: SETUP, proposals: [ATTACK_OFFER] },
      { narration: AFTER_ROLL, proposals: [OUTCOME] },
    ]);
    await say(FIRST_INPUT);
    await say('Yes, go ahead', snapshot().rollOffer?.offerId);
    assert.equal(rolledSides(eventsOfType(CHECK_RESOLVED)), D20_SIDES);
  });

  it('rejects an offer id that is not the open offer', async (t) => {
    const { say, eventsOfType } = await hollowLantern(t, [{ narration: SETUP, proposals: [ATTACK_OFFER] }]);
    await say(FIRST_INPUT);
    await assert.rejects(say('Yes, go ahead', 'someone-elses-offer'), /roll offer is no longer open/);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });

  it('does not roll for a reply that is neither an acceptance nor a rolled action', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(t, [
      { narration: SETUP, proposals: [ATTACK_OFFER] },
      { narration: 'Tam waits.' },
    ]);
    await say(FIRST_INPUT);
    await say('I look at the bar');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.ok(snapshot().rollOffer);
  });

  it('refuses an offer for a rule the RulePack does not define', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(t, [
      { narration: SETUP, proposals: [{ ...ATTACK_OFFER, ruleId: 'attack.vorpal' } as GmProposal] },
    ]);
    await say(FIRST_INPUT);
    assert.equal(eventsOfType(CHECK_OFFERED).length, 0);
    assert.equal(snapshot().rollOffer, undefined);
  });

  it('rejects a declared outcome before any roll and asks the GM again once', async (t) => {
    const { say, packets, snapshot } = await hollowLantern(t, [
      { narration: 'Your blade bites Old Tam.', proposals: [OUTCOME] },
      { narration: SETUP, proposals: [ATTACK_OFFER] },
    ]);
    await say(FIRST_INPUT);
    assert.equal(packets.length, 2);
    assert.ok(packets[1]?.sections.some(({ items }) => items.includes(RULES_RETRY_PROMPT)));
    assert.equal(narrationOf([{ text: snapshot().turns.at(-1)?.narration ?? '' }]), SETUP);
    assert.ok(snapshot().rollOffer);
  });

  describe('rpg-42a.76 repeated endings', () => {
    const OPENING = 'Rain taps the lantern. Attempt the attack with your sword.';
    const REPEAT = 'Chairs scrape. Attempt the attack with your sword.';
    const FRESH = 'A shutter bangs open and cold air floods the bar.';

    it('regenerates once, naming the repeated line, then accepts the new text', async (t) => {
      const { say, packets, snapshot } = await hollowLantern(t, [
        { narration: OPENING },
        { narration: REPEAT },
        { narration: FRESH },
      ]);
      await say(FIRST_INPUT);
      assert.equal(packets.length, 1);
      await say('I look at the bar');
      assert.equal(packets.length, 3);
      assert.ok(
        packets[2]?.sections.some(({ items }) => items.some((item) => item.includes(REPEAT.split('. ')[1] ?? ''))),
      );
      assert.equal(snapshot().turns.at(-1)?.narration, FRESH);
    });

    it('never retries more than once', async (t) => {
      const { say, packets, snapshot } = await hollowLantern(t, [
        { narration: OPENING },
        { narration: REPEAT },
        { narration: REPEAT },
      ]);
      await say(FIRST_INPUT);
      await say('I look at the bar');
      assert.equal(packets.length, 3);
      assert.equal(snapshot().turns.at(-1)?.narration, REPEAT);
    });

    it('does not regenerate different text', async (t) => {
      const { say, packets } = await hollowLantern(t, [{ narration: OPENING }, { narration: FRESH }]);
      await say(FIRST_INPUT);
      await say('I look at the bar');
      assert.equal(packets.length, 2);
    });
  });
});

describe('rpg-42a.77 an action that cannot roll says why', () => {
  it('shows the reason once and tells the GM to narrate the outcome itself', async (t) => {
    const { say, snapshot, packets, eventsOfType } = await hollowLantern(
      t,
      [{ narration: AFTER_ROLL }],
      'A fantasy story with no rulebook',
    );
    await say('Attack');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.deepEqual(snapshot().noRoll, { actionId: snapshot().turns.at(-1)?.actionId, reason: 'no-rulebook' });
    const sections = packets[0]?.sections ?? [];
    assert.ok(
      sections.some(
        ({ name, items }) => name === 'instructions' && items.some((i) => i === noCheckPrompt('no-rulebook')),
      ),
    );
    assert.ok(sections.some(({ name, items }) => name === 'results' && items.some((i) => i.includes('CheckSkipped'))));
  });
});

describe('rpg-42a.94 a check the GM marks as needed rolls without a listed verb', () => {
  const MARKED_OFFER: GmProposal = { ...ATTACK_OFFER, needsCheck: true };
  const FREE_FORM_INPUTS = ['I slash my sword at his head', 'corto a cabeça dele com a espada'];

  for (const input of FREE_FORM_INPUTS)
    it(`rolls a d20 for "${input}" in the same exchange`, async (t) => {
      const { say, snapshot, packets, eventsOfType } = await hollowLantern(t, [
        { narration: SETUP, proposals: [MARKED_OFFER] },
        { narration: AFTER_ROLL, proposals: [OUTCOME] },
      ]);
      await say(input);
      assert.equal(rolledSides(eventsOfType(CHECK_RESOLVED)), D20_SIDES);
      assert.equal(snapshot().rollOffer, undefined);
      assert.equal(packets.length, 2);
      assert.equal(snapshot().turns.at(-1)?.narration, AFTER_ROLL);
    });

  it('leaves an offer the GM did not mark waiting for the player', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(t, [{ narration: SETUP, proposals: [ATTACK_OFFER] }]);
    await say(FREE_FORM_INPUTS[0] ?? '');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.ok(snapshot().rollOffer);
  });

  it('does not roll for "I look around" when the GM marks nothing', async (t) => {
    const { say, eventsOfType, packets } = await hollowLantern(t, [{ narration: SETUP }]);
    await say('I look around');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.equal(packets.length, 1);
  });

  it('never rolls a marked check when the campaign has no rulebook', async (t) => {
    const { say, eventsOfType } = await hollowLantern(
      t,
      [{ narration: SETUP, proposals: [MARKED_OFFER] }],
      'A fantasy story with no rulebook',
    );
    await say(FREE_FORM_INPUTS[0] ?? '');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.equal(eventsOfType(CHECK_OFFERED).length, 0);
  });

  it('rolls once for a listed verb and leaves the marked follow-up offer pending', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(t, [{ narration: SETUP, proposals: [MARKED_OFFER] }]);
    await say('I attack Old Tam');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 1);
    assert.equal(snapshot().rollOffer?.offerId, MARKED_OFFER.id);
  });

  it('leaves a marked offer pending when the player rolls their own dice', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(
      t,
      [{ narration: SETUP, proposals: [MARKED_OFFER] }],
      D20_PITCH,
      { whoRolls: 'me' },
    );
    await say(FREE_FORM_INPUTS[0] ?? '');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.equal(snapshot().rollOffer?.offerId, MARKED_OFFER.id);
  });

  it('never offers or rolls a marked check when strictness is off', async (t) => {
    const { say, eventsOfType } = await hollowLantern(t, [{ narration: SETUP, proposals: [MARKED_OFFER] }], D20_PITCH, {
      rulesStrictness: 'off',
    });
    await say(FREE_FORM_INPUTS[0] ?? '');
    assert.equal(eventsOfType(CHECK_OFFERED).length, 0);
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
  });

  it('does not roll an older pending offer when the marked proposal that reuses its id is refused', async (t) => {
    const { say, snapshot, eventsOfType } = await hollowLantern(t, [
      { narration: SETUP, proposals: [ATTACK_OFFER] },
      { narration: 'Tam waits.', proposals: [{ ...MARKED_OFFER, ruleId: 'attack.vorpal' } as GmProposal] },
    ]);
    await say('I look at the bar');
    await say('I look at the door');
    assert.equal(eventsOfType(CHECK_RESOLVED).length, 0);
    assert.equal(snapshot().rollOffer?.offerId, ATTACK_OFFER.id);
  });
});

describe('rpg-42a.84 an offered attack resolves against the target sheet', () => {
  const TAM_ID = 'npc-tam';
  const TAM_DEFENSE = 10;
  const TAM_HP = 6;
  const HIGH_DRAW = 0.9;
  const WOUND = 4;
  const NO_DEFENSE_SHEET = { ...tamSheet(), traits: [] };

  function tamSheet(hp = TAM_HP) {
    return {
      detail: 'sparse',
      npcId: TAM_ID,
      role: 'minor',
      name: 'Old Tam',
      motivations: [],
      background: '',
      traits: [
        { id: 'defense', value: TAM_DEFENSE },
        { id: 'hp', value: hp },
      ],
      rulepack: { id: D20_LITE_MANIFEST.id, edition: D20_LITE_MANIFEST.edition, revision: D20_LITE_MANIFEST.revision },
    };
  }

  const withTam = (sheet: unknown) => (dataDir: string) => {
    const connection = openDatabase(join(dataDir, `${encodeURIComponent(CAMPAIGN)}.sqlite`));
    try {
      createEntityStore(connection.database).saveEntity({
        id: TAM_ID,
        campaignId: connection.database.prepare('SELECT id FROM campaign').get()?.id as string,
        kind: 'npc',
        name: 'Old Tam',
        data: { [NPC_SHEET_FIELD]: sheet },
        visibility: 'public',
        actorId: null,
      });
    } finally {
      connection.close();
    }
  };

  const script: Script = [
    { narration: SETUP, proposals: [ATTACK_OFFER] },
    { narration: AFTER_ROLL },
    { narration: 'Tam snarls and lifts a stool.', proposals: [{ ...ATTACK_OFFER, id: 'tam-attack-2' }] },
    { narration: 'The stool clatters to the floor.' },
  ];

  it('commits damage through the engine, shows it to the GM and defeats the target at zero', async (t) => {
    const { say, packets, eventsOfType } = await hollowLantern(
      t,
      script,
      D20_PITCH,
      {},
      {
        rng: () => HIGH_DRAW,
        before: withTam(tamSheet()),
      },
    );
    await say(FIRST_INPUT);
    await say(ACCEPT_INPUT);
    const [first] = eventsOfType(DAMAGE_APPLIED);
    assert.deepEqual(first?.payload, { targetId: TAM_ID, amount: WOUND, defeated: false });
    assert.ok(
      packets[1]?.sections.some(
        ({ name, items }) => name === 'results' && items.some((i) => i.includes(DAMAGE_APPLIED)),
      ),
    );
    await say(FIRST_INPUT);
    await say(ACCEPT_INPUT);
    const second = eventsOfType(DAMAGE_APPLIED).at(-1);
    assert.deepEqual(second?.payload, { targetId: TAM_ID, amount: TAM_HP - WOUND, defeated: true });
  });

  it('rolls only when the target has no defense or hit point data', async (t) => {
    const { say, eventsOfType } = await hollowLantern(
      t,
      script,
      D20_PITCH,
      {},
      {
        rng: () => HIGH_DRAW,
        before: withTam(NO_DEFENSE_SHEET),
      },
    );
    await say(FIRST_INPUT);
    await say(ACCEPT_INPUT);
    assert.equal(rolledSides(eventsOfType(CHECK_RESOLVED)), D20_SIDES);
    assert.equal(eventsOfType(DAMAGE_APPLIED).length, 0);
  });
});
