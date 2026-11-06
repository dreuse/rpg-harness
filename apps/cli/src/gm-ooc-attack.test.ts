import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { CHECK_RESOLVED, DAMAGE_APPLIED } from '../../../packages/domain/src/campaign.ts';
import { damageTakenOf } from '../../../packages/engine/src/damage.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import {
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import type { GmProposal } from './gm-proposals.ts';

const CAMPAIGN = 'hollow-lantern';
const D20_PITCH = 'A fantasy story using the d20-lite rules';
const TUI_CLIENT = 'tui';
const D20 = 20;
const D6 = 6;
const HALF = 0.5;
const MISS_FACE = 2;
const SPARE_FACE = 4;
const TAM_ID = 'old-tam';
const TAM_DEFENSE = 10;
const TAM_HP = 30;
const BIG_FIX = 10;
const BIG_PENALTY = -10;
const NO_DAMAGE = 0;
const OPENING_INPUT = 'I look around the tavern';
const ATTACK_INPUT = 'I try it';
const TAM: GmProposal = {
  kind: 'entity',
  id: TAM_ID,
  entityKind: 'npc',
  name: 'Old Tam',
  visibility: 'player',
  sheet: {
    motivations: [],
    background: '',
    traits: [
      { id: 'defense', value: TAM_DEFENSE },
      { id: 'hp', value: TAM_HP },
    ],
    rulepack: { id: D20_LITE_MANIFEST.id, edition: D20_LITE_MANIFEST.edition, revision: D20_LITE_MANIFEST.revision },
  },
};
const ATTACK_OFFER: GmProposal = {
  kind: 'check',
  id: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam',
};

const scripted = (...draws: number[]) => {
  const queue = [...draws];
  return () => queue.shift() ?? HALF;
};

const table = async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-ooc-attack-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const describeHero = async () => 'Wren, a scout. Might 3, Agility 2, Wits 2, Presence 1';
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, D20_PITCH, describeHero, TUI_CLIENT));
  let calls = 0;
  const gm: GameMaster = {
    request: async () => {
      calls += 1;
      return {
        narration: FAKE_GM_REPLY,
        segments: [{ text: FAKE_GM_REPLY }],
        proposals: calls === 1 ? [TAM, ATTACK_OFFER] : [],
      };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const rng = scripted((MISS_FACE - 1 + HALF) / D20, (SPARE_FACE - 1 + HALF) / D6);
  const opened = openClientSession(dataDir, CAMPAIGN, gm, rng);
  t.after(opened.close);
  const envelope = { version: PROTOCOL_VERSION, campaignId: opened.campaignId } as const;
  const snapshot = () => {
    const result = opened.session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(result.ok);
    return result.value;
  };
  const say = async (input: string) => {
    const before = snapshot();
    const submitted = opened.session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: before.revision,
      sceneId: before.currentScene?.id ?? '',
      actorId: before.characters[0]?.id ?? '',
      input,
    });
    assert.ok(submitted.ok, submitted.ok ? '' : submitted.error.message);
    await opened.narrate();
  };
  const saved = opened.session.saveGmSettings({
    ...envelope,
    type: 'SaveGmSettings',
    actionId: 'who-rolls',
    expectedRevision: snapshot().revision,
    whoRolls: 'app',
  } as never);
  assert.ok(saved.ok, saved.ok ? '' : saved.error.message);
  const fix = (value: number) => {
    const confirmed = opened.session.confirmOocProposal({
      ...envelope,
      type: 'ConfirmOocProposal',
      actionId: randomUUID(),
      expectedRevision: snapshot().revision,
      proposal: { kind: 'roll_fix', summary: `Add ${value}`, reason: 'table fix', value },
    });
    assert.ok(confirmed.ok, confirmed.ok ? '' : confirmed.error.message);
  };
  const undo = () => {
    const undone = opened.session.undoOocChange({
      ...envelope,
      type: 'UndoOocChange',
      actionId: randomUUID(),
      expectedRevision: snapshot().revision,
    });
    assert.ok(undone.ok, undone.ok ? '' : undone.error.message);
  };
  const events = () => readCampaignState(dataDir, CAMPAIGN).events;
  const taken = () => damageTakenOf(events(), TAM_ID);
  const damages = () => events().filter(({ type }) => type === DAMAGE_APPLIED);
  return { say, fix, undo, events, taken, damages };
};

it('rpg-42a.134: roll fixes turn an attack miss into a hit and back, and undo restores the damage', async (t) => {
  const { say, fix, undo, events, taken, damages } = await table(t);
  await say(OPENING_INPUT);
  await say(ATTACK_INPUT);
  const resolved = events().find(({ type }) => type === CHECK_RESOLVED);
  const stored = resolved?.payload.resolution as { events: { event: string }[]; attack: { damageBonus: number } };
  assert.deepEqual(
    stored.events.map(({ event }) => event),
    ['attack.miss'],
  );
  assert.equal(taken(), NO_DAMAGE);
  const hitDamage = Math.max(SPARE_FACE + stored.attack.damageBonus, 1);

  fix(BIG_FIX);
  assert.equal(taken(), hitDamage);

  fix(BIG_PENALTY);
  assert.equal(taken(), NO_DAMAGE);
  assert.equal(Number(damages().at(-1)?.payload.amount), -hitDamage);

  undo();
  assert.equal(taken(), hitDamage);
  undo();
  assert.equal(taken(), NO_DAMAGE);
  assert.equal(damages().length, 0);
});
