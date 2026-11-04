import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignEvent, Scene } from '../../domain/src/campaign.ts';
import type { CampaignEntity, Relationship } from '../../domain/src/entity.ts';
import { type Fact, GM_VIEWER, PLAYER_VIEWER } from './knowledge.ts';
import { type ContextSnapshot, estimateTokens, retrieveContext, type Thread } from './retrieval.ts';

const CAMPAIGN_ID = 'campaign-1';
const LARGE_BUDGET = 10_000;
const TINY_BUDGET = 1;
const INVALID_BUDGETS = [-1, Number.NaN, 1.5];
const LONG_CAMPAIGN_EVENTS = 500;
const RELEVANT_EVENT_INTERVAL = 100;
const SCENE: Scene = { id: 'scene-inn', campaignId: CAMPAIGN_ID, title: 'The Drowned Inn' };

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
const event = (id: string, payload: Record<string, unknown>): CampaignEvent => ({
  id,
  campaignId: CAMPAIGN_ID,
  turnId: `turn-${id}`,
  causationId: null,
  type: 'npc.spoke',
  payload,
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

const INNKEEPER = entity('npc-innkeeper');
const SMITH = entity('npc-smith');
const CULTIST = entity('npc-cultist', { visibility: 'gm' });
const STRANGER = entity('npc-stranger');
const RELATIONSHIPS: readonly Relationship[] = [
  { id: 'rel-1', campaignId: CAMPAIGN_ID, kind: 'knows', sourceId: INNKEEPER.id, targetId: SMITH.id, data: {} },
  { id: 'rel-2', campaignId: CAMPAIGN_ID, kind: 'serves', sourceId: CULTIST.id, targetId: INNKEEPER.id, data: {} },
];
const ACTIVE_THREAD: Thread = {
  id: 'thread-ledger',
  campaignId: CAMPAIGN_ID,
  title: 'Find the missing ledger page',
  status: 'active',
  entityIds: [SMITH.id],
  visibility: 'public',
  actorId: null,
  sourceEventId: 'event-thread',
};
const RESOLVED_THREAD: Thread = { ...ACTIVE_THREAD, id: 'thread-old', status: 'resolved' };
const CANON = fact('fact-canon', { subjectId: INNKEEPER.id, sourceEventId: 'event-canon' });
const PINNED = fact('fact-pinned', { subjectId: STRANGER.id, sourceEventId: 'event-pinned' });
const SECRET = fact('fact-secret', { subjectId: INNKEEPER.id, visibility: 'gm', sourceEventId: 'event-secret' });
const RUMOR = fact('fact-rumor', { subjectId: SMITH.id, layer: 'rumor', visibility: 'player' });
const UNRELATED_CANON = fact('fact-unrelated', { subjectId: STRANGER.id });

const snapshot = (events: readonly CampaignEvent[]): ContextSnapshot => ({
  scene: SCENE,
  sceneEntityIds: [INNKEEPER.id],
  pinnedFactIds: [PINNED.id],
  entities: [INNKEEPER, SMITH, CULTIST, STRANGER],
  relationships: RELATIONSHIPS,
  threads: [ACTIVE_THREAD, RESOLVED_THREAD],
  facts: [CANON, PINNED, SECRET, RUMOR, UNRELATED_CANON],
  events,
});
const ids = (items: readonly { readonly id: string }[]) => items.map((item) => item.id);

test('retrieve current scene, related entities, active threads and provenance with token budget', () => {
  const history = [event('event-smith', { entityId: SMITH.id }), event('event-stranger', { entityId: STRANGER.id })];
  const context = retrieveContext(snapshot(history), PLAYER_VIEWER, LARGE_BUDGET);

  assert.equal(context.scene.id, SCENE.id);
  assert.deepEqual(ids(context.entities), [INNKEEPER.id, SMITH.id]);
  assert.deepEqual(ids(context.threads), [ACTIVE_THREAD.id]);
  assert.deepEqual(ids(context.facts), [CANON.id, PINNED.id, RUMOR.id]);
  assert.deepEqual(context.history, []);
  assert.deepEqual(context.entities.find((item) => item.id === SMITH.id)?.sourceEventIds, []);
  assert.deepEqual(context.threads[0]?.sourceEventIds, ['event-thread']);
  assert.deepEqual(context.facts[0]?.sourceEventIds, ['event-canon']);
  assert.equal(context.requiredExceedsBudget, false);
  assert.deepEqual(context.truncated, []);
  assert.ok(context.usedTokens <= LARGE_BUDGET);
  const items = [context.scene, ...context.entities, ...context.threads, ...context.facts];
  assert.equal(
    context.usedTokens,
    items.reduce((sum, item) => sum + item.tokens, 0),
  );
  assert.equal(context.scene.tokens, estimateTokens(context.scene.text));
  assert.equal(JSON.stringify(context).includes(CULTIST.id), false);
  assert.equal(JSON.stringify(context).includes(SECRET.id), false);

  const gmContext = retrieveContext(snapshot(history), GM_VIEWER, LARGE_BUDGET);
  assert.deepEqual(ids(gmContext.entities), [INNKEEPER.id, SMITH.id, CULTIST.id]);
  assert.deepEqual(ids(gmContext.history), ['event-smith']);
});

test('long campaign retrieval excludes irrelevant history without losing required constraints', () => {
  const history = Array.from({ length: LONG_CAMPAIGN_EVENTS }, (_, index) =>
    event(
      `event-${index}`,
      index % RELEVANT_EVENT_INTERVAL === 0 ? { entityId: INNKEEPER.id } : { entityId: STRANGER.id },
    ),
  );
  const relevant = history.filter((_, index) => index % RELEVANT_EVENT_INTERVAL === 0);
  const full = retrieveContext(snapshot(history), GM_VIEWER, LARGE_BUDGET);
  assert.deepEqual(ids(full.history), ids(relevant).reverse());

  const required = [full.scene, ...full.threads, ...full.facts.filter((item) => item.required)];
  const requiredTokens = required.reduce((sum, item) => sum + item.tokens, 0);
  const tight = retrieveContext(snapshot(history), GM_VIEWER, requiredTokens);
  assert.deepEqual(ids(tight.threads), [ACTIVE_THREAD.id]);
  assert.deepEqual(ids(tight.facts.filter((item) => item.required)), [CANON.id, PINNED.id, SECRET.id]);
  assert.deepEqual(tight.history, []);
  assert.equal(tight.requiredExceedsBudget, false);
  assert.equal(tight.usedTokens, requiredTokens);
  assert.ok(tight.truncated.some((item) => item.kind === 'history'));
  assert.ok(tight.truncated.some((item) => item.kind === 'entity'));

  const starved = retrieveContext(snapshot(history), GM_VIEWER, TINY_BUDGET);
  assert.equal(starved.requiredExceedsBudget, true);
  assert.deepEqual(ids(starved.facts), [CANON.id, PINNED.id, SECRET.id]);
  assert.deepEqual(ids(starved.threads), [ACTIVE_THREAD.id]);
  assert.ok(starved.usedTokens > TINY_BUDGET);
  for (const budget of INVALID_BUDGETS) {
    assert.throws(() => retrieveContext(snapshot(history), GM_VIEWER, budget), RangeError);
  }
});

test('gm provenance stays bounded and keeps the newest events as history grows', () => {
  const history = Array.from({ length: LONG_CAMPAIGN_EVENTS }, (_, index) =>
    event(`event-${index}`, { entityId: INNKEEPER.id, sceneId: SCENE.id }),
  );
  const provenanceAt = (count: number) => {
    const context = retrieveContext(snapshot(history.slice(0, count)), GM_VIEWER, LARGE_BUDGET);
    return [context.scene, ...context.entities.filter((item) => item.id === INNKEEPER.id)].map(
      (item) => item.sourceEventIds,
    );
  };
  const early = provenanceAt(RELEVANT_EVENT_INTERVAL);
  const late = provenanceAt(LONG_CAMPAIGN_EVENTS);
  assert.deepEqual(
    late.map((ids) => ids.length),
    early.map((ids) => ids.length),
  );
  assert.ok(late.every((ids) => ids.length < RELEVANT_EVENT_INTERVAL));
  assert.ok(late.every((ids) => ids.at(-1) === history.at(-1)?.id));
});

test('player retrieval does not follow hidden entities or expose scanned provenance', () => {
  const cultistLore = fact('fact-cultist-lore', { subjectId: CULTIST.id });
  const spymaster = entity('npc-spymaster');
  const base = snapshot([event('event-smith', { entityId: SMITH.id })]);
  const leaky: ContextSnapshot = {
    ...base,
    sceneEntityIds: [INNKEEPER.id, CULTIST.id],
    entities: [...base.entities, spymaster],
    relationships: [
      ...base.relationships,
      {
        id: 'rel-3',
        campaignId: CAMPAIGN_ID,
        kind: 'reports-to',
        sourceId: spymaster.id,
        targetId: CULTIST.id,
        data: {},
      },
    ],
    facts: [...base.facts, cultistLore],
  };
  const player = retrieveContext(leaky, PLAYER_VIEWER, LARGE_BUDGET);
  assert.deepEqual(ids(player.entities), [INNKEEPER.id, SMITH.id]);
  assert.equal(ids(player.facts).includes(cultistLore.id), false);
  assert.deepEqual(player.entities.find((item) => item.id === SMITH.id)?.sourceEventIds, []);
  assert.deepEqual(player.facts[0]?.sourceEventIds, ['event-canon']);

  const gm = retrieveContext(leaky, GM_VIEWER, LARGE_BUDGET);
  assert.ok(ids(gm.entities).includes(spymaster.id));
  assert.ok(ids(gm.facts).includes(cultistLore.id));
  assert.deepEqual(gm.entities.find((item) => item.id === SMITH.id)?.sourceEventIds, ['event-smith']);
});
