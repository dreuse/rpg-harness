import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignEvent, DAMAGE_APPLIED } from '../../domain/src/campaign.ts';
import type { CampaignEntity } from '../../domain/src/entity.ts';
import { type CombatRules, combatantOf, damageTakenOf, NPC_SHEET_FIELD, targetNpcOf } from './damage.ts';

const PACK = { id: 'any-pack', edition: '2', revision: 'r7' };
const RULES: CombatRules = { pack: PACK, defense: 'armor', hitPoints: 'vigor' };
const NPC_ID = 'npc-warden';
const DEFENSE = 13;
const VIGOR = 9;
const DAMAGE = 4;

const sparse = (traits: readonly { id: string; value: unknown }[], rulepack = PACK) => ({
  detail: 'sparse',
  npcId: NPC_ID,
  role: 'minor',
  name: 'Warden Oslo',
  motivations: [],
  background: '',
  traits,
  rulepack,
});

const full = (traits: readonly { id: string; value: unknown }[]) => ({
  detail: 'full',
  npcId: NPC_ID,
  role: 'major',
  profile: {
    identity: { name: 'Warden Oslo' },
    motivations: [],
    background: '',
    traits,
    conditions: [],
    rulepack: PACK,
  },
  rulepack: { ...PACK, sourceRefs: [] },
});

const STATS = [
  { id: 'armor', value: DEFENSE },
  { id: 'vigor', value: VIGOR },
];

const npc = (sheet?: unknown, overrides: Partial<CampaignEntity> = {}): CampaignEntity => ({
  id: NPC_ID,
  campaignId: 'campaign-1',
  kind: 'npc',
  name: 'Warden Oslo',
  data: sheet === undefined ? {} : { [NPC_SHEET_FIELD]: sheet },
  visibility: 'public',
  actorId: null,
  ...overrides,
});

const damaged = (amount: number, targetId = NPC_ID): CampaignEvent => ({
  id: `event-${amount}-${targetId}`,
  campaignId: 'campaign-1',
  turnId: 'turn-1',
  causationId: null,
  type: DAMAGE_APPLIED,
  payload: { targetId, amount, defeated: false },
});

test('a sparse or full npc sheet yields the defense and hit points the pack names', () => {
  for (const sheet of [sparse(STATS), full(STATS)])
    assert.deepEqual(combatantOf(npc(sheet), [], RULES), {
      npcId: NPC_ID,
      name: 'Warden Oslo',
      defense: DEFENSE,
      current: VIGOR,
      max: VIGOR,
    });
});

test('damage events lower current hit points of that npc only and never below zero', () => {
  const events = [damaged(DAMAGE), damaged(DAMAGE, 'someone-else')];
  assert.equal(damageTakenOf(events, NPC_ID), DAMAGE);
  assert.equal(combatantOf(npc(sparse(STATS)), events, RULES)?.current, VIGOR - DAMAGE);
  assert.equal(combatantOf(npc(sparse(STATS)), [damaged(VIGOR), damaged(DAMAGE)], RULES)?.current, 0);
});

test('an npc without usable defense or hit point data is not a combatant', () => {
  const cases: unknown[] = [
    undefined,
    'not a sheet',
    sparse([{ id: 'armor', value: DEFENSE }]),
    sparse([{ id: 'armor', value: 'high' }, ...STATS.slice(1)]),
    sparse([
      { id: 'armor', value: DEFENSE },
      { id: 'vigor', value: -1 },
    ]),
    sparse(STATS, { ...PACK, revision: 'r8' }),
    { ...sparse(STATS), traits: 'broken' },
  ];
  for (const sheet of cases) assert.equal(combatantOf(npc(sheet), [], RULES), undefined);
});

test('a target resolves to one npc by id or name and never to an ambiguous or non-npc entity', () => {
  const twin = npc(undefined, { id: 'npc-other' });
  const place = npc(undefined, { id: 'place', kind: 'location', name: 'Gate' });
  const entities = [npc(sparse(STATS)), place];
  assert.equal(targetNpcOf(entities, NPC_ID)?.id, NPC_ID);
  assert.equal(targetNpcOf(entities, '  warden OSLO ')?.id, NPC_ID);
  assert.equal(targetNpcOf(entities, 'Gate'), undefined);
  assert.equal(targetNpcOf([...entities, twin], 'Warden Oslo'), undefined);
  assert.equal(targetNpcOf(entities, 'nobody'), undefined);
});

test('an npc the player cannot see is never a target, even when it is the only match', () => {
  const hidden = npc(sparse(STATS), { visibility: 'gm' });
  assert.equal(targetNpcOf([hidden], NPC_ID), undefined);
  assert.equal(targetNpcOf([hidden], 'Warden Oslo'), undefined);
  const seen = npc(sparse(STATS), { id: 'npc-seen', visibility: 'player' });
  assert.equal(targetNpcOf([hidden, seen], 'Warden Oslo')?.id, 'npc-seen');
});
