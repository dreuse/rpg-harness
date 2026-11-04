import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignEvent, Scene } from '../../domain/src/campaign.ts';
import type { RulePackLink } from '../../domain/src/character.ts';
import type { CampaignEntity } from '../../domain/src/entity.ts';
import { type Fact, GM_VIEWER, PLAYER_VIEWER } from '../../memory/src/knowledge.ts';
import type { ContextSnapshot } from '../../memory/src/retrieval.ts';
import { assembleGmContext, type RuleEntry } from './context.ts';
import type { NpcState } from './npc.ts';

const CAMPAIGN_ID = 'campaign-1';
const BUDGET = 10_000;
const SCENE: Scene = { id: 'scene-vault', campaignId: CAMPAIGN_ID, title: 'The Sealed Vault' };
const RULEPACK: RulePackLink = { id: 'pack-generic', edition: 'core', revision: 'r1' };

const entity = (id: string, overrides: Partial<CampaignEntity> = {}): CampaignEntity => ({
  id,
  campaignId: CAMPAIGN_ID,
  kind: 'npc',
  name: id,
  data: {},
  visibility: 'public',
  actorId: null,
  ...overrides,
});
const fact = (id: string, overrides: Partial<Fact> = {}): Fact => ({
  id,
  campaignId: CAMPAIGN_ID,
  subjectId: null,
  statement: `statement ${id}`,
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
  ...overrides,
});
const rule = (id: string, overrides: Partial<RuleEntry> = {}): RuleEntry => ({
  id,
  summary: `summary ${id}`,
  section: `section-${id}`,
  visibility: 'public',
  actorId: null,
  ...overrides,
});

const WARDEN = entity('npc-warden');
const TRAITOR = entity('npc-traitor', { visibility: 'gm' });
const CANON = fact('fact-canon', { subjectId: WARDEN.id, sourceEventId: 'event-canon' });
const SECRET = fact('fact-secret', { subjectId: WARDEN.id, visibility: 'gm', statement: 'warden is the thief' });
const NPC_BELIEF = fact('fact-belief', {
  subjectId: WARDEN.id,
  layer: 'belief',
  visibility: 'actor-scoped',
  actorId: WARDEN.id,
  statement: 'warden hides the key',
});
const OPEN_RULE = rule('rule-check');
const HIDDEN_RULE = rule('rule-trap', { visibility: 'gm', summary: 'vault trap triggers on touch' });
const EVENT: CampaignEvent = {
  id: 'event-arrival',
  campaignId: CAMPAIGN_ID,
  turnId: 'turn-1',
  causationId: null,
  type: 'npc.spoke',
  payload: { speakerId: WARDEN.id },
};

const SNAPSHOT: ContextSnapshot = {
  scene: SCENE,
  sceneEntityIds: [WARDEN.id, TRAITOR.id],
  pinnedFactIds: [],
  entities: [WARDEN, TRAITOR],
  relationships: [],
  threads: [],
  facts: [CANON, SECRET, NPC_BELIEF],
  events: [EVENT],
};
const INPUT = { snapshot: SNAPSHOT, rulepack: RULEPACK, rules: [OPEN_RULE, HIDDEN_RULE], budget: BUDGET };
const HERO_ID = 'character-hero';
const WARDEN_NPC: NpcState = {
  id: WARDEN.id,
  goals: ['guard the key'],
  disposition: 'stern',
  relationships: { [HERO_ID]: 'wary' },
  learned: [{ factId: NPC_BELIEF.id, channel: 'witnessed', sourceId: null, eventId: EVENT.id }],
};
const DIALOGUE_INPUT = { ...INPUT, dialogue: { npc: WARDEN_NPC, speakerId: HERO_ID } };

test('construct scoped relevant context for claude with rules and source references', () => {
  const context = assembleGmContext(INPUT, GM_VIEWER);

  assert.deepEqual(context.rulepack, RULEPACK);
  assert.deepEqual(
    context.rules.map(({ id }) => id),
    [OPEN_RULE.id, HIDDEN_RULE.id],
  );
  assert.deepEqual(context.rules[0]?.sources, [{ type: 'rule', rulepack: RULEPACK, section: OPEN_RULE.section }]);
  assert.deepEqual(
    context.entries.map(({ kind, id }) => `${kind}:${id}`),
    [
      `scene:${SCENE.id}`,
      `fact:${CANON.id}`,
      `fact:${SECRET.id}`,
      `fact:${NPC_BELIEF.id}`,
      `entity:${WARDEN.id}`,
      `entity:${TRAITOR.id}`,
      `history:${EVENT.id}`,
    ],
  );
  const canon = context.entries.find(({ id }) => id === CANON.id);
  assert.deepEqual(canon?.sources, [{ type: 'event', id: CANON.sourceEventId }]);
  assert.equal(context.requiredExceedsBudget, false);
});

test('no hidden npc knowledge or gm-only secret appears in player-facing context', () => {
  const context = assembleGmContext(INPUT, PLAYER_VIEWER);
  const serialized = JSON.stringify(context);

  for (const hidden of [SECRET, NPC_BELIEF]) {
    assert.ok(!serialized.includes(hidden.id));
    assert.ok(!serialized.includes(hidden.statement));
  }
  assert.ok(!serialized.includes(TRAITOR.id));
  assert.ok(!serialized.includes(HIDDEN_RULE.summary));
  assert.ok(!serialized.includes(EVENT.id));
  assert.deepEqual(
    context.entries.map(({ id }) => id),
    [SCENE.id, CANON.id, WARDEN.id],
  );
  assert.deepEqual(
    context.entries.map(({ sources }) => sources),
    [[], [{ type: 'event', id: CANON.sourceEventId }], []],
  );
  assert.deepEqual(
    context.rules.map(({ id }) => id),
    [OPEN_RULE.id],
  );
});

test('gm and the npc itself receive the npc dialogue context', () => {
  for (const viewer of [GM_VIEWER, { scope: 'actor', actorId: WARDEN.id } as const]) {
    const { dialogue } = assembleGmContext(DIALOGUE_INPUT, viewer);
    assert.equal(dialogue?.npcId, WARDEN.id);
    assert.equal(dialogue?.stance, 'wary');
    assert.deepEqual(dialogue?.goals, WARDEN_NPC.goals);
    assert.deepEqual(
      dialogue?.knownFacts.map(({ factId, sourceEventIds }) => [factId, sourceEventIds]),
      [[NPC_BELIEF.id, [EVENT.id]]],
    );
  }
});

test('npc dialogue context stays out of player and other actor context', () => {
  for (const viewer of [PLAYER_VIEWER, { scope: 'actor', actorId: TRAITOR.id } as const]) {
    const context = assembleGmContext(DIALOGUE_INPUT, viewer);
    assert.equal(context.dialogue, undefined);
    assert.ok(!JSON.stringify(context).includes(WARDEN_NPC.disposition));
  }
  assert.equal(assembleGmContext(INPUT, GM_VIEWER).dialogue, undefined);
});
