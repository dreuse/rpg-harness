import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { type CampaignStore, type CommittedTurn, MAIN_BRANCH } from '../../../packages/domain/src/campaign.ts';
import { introduceEntity, openPending, saveContextBudget } from '../../../packages/engine/src/memory.ts';
import { openScene, type PlayerAction, performAction } from '../../../packages/engine/src/turn.ts';
import { PENDING_HOP_LIMIT } from '../../../packages/memory/src/graph.ts';
import { summariesOf } from '../../../packages/memory/src/history.ts';
import {
  CONTEXT_BUDGETS,
  packetText,
  RECENT_TURN_LIMIT,
  STABLE_SECTIONS,
} from '../../../packages/memory/src/packet.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore, createFactStore } from '../../../packages/persistence/src/entity-store.ts';
import { createEventStore } from '../../../packages/persistence/src/event-store.ts';
import { languageInstruction, SYSTEM_PROMPT } from './gm-api.ts';
import {
  CHAPTER_SCENE_COUNT,
  contextPacketOf,
  fakeSummarizer,
  SCENE_TURN_LIMIT,
  type Summarizer,
  summarizeCampaign,
} from './gm-context.ts';

const IN_MEMORY = ':memory:';
const PORTUGUESE = 'pt-BR';
const CAMPAIGN = { id: 'campaign-1', name: 'Long Road' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: MAIN_BRANCH,
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const LONG_CAMPAIGN_TURNS = 1000;
const NPC_TURN = 5;
const RETURN_TURN = 900;
const NPC_FACT = 'Captain Ilse owes Mara a ship';
const NPC_SECRET = 'Captain Ilse sold the map to pirates';
const WORLD_FACT = 'The old king died in the winter of the first turn';
const PROMISE = 'Ilse will sail Mara to the Ember Isles';
const GM_PLAN = 'Pirates ambush the harbour at dawn';
const FAR_CLOCK = 'The beacon fails in three days';
const HARBOUR = 'harbour';
const ILSE = 'ilse';
const PUBLIC = { visibility: 'public' as const, actorId: null };
const SECRET = { visibility: 'gm' as const, actorId: null };

const campaign = (payload: Readonly<Record<string, unknown>> = CREATED_EVENT.payload) => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  const store = createCampaignStore(database);
  store.createCampaign(CAMPAIGN, { ...CREATED_EVENT, payload });
  openScene(store, { campaignId: CAMPAIGN.id, actorName: 'Mara', sceneTitle: 'The Docks', narration: 'Gulls cry.' });
  const entities = createEntityStore(database);
  const facts = createFactStore(database);
  entities.saveEntity({ id: HARBOUR, campaignId: CAMPAIGN.id, kind: 'location', name: 'Harbour', data: {}, ...PUBLIC });
  return { connection, database, store, entities, facts };
};

const actionFor = (store: CampaignStore, actionId: string, input = `I walk the docks ${actionId}`): PlayerAction => {
  const state = store.load(CAMPAIGN.id);
  assert.ok(state?.currentScene);
  const [actor] = state.characters;
  assert.ok(actor);
  return {
    campaignId: CAMPAIGN.id,
    actionId,
    expectedRevision: state.revision,
    sceneId: state.currentScene.id,
    actorId: actor.id,
    input,
    intent: input,
  };
};

const play = (store: CampaignStore, actionId: string, input?: string): CommittedTurn => {
  const committed = performAction(store, actionFor(store, actionId, input));
  store.recordNarration(CAMPAIGN.id, committed.turn.id, `The tide turns on ${actionId}.`);
  return committed;
};

const meetIlse = (fixture: ReturnType<typeof campaign>) => {
  const { store, entities, facts } = fixture;
  introduceEntity(store, entities, facts, {
    ...actionFor(store, 'meet-ilse', 'I hail the captain'),
    entity: { id: ILSE, kind: 'npc', name: 'Captain Ilse', data: {}, ...PUBLIC },
    facts: [
      { id: 'ilse-debt', statement: NPC_FACT, layer: 'canon', ...PUBLIC },
      { id: 'ilse-secret', statement: NPC_SECRET, layer: 'canon', ...SECRET },
    ],
    relationships: [{ id: 'harbour-ilse', kind: 'contains', sourceId: HARBOUR, targetId: ILSE, data: {} }],
  });
  openPending(store, {
    ...actionFor(store, 'ilse-promise', 'I accept her offer'),
    pending: { pendingId: 'promise-ilse', kind: 'promise', text: PROMISE, entityIds: [ILSE], ...PUBLIC },
  });
  openPending(store, {
    ...actionFor(store, 'pirate-plan', 'I wait'),
    pending: { pendingId: 'plan-pirates', kind: 'plan', text: GM_PLAN, entityIds: [ILSE], ...SECRET },
  });
};

const packetAt = (fixture: ReturnType<typeof campaign>, committed: CommittedTurn) => {
  const state = fixture.store.load(CAMPAIGN.id);
  assert.ok(state);
  return contextPacketOf(fixture.database, state, committed);
};

const playUntil = (fixture: ReturnType<typeof campaign>, from: number, until: number) => {
  for (let turn = from; turn < until; turn += 1) {
    if (turn === NPC_TURN) meetIlse(fixture);
    else play(fixture.store, `turn-${turn}`);
  }
};

const longCampaign = () => {
  const fixture = campaign();
  const first = play(fixture.store, 'turn-1');
  fixture.facts.saveFact({
    id: 'world-fact',
    campaignId: CAMPAIGN.id,
    subjectId: null,
    statement: WORLD_FACT,
    layer: 'canon',
    sourceEventId: first.events[0]?.id ?? null,
    ...PUBLIC,
  });
  playUntil(fixture, 2, RETURN_TURN);
  return fixture;
};

it('rpg-42a.40 asks for narration and summaries in the campaign language', async () => {
  const fixture = campaign({ ...CREATED_EVENT.payload, language: PORTUGUESE });
  const instructions = (of: ReturnType<typeof campaign>) =>
    packetAt(of, play(of.store, 'turn-1')).sections.find(({ name }) => name === 'instructions')?.items;
  assert.deepEqual(instructions(fixture), [SYSTEM_PROMPT, languageInstruction(PORTUGUESE)]);
  const languages = new Set<string | undefined>();
  playUntil(fixture, 2, SCENE_TURN_LIMIT + 2);
  await summarizeCampaign(fixture.database, fixture.store, CAMPAIGN.id, async (_level, texts, language) => {
    languages.add(language);
    return texts.join(' ');
  });
  assert.deepEqual([...languages], [PORTUGUESE]);
  fixture.connection.close();
});

it('rpg-42a.40 a campaign without a recorded language gets no language line', async () => {
  const fixture = campaign();
  const instructions = packetAt(fixture, play(fixture.store, 'turn-1')).sections.find(
    ({ name }) => name === 'instructions',
  )?.items;
  assert.deepEqual(instructions, [SYSTEM_PROMPT]);
  const languages = new Set<string | undefined>();
  playUntil(fixture, 2, SCENE_TURN_LIMIT + 2);
  await summarizeCampaign(fixture.database, fixture.store, CAMPAIGN.id, async (_level, texts, language) => {
    languages.add(language);
    return texts.join(' ');
  });
  assert.deepEqual([...languages], [undefined]);
  fixture.connection.close();
});

it('rpg-42a.36 leaves out pending items beyond the pending hop limit', () => {
  const fixture = campaign();
  meetIlse(fixture);
  const chain = ['tower', 'keeper', 'beacon'];
  for (const id of chain)
    fixture.entities.saveEntity({ id, campaignId: CAMPAIGN.id, kind: 'location', name: id, data: {}, ...PUBLIC });
  [ILSE, ...chain].slice(1).forEach((targetId, index) => {
    const sourceId = [ILSE, ...chain][index] ?? ILSE;
    fixture.entities.saveRelationship({
      id: `${sourceId}-${targetId}`,
      campaignId: CAMPAIGN.id,
      kind: 'knows',
      sourceId,
      targetId,
      data: {},
    });
  });
  openPending(fixture.store, {
    ...actionFor(fixture.store, 'far-clock', 'I listen'),
    pending: { pendingId: 'clock-far', kind: 'clock', text: FAR_CLOCK, entityIds: ['beacon'], ...PUBLIC },
  });
  for (let turn = 0; turn <= RECENT_TURN_LIMIT; turn += 1) play(fixture.store, `quiet-${turn}`);
  const text = packetText(packetAt(fixture, play(fixture.store, 'seek', 'I look for Captain Ilse')));
  assert.ok(PENDING_HOP_LIMIT < chain.length + 1);
  assert.ok(text.includes(PROMISE));
  assert.ok(!text.includes(FAR_CLOCK));
  fixture.connection.close();
});

it('rpg-42a.36 overlapping summary runs write each scene summary once', async () => {
  const fixture = campaign();
  playUntil(fixture, NPC_TURN + 1, NPC_TURN + 1 + SCENE_TURN_LIMIT);
  const gate = Promise.withResolvers<void>();
  const slow: Summarizer = async (level, texts, language) => {
    await gate.promise;
    return fakeSummarizer(level, texts, language);
  };
  const runs = [1, 2].map(() => summarizeCampaign(fixture.database, fixture.store, CAMPAIGN.id, slow));
  gate.resolve();
  await Promise.all(runs);
  const scenes = summariesOf(createEventStore(fixture.database).list(CAMPAIGN.id, MAIN_BRANCH));
  assert.equal(scenes.filter(({ level }) => level === 'scene').length, 1);
  fixture.connection.close();
});

describe('rpg-42a.36 GM context packet from canonical memory', () => {
  const fixture = longCampaign();
  after(() => fixture.connection.close());

  it('brings back an NPC from turn 5 at turn 900 with facts, relationships and the open promise', () => {
    const committed = play(fixture.store, `turn-${RETURN_TURN}`, 'I look for Captain Ilse');
    const text = packetText(packetAt(fixture, committed));
    for (const expected of [NPC_FACT, PROMISE, 'Harbour contains Captain Ilse'])
      assert.ok(text.includes(expected), expected);
    for (const hidden of [NPC_SECRET, GM_PLAN]) assert.ok(!text.includes(hidden), hidden);
  });

  it('recalls a turn-1 fact at turn 1000 inside the token budget, stable sections first', () => {
    playUntil(fixture, RETURN_TURN + 1, LONG_CAMPAIGN_TURNS);
    const committed = play(fixture.store, `turn-${LONG_CAMPAIGN_TURNS}`, 'I ask about the old king');
    const packet = packetAt(fixture, committed);
    const text = packetText(packet);
    assert.ok(text.includes(WORLD_FACT));
    assert.ok(packet.usedTokens <= CONTEXT_BUDGETS.standard);
    assert.equal(packet.budget, CONTEXT_BUDGETS.standard);
    const names = packet.sections.map(({ name }) => name);
    assert.deepEqual(names.slice(0, STABLE_SECTIONS.length), [...STABLE_SECTIONS]);
    assert.deepEqual(packet.sections.find(({ name }) => name === 'playerInput')?.items, ['I ask about the old king']);
  });

  const useBudget = (preset: string) =>
    saveContextBudget(fixture.store, {
      campaignId: CAMPAIGN.id,
      actionId: `${preset}-budget`,
      expectedRevision: fixture.store.load(CAMPAIGN.id)?.revision ?? 0,
      preset,
    });

  it('uses the per-campaign budget preset', () => {
    useBudget('compact');
    const committed = play(fixture.store, 'compact-turn');
    const packet = packetAt(fixture, committed);
    assert.equal(packet.budget, CONTEXT_BUDGETS.compact);
    assert.ok(packet.usedTokens <= CONTEXT_BUDGETS.compact);
  });

  it('writes player-visible scene, chapter and campaign summaries off the turn path', async () => {
    await summarizeCampaign(fixture.database, fixture.store, CAMPAIGN.id, fakeSummarizer);
    const written = summariesOf(createEventStore(fixture.database).list(CAMPAIGN.id, MAIN_BRANCH));
    const count = (level: string) => written.filter((summary) => summary.level === level).length;
    const scenes = count('scene');
    assert.equal(scenes, Math.floor((fixture.store.load(CAMPAIGN.id)?.turns.length ?? 0) / SCENE_TURN_LIMIT));
    assert.equal(count('chapter'), Math.floor(scenes / CHAPTER_SCENE_COUNT));
    assert.ok(count('campaign') >= 1);
    for (const { summary } of written) {
      assert.equal(summary.visibility, 'player');
      for (const hidden of [NPC_SECRET, GM_PLAN]) assert.ok(!summary.text.includes(hidden));
    }
    await summarizeCampaign(fixture.database, fixture.store, CAMPAIGN.id, fakeSummarizer);
    assert.equal(summariesOf(createEventStore(fixture.database).list(CAMPAIGN.id, MAIN_BRANCH)).length, written.length);
    useBudget('rich');
    const committed = play(fixture.store, 'after-summaries');
    const packet = packetAt(fixture, committed);
    const items = (name: string) => packet.sections.find((section) => section.name === name)?.items ?? [];
    assert.equal(items('campaignSummary').length, 1);
    assert.ok(items('chapterSummaries').length >= 1);
  });
});
