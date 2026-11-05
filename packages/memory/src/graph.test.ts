import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignEvent } from '../../domain/src/campaign.ts';
import type { CampaignEntity, Relationship } from '../../domain/src/entity.ts';
import {
  CONTAINS,
  type GraphInput,
  type GraphNode,
  graphContext,
  KEY_FACT_LIMIT,
  PENDING_HOP_LIMIT,
  PENDING_OPENED,
  PENDING_RESOLVED,
  pendingOf,
  type Touch,
} from './graph.ts';
import { type Fact, GM_VIEWER, PLAYER_VIEWER } from './knowledge.ts';

const CAMPAIGN = 'campaign-1';

const entity = (id: string, name: string, overrides: Partial<CampaignEntity> = {}): CampaignEntity => ({
  id,
  campaignId: CAMPAIGN,
  kind: 'npc',
  name,
  data: {},
  visibility: 'public',
  actorId: null,
  ...overrides,
});

const fact = (id: string, subjectId: string | null, statement: string, overrides: Partial<Fact> = {}): Fact => ({
  id,
  campaignId: CAMPAIGN,
  subjectId,
  statement,
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
  ...overrides,
});

const event = (id: string, type: string, payload: Record<string, unknown>): CampaignEvent => ({
  id,
  campaignId: CAMPAIGN,
  turnId: `turn-${id}`,
  causationId: null,
  type,
  payload,
});

const MIRA = entity('mira', 'Mira');
const BRAM = entity('bram', 'Bram');
const SPY = entity('spy', 'The Spy', { visibility: 'gm' });
const ROOM = entity('room', 'Back Room', { kind: 'location', data: { summary: 'a smoky room' } });
const CITY = entity('city', 'Saltmarsh', { kind: 'location', data: { summary: 'a port city' } });
const CELLAR = entity('cellar', 'Cellar', { kind: 'location' });
const FAR = entity('far', 'Far Away');

const relationship = (id: string, kind: string, sourceId: string, targetId: string): Relationship => ({
  id,
  campaignId: CAMPAIGN,
  kind,
  sourceId,
  targetId,
  data: {},
});

const PROMISE_EVENT = event('event-promise', PENDING_OPENED, {
  pendingId: 'promise-1',
  kind: 'promise',
  text: 'Mira will repay the debt',
  entityIds: ['mira'],
  visibility: 'public',
  actorId: null,
});
const PLOT_EVENT = event('event-plot', PENDING_OPENED, {
  pendingId: 'plot-1',
  kind: 'plan',
  text: 'The spy poisons the well',
  entityIds: ['spy'],
  visibility: 'gm',
  actorId: null,
});
const DONE_EVENT = event('event-done', PENDING_OPENED, {
  pendingId: 'done-1',
  kind: 'thread',
  text: 'Find the lost ring',
  entityIds: ['mira'],
  visibility: 'public',
  actorId: null,
});
const RESOLVED_EVENT = event('event-resolved', PENDING_RESOLVED, { pendingId: 'done-1' });

const node = (id: string, hops: number, role: GraphNode['role'] = 'link'): GraphNode => ({ id, hops, role });
const touch = (entityId: string, seq: number): Touch => ({
  entityId,
  eventId: `event-${seq}`,
  seq,
  visibility: 'public',
  actorId: null,
});

const input = (): GraphInput => ({
  nodes: [
    node('mira', 0),
    node('bram', 1),
    node('promise-1', 1),
    node('far', 2),
    node('room', 1, 'parent'),
    node('city', 2, 'parent'),
    node('cellar', 1, 'child'),
  ],
  entities: [MIRA, BRAM, SPY, ROOM, CITY, CELLAR, FAR],
  relationships: [
    relationship('rel-friend', 'friend', 'mira', 'bram'),
    relationship('rel-spy', 'handler', 'spy', 'mira'),
    relationship('rel-room', CONTAINS, 'room', 'mira'),
  ],
  facts: [
    fact('mira-1', 'mira', 'Mira owes the guild 40 crowns', { sourceEventId: 'event-5' }),
    fact('mira-2', 'mira', 'Mira rumours say she is a smuggler', { layer: 'rumor' }),
    fact('mira-secret', 'mira', 'Mira works for the spy', { visibility: 'gm' }),
    fact('mira-old', 'mira', 'Mira was a baker', { layer: 'invalidated' }),
    fact('bram-1', 'bram', 'Bram is a smith'),
    fact('bram-2', 'bram', 'Bram has a daughter'),
    fact('bram-3', 'bram', 'Bram fears fire'),
    fact('room-1', 'room', 'The back room has a trapdoor'),
    fact('far-1', 'far', 'Far Away is far'),
    fact('world-1', null, 'The king is dead'),
  ],
  pending: pendingOf([PROMISE_EVENT, PLOT_EVENT, DONE_EVENT, RESOLVED_EVENT]),
  touches: [touch('mira', 5), touch('bram', 900), touch('bram', 901)],
});

const texts = (items: readonly { readonly text: string }[]) => items.map(({ text }) => text);

test('rpg-42a.36 open pending items are a projection of committed events', () => {
  const pending = pendingOf([PROMISE_EVENT, PLOT_EVENT, DONE_EVENT, RESOLVED_EVENT]);
  assert.deepEqual(
    pending.map(({ id, kind, entityIds, sourceEventId }) => ({ id, kind, entityIds, sourceEventId })),
    [
      { id: 'promise-1', kind: 'promise', entityIds: ['mira'], sourceEventId: 'event-promise' },
      { id: 'plot-1', kind: 'plan', entityIds: ['spy'], sourceEventId: 'event-plot' },
    ],
  );
});

test('rpg-42a.36 scene entities get full facts, one-hop entities key facts, containers only summaries', () => {
  const items = texts(graphContext(input(), PLAYER_VIEWER));
  const joined = items.join('\n');
  assert.ok(joined.includes('Mira owes the guild 40 crowns'));
  assert.ok(joined.includes('Mira rumours say she is a smuggler'));
  assert.ok(!joined.includes('Mira was a baker'));
  assert.ok(joined.includes('Mira friend Bram'));
  const bramFacts = items.filter((text) => text.startsWith('Bram ') && !text.includes('(npc)'));
  assert.equal(bramFacts.length, KEY_FACT_LIMIT);
  assert.ok(joined.includes('Back Room: a smoky room'));
  assert.ok(joined.includes('Saltmarsh: a port city'));
  assert.ok(!joined.includes('trapdoor'));
  assert.ok(joined.includes('Cellar'));
  assert.ok(!joined.includes('Far Away'));
  assert.ok(joined.includes('promise: Mira will repay the debt'));
  assert.ok(!joined.includes('Find the lost ring'));
  assert.ok(joined.includes('The king is dead'));
});

test('rpg-42a.36 visibility filters every node, fact, edge and pending item', () => {
  const player = texts(graphContext(input(), PLAYER_VIEWER)).join('\n');
  for (const secret of ['The Spy', 'handler', 'works for the spy', 'poisons the well']) {
    assert.ok(!player.includes(secret), secret);
  }
  const withSpy: GraphInput = { ...input(), nodes: [...input().nodes, node('spy', 1), node('plot-1', 2)] };
  const gm = texts(graphContext(withSpy, GM_VIEWER)).join('\n');
  assert.ok(gm.includes('Mira works for the spy'));
  assert.ok(gm.includes('The Spy handler Mira'));
  assert.ok(gm.includes('plan: The spy poisons the well'));
  assert.ok(!texts(graphContext(withSpy, PLAYER_VIEWER)).join('\n').includes('The Spy'));
});

test('rpg-42a.36 players never see raw entity data, edge data or NPC state records', () => {
  const plotting = entity('mira', 'Mira', { data: { summary: 'a fence', scheme: 'betray the party' } });
  const withState: GraphInput = {
    ...input(),
    entities: [plotting, ...input().entities.filter(({ id }) => id !== 'mira')],
    relationships: [
      ...input().relationships,
      { ...relationship('mira/npc-state', 'npc-state', 'mira', 'mira'), data: { goals: ['betray the party'] } },
      { ...relationship('mira/stance/bram', 'stance', 'mira', 'bram'), data: { stance: 'hostile' } },
    ],
  };
  const player = texts(graphContext(withState, PLAYER_VIEWER)).join('\n');
  for (const secret of ['betray the party', 'hostile', 'npc-state']) assert.ok(!player.includes(secret), secret);
  assert.ok(player.includes('Mira (npc): a fence'));
  assert.ok(player.includes('Mira stance Bram'));
  const gm = texts(graphContext(withState, GM_VIEWER)).join('\n');
  assert.ok(gm.includes('betray the party'));
  assert.ok(!gm.includes('npc-state'));
});

test('rpg-42a.36 ranking prefers near hops, then open threads, recency and salience', () => {
  const ranked = graphContext(input(), PLAYER_VIEWER).map(({ id }) => id);
  assert.ok(ranked.indexOf('mira') < ranked.indexOf('bram'));
  assert.ok(ranked.indexOf('promise-1') < ranked.indexOf('bram'));
  assert.ok(ranked.indexOf('bram') < ranked.indexOf('city'));
  const recentFirst: GraphInput = {
    ...input(),
    nodes: [node('mira', 1), node('bram', 1)],
    pending: [],
  };
  const order = graphContext(recentFirst, PLAYER_VIEWER).map(({ id }) => id);
  assert.ok(order.indexOf('bram') < order.indexOf('mira'));
  assert.ok(PENDING_HOP_LIMIT >= 1);
  const tooFar: GraphInput = { ...input(), nodes: [node('mira', 0), node('promise-1', PENDING_HOP_LIMIT + 1)] };
  assert.ok(!graphContext(tooFar, PLAYER_VIEWER).some(({ id }) => id === 'promise-1'));
});
