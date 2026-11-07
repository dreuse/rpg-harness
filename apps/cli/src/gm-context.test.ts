import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { type CampaignStore, type CommittedTurn, MAIN_BRANCH } from '../../../packages/domain/src/campaign.ts';
import { GM_PROPOSALS_REJECTED, saveGmSettings } from '../../../packages/engine/src/gm-settings.ts';
import { introduceEntity, openPending, recordSummary, saveContextBudget } from '../../../packages/engine/src/memory.ts';
import { applyOocProposal, undoOocChange, withoutRetconned } from '../../../packages/engine/src/ooc.ts';
import type { RulesDocument } from '../../../packages/engine/src/own-rules.ts';
import { proposeClaims } from '../../../packages/engine/src/story-memory.ts';
import { commitSystem, openScene, type PlayerAction, performAction } from '../../../packages/engine/src/turn.ts';
import { setVoiceTraits } from '../../../packages/engine/src/voice-profile.ts';
import { PENDING_HOP_LIMIT } from '../../../packages/memory/src/graph.ts';
import { summariesOf, summarize } from '../../../packages/memory/src/history.ts';
import {
  CONTEXT_BUDGETS,
  packetParts,
  packetText,
  RECENT_TURN_LIMIT,
  STABLE_SECTIONS,
} from '../../../packages/memory/src/packet.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore, createFactStore } from '../../../packages/persistence/src/entity-store.ts';
import { createEventStore } from '../../../packages/persistence/src/event-store.ts';
import { D20_LITE_COMBAT, D20_LITE_MANIFEST, D20_LITE_VOCABULARY } from '../../../packages/rules/src/d20-lite.ts';
import {
  checkRulesPrompt,
  GM_ROLL_PROMPT,
  languageInstruction,
  modifiersPrompt,
  npcSheetPrompt,
  RULES_RETRY_PROMPT,
  RULES_STRICTNESS_PROMPTS,
  repetitionRetryPrompt,
  SYSTEM_PROMPT,
  voiceTraitsPrompt,
} from './gm-api.ts';
import {
  CHAPTER_SCENE_COUNT,
  contextPacketOf,
  fakeSummarizer,
  SCENE_TURN_LIMIT,
  STALL_INSTRUCTION,
  STALL_TURN_LIMIT,
  type Summarizer,
  summarizeCampaign,
} from './gm-context.ts';
import { commitProposals } from './gm-proposals.ts';
import { planCampaign } from './quickstart.ts';
import { checkRulesFor } from './roll-visualization.ts';

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
const RETCONNED_INPUT = 'I shout the forbidden word';
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

const campaign = (
  payload: Readonly<Record<string, unknown>> = CREATED_EVENT.payload,
  config?: Readonly<Record<string, unknown>>,
  rulesDocuments?: readonly RulesDocument[],
) => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  const store = createCampaignStore(database);
  store.createCampaign(CAMPAIGN, { ...CREATED_EVENT, payload });
  openScene(store, {
    campaignId: CAMPAIGN.id,
    actorName: 'Mara',
    sceneTitle: 'The Docks',
    narration: 'Gulls cry.',
    ...(config === undefined ? {} : { config }),
    ...(rulesDocuments === undefined ? {} : { rulesDocuments }),
  });
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

it('rpg-42a.91 scene summaries leave out a retconned turn', async () => {
  const fixture = campaign();
  play(fixture.store, 'turn-1');
  play(fixture.store, 'taken-back', RETCONNED_INPUT);
  applyOocProposal(fixture.store, {
    campaignId: CAMPAIGN.id,
    actionId: 'retcon',
    expectedRevision: fixture.store.load(CAMPAIGN.id)?.revision ?? 0,
    proposal: { kind: 'retcon_last_turn', summary: 'Take back your last turn' },
  });
  playUntil(fixture, 2, SCENE_TURN_LIMIT + 2);
  const summarized: string[] = [];
  await summarizeCampaign(fixture.database, fixture.store, CAMPAIGN.id, async (_level, texts) => {
    summarized.push(...texts);
    return texts.join(' ');
  });
  assert.ok(summarized.length > 0);
  assert.equal(
    summarized.some((text) => text.includes(RETCONNED_INPUT)),
    false,
  );
  fixture.connection.close();
});

const retconLast = (fixture: ReturnType<typeof campaign>, actionId: string) =>
  applyOocProposal(fixture.store, {
    campaignId: CAMPAIGN.id,
    actionId,
    expectedRevision: fixture.store.load(CAMPAIGN.id)?.revision ?? 0,
    proposal: { kind: 'retcon_last_turn', summary: 'Take back your last turn' },
  });

const unretconLast = (fixture: ReturnType<typeof campaign>, actionId: string) =>
  undoOocChange(fixture.store, {
    campaignId: CAMPAIGN.id,
    actionId,
    expectedRevision: fixture.store.load(CAMPAIGN.id)?.revision ?? 0,
  });

const retconAwarePacketText = (fixture: ReturnType<typeof campaign>, actionId: string, input = 'I look around') => {
  const committed = play(fixture.store, actionId, input);
  const state = withoutRetconned(fixture.store.load(CAMPAIGN.id) ?? assert.fail());
  return packetText(contextPacketOf(fixture.database, state, committed));
};

it('rpg-42a.107 memory built from a retconned turn does not reach the GM packet and returns on undo', () => {
  const fixture = campaign();
  play(fixture.store, 'turn-1');
  introduceEntity(fixture.store, fixture.entities, fixture.facts, {
    ...actionFor(fixture.store, 'meet-ilse', 'I hail the captain'),
    entity: { id: ILSE, kind: 'npc', name: 'Captain Ilse', data: {}, ...PUBLIC },
    facts: [{ id: 'ilse-debt', statement: NPC_FACT, layer: 'canon', ...PUBLIC }],
    relationships: [{ id: 'harbour-ilse', kind: 'contains', sourceId: HARBOUR, targetId: ILSE, data: {} }],
  });
  openPending(fixture.store, {
    ...actionFor(fixture.store, 'ilse-promise', 'I accept her offer'),
    pending: { pendingId: 'promise-ilse', kind: 'promise', text: PROMISE, entityIds: [ILSE], ...PUBLIC },
  });
  const remembered = retconAwarePacketText(fixture, 'control', 'I look for Captain Ilse');
  for (const expected of [NPC_FACT, PROMISE, 'Harbour contains Captain Ilse']) assert.ok(remembered.includes(expected));
  retconLast(fixture, 'retcon-control');
  retconLast(fixture, 'retcon-memory');
  const forgotten = retconAwarePacketText(fixture, 'after-retcon');
  for (const gone of [NPC_FACT, PROMISE, 'Ilse']) assert.ok(!forgotten.includes(gone), gone);
  unretconLast(fixture, 'undo-memory');
  const restored = retconAwarePacketText(fixture, 'after-undo', 'I look for Captain Ilse');
  for (const expected of [NPC_FACT, PROMISE]) assert.ok(restored.includes(expected), expected);
  fixture.connection.close();
});

it('rpg-42a.107 a scene summary that cites a retconned turn is left out of the GM packet', () => {
  const fixture = campaign();
  play(fixture.store, 'turn-1');
  const taken = play(fixture.store, 'taken-back', RETCONNED_INPUT);
  const state = fixture.store.load(CAMPAIGN.id) ?? assert.fail();
  recordSummary(fixture.store, {
    campaignId: CAMPAIGN.id,
    actionId: 'summary-1',
    expectedRevision: state.revision,
    level: 'scene',
    scopeId: 'scene-1',
    summary: summarize(state.events, {
      id: 'summary-1',
      campaignId: CAMPAIGN.id,
      text: `Mara did this: ${RETCONNED_INPUT}`,
      sourceEventIds: taken.events.map(({ id }) => id),
      visibility: 'player',
      actorId: null,
    }),
  });
  assert.ok(retconAwarePacketText(fixture, 'control').includes(RETCONNED_INPUT));
  retconLast(fixture, 'retcon-control');
  retconLast(fixture, 'retcon');
  assert.ok(!retconAwarePacketText(fixture, 'after-retcon').includes(RETCONNED_INPUT));
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

const instructionsOf = (fixture: ReturnType<typeof campaign>, committed: CommittedTurn) =>
  packetAt(fixture, committed).sections.find(({ name }) => name === 'instructions')?.items;

const quietTurns = (fixture: ReturnType<typeof campaign>, count: number) => {
  let committed = play(fixture.store, 'quiet-0');
  for (let turn = 1; turn < count; turn += 1) committed = play(fixture.store, `quiet-${turn}`);
  return committed;
};

it('rpg-42a.56 requires a development when the last turns added no entity, fact or thread', () => {
  const fixture = campaign();
  const committed = quietTurns(fixture, STALL_TURN_LIMIT);
  assert.deepEqual(instructionsOf(fixture, committed), [SYSTEM_PROMPT, STALL_INSTRUCTION]);
  fixture.connection.close();
});

it('rpg-42a.56 keeps the stall line and the language line together', () => {
  const fixture = campaign({ ...CREATED_EVENT.payload, language: PORTUGUESE });
  const committed = quietTurns(fixture, STALL_TURN_LIMIT);
  assert.deepEqual(instructionsOf(fixture, committed), [
    SYSTEM_PROMPT,
    STALL_INSTRUCTION,
    languageInstruction(PORTUGUESE),
  ]);
  fixture.connection.close();
});

it('rpg-42a.56 does not mark a scene stalled before the stall turn limit', () => {
  const fixture = campaign();
  const committed = quietTurns(fixture, STALL_TURN_LIMIT - 1);
  assert.deepEqual(instructionsOf(fixture, committed), [SYSTEM_PROMPT]);
  fixture.connection.close();
});

it('rpg-42a.56 a new entity resets the stall count', () => {
  const fixture = campaign();
  quietTurns(fixture, STALL_TURN_LIMIT);
  meetIlse(fixture);
  const committed = play(fixture.store, 'after-ilse');
  assert.deepEqual(instructionsOf(fixture, committed), [SYSTEM_PROMPT]);
  const stalled = play(fixture.store, 'after-ilse-2');
  assert.deepEqual(instructionsOf(fixture, stalled), [SYSTEM_PROMPT, STALL_INSTRUCTION]);
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

  it('marks an accepted roll as a roll, not player speech', () => {
    const rollInput = 'Test: Stealth';
    performAction(fixture.store, { ...actionFor(fixture.store, 'roll-turn', rollInput), rollOfferId: 'offer-1' });
    const committed = play(fixture.store, 'after-roll', 'I look around');
    const packet = packetAt(fixture, committed);
    const turns = packet.sections.find(({ name }) => name === 'recentTurns')?.items.join('\n') ?? '';
    assert.ok(turns.includes(`Roll accepted: ${rollInput}`));
    assert.ok(!turns.includes(`Player: ${rollInput}`));
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

it('rpg-42a.42 the packet carries the ledger facts of a named entity at turn 900 and hides secrets', () => {
  const fixture = campaign();
  play(fixture.store, 'turn-1');
  meetIlse(fixture);
  proposeClaims(fixture.store, fixture.entities, {
    ...actionFor(fixture.store, 'ilse-claims', 'I study the captain'),
    claims: [
      { entityId: ILSE, kind: 'description', value: 'scar across the left cheek', visibility: 'public' },
      { entityId: ILSE, kind: 'secret', key: 'loyalty', value: 'serves the pirates', visibility: 'gm' },
    ],
  });
  playUntil(fixture, 6, RETURN_TURN);
  const ledgerOf = (committed: CommittedTurn) =>
    packetAt(fixture, committed)
      .sections.find(({ name }) => name === 'ledger')
      ?.items.join('\n') ?? '';
  assert.ok(!ledgerOf(play(fixture.store, 'quiet-turn')).includes('scar'));
  const named = ledgerOf(play(fixture.store, 'named-turn', 'I search for Captain Ilse'));
  assert.ok(named.includes('scar across the left cheek'));
  assert.ok(!named.includes('serves the pirates'));
  fixture.connection.close();
});

const D20_FANTASY = () => ({ ...planCampaign('A fantasy story using the d20-lite rules') });

const chooseStrictness = (store: CampaignStore, rulesStrictness: string, actionId: string) =>
  saveGmSettings(store, {
    campaignId: CAMPAIGN.id,
    actionId,
    expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
    settings: { rulesStrictness },
  });

it('rpg-42a.58 carries the pack and genre style in the stable part and never in the instructions', () => {
  const fixture = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const packet = packetAt(fixture, play(fixture.store, 'turn-1'));
  const style = packet.sections.find(({ name }) => name === 'style');
  assert.equal(style?.stable, true);
  assert.ok(STABLE_SECTIONS.includes('style'));
  const text = style?.items.join('\n') ?? '';
  assert.match(text, /d20-lite/);
  assert.match(text, /raw DCs/);
  assert.match(text, /fantasy/);
  const parts = packetParts(packet);
  assert.ok(parts.stable.includes('raw DCs'));
  assert.equal(parts.variable.includes('raw DCs'), false);
  assert.equal(parts.instructions.includes('raw DCs'), false);
  fixture.connection.close();
});

it('rpg-42a.58 a campaign without a RulePack carries no style and no strictness line', () => {
  const fixture = campaign();
  const packet = packetAt(fixture, play(fixture.store, 'turn-1'));
  assert.deepEqual(packet.sections.find(({ name }) => name === 'style')?.items, []);
  fixture.connection.close();
});

const d20ModifiersLine = (strictness: 'as-written' | 'relaxed') =>
  modifiersPrompt({ vocabulary: D20_LITE_VOCABULARY, strictness });

const d20SheetLine = npcSheetPrompt({
  pack: { id: D20_LITE_MANIFEST.id, edition: D20_LITE_MANIFEST.edition, revision: D20_LITE_MANIFEST.revision },
  defense: D20_LITE_COMBAT.defense,
  hitPoints: D20_LITE_COMBAT.hitPoints,
});

const d20CheckRulesLine = (fixture: ReturnType<typeof campaign>) => {
  const state = fixture.store.load(CAMPAIGN.id);
  assert.ok(state);
  return checkRulesPrompt(checkRulesFor(state.events, 'as-written'));
};

it('rpg-42a.74 lists the check rules the GM may call only while the strictness allows rolls', () => {
  const fixture = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const committed = play(fixture.store, 'turn-1');
  assert.ok(d20CheckRulesLine(fixture).includes('attack.melee'));
  assert.ok(instructionsOf(fixture, committed)?.includes(d20CheckRulesLine(fixture)));
  chooseStrictness(fixture.store, 'off', 'off');
  assert.equal(instructionsOf(fixture, committed)?.includes(d20CheckRulesLine(fixture)), false);
  fixture.connection.close();
});

it('rpg-42a.58 tells the GM the strictness: as-written by default, then the saved choice', () => {
  const fixture = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const committed = play(fixture.store, 'turn-1');
  assert.deepEqual(instructionsOf(fixture, committed), [
    SYSTEM_PROMPT,
    RULES_STRICTNESS_PROMPTS['as-written'],
    d20CheckRulesLine(fixture),
    GM_ROLL_PROMPT,
    d20ModifiersLine('as-written'),
    d20SheetLine,
  ]);
  chooseStrictness(fixture.store, 'relaxed', 'relax');
  assert.deepEqual(instructionsOf(fixture, committed), [
    SYSTEM_PROMPT,
    RULES_STRICTNESS_PROMPTS.relaxed,
    d20CheckRulesLine(fixture),
    GM_ROLL_PROMPT,
    d20ModifiersLine('relaxed'),
    d20SheetLine,
  ]);
  chooseStrictness(fixture.store, 'off', 'off');
  assert.deepEqual(instructionsOf(fixture, committed), [SYSTEM_PROMPT, RULES_STRICTNESS_PROMPTS.off, d20SheetLine]);
  fixture.connection.close();
});

it('rpg-42a.58 a regeneration packet adds the retry line after the strictness line', () => {
  const fixture = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const committed = play(fixture.store, 'turn-1');
  const state = fixture.store.load(CAMPAIGN.id);
  assert.ok(state);
  const retried = contextPacketOf(fixture.database, state, committed, undefined, undefined, undefined, { retry: true });
  assert.deepEqual(retried.sections.find(({ name }) => name === 'instructions')?.items, [
    SYSTEM_PROMPT,
    RULES_STRICTNESS_PROMPTS['as-written'],
    d20CheckRulesLine(fixture),
    GM_ROLL_PROMPT,
    d20ModifiersLine('as-written'),
    d20SheetLine,
    RULES_RETRY_PROMPT,
  ]);
  fixture.connection.close();
});

it('rpg-42a.58 an as-written campaign that rolls no dice gets no as-written line', () => {
  const fixture = campaign(
    CREATED_EVENT.payload,
    planCampaign('A fantasy story using the d20-lite rules', { dice: 'off' }),
  );
  const committed = play(fixture.store, 'turn-1');
  assert.deepEqual(instructionsOf(fixture, committed), [SYSTEM_PROMPT]);
  chooseStrictness(fixture.store, 'relaxed', 'relax');
  assert.deepEqual(instructionsOf(fixture, committed), [SYSTEM_PROMPT, RULES_STRICTNESS_PROMPTS.relaxed]);
  fixture.connection.close();
});

it('rpg-42a.76 the packet frames the closing sentences of recent GM narrations as data', () => {
  const fixture = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const first = play(fixture.store, 'turn-1');
  fixture.store.recordNarration(CAMPAIGN.id, first.turn.id, 'Rain falls. Strike true.');
  const committed = play(fixture.store, 'turn-2');
  const state = fixture.store.load(CAMPAIGN.id);
  assert.ok(state);
  const packet = contextPacketOf(fixture.database, state, committed);
  assert.deepEqual(packet.sections.find(({ name }) => name === 'recentClosings')?.items, [
    'Gulls cry.',
    'Strike true.',
  ]);
  assert.match(packetParts(packet).variable, /<campaign-data>.*"recentClosings":\["Gulls cry\.","Strike true\."\]/);
  const retried = contextPacketOf(fixture.database, state, committed, undefined, undefined, undefined, {
    repeated: ['Strike true.'],
  });
  assert.ok(
    retried.sections
      .find(({ name }) => name === 'instructions')
      ?.items.includes(repetitionRetryPrompt(['Strike true.'])),
  );
  fixture.connection.close();
});

it('rpg-42a.79 the packet lists known npcs with their roles', () => {
  const fixture = campaign();
  const { store, entities, facts } = fixture;
  introduceEntity(store, entities, facts, {
    ...actionFor(store, 'meet-maren', 'I enter the inn'),
    entity: { id: 'maren-oakhollow', kind: 'npc', name: 'Maren Oakhollow', data: {}, ...PUBLIC },
    facts: [{ id: 'maren-role', statement: 'Innkeeper of the Hollow Lantern', layer: 'canon', ...PUBLIC }],
    relationships: [],
  });
  const items = packetAt(fixture, play(store, 'turn-2')).sections.find(({ name }) => name === 'entities')?.items;
  assert.ok(items?.includes('Maren Oakhollow (npc, maren-oakhollow): Innkeeper of the Hollow Lantern'));
  fixture.connection.close();
});

it('rpg-42a.89 a packet carries the engine GM rolls under results and the GM roll instruction only when dice are on', () => {
  const fixture = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const committed = play(fixture.store, 'turn-1');
  const state = fixture.store.load(CAMPAIGN.id);
  assert.ok(state);
  const line = 'GmRolled {"roller":"old-tam","visibility":"secret"}';
  const packet = contextPacketOf(fixture.database, state, committed, undefined, undefined, undefined, {
    gmRolls: [line],
  });
  assert.ok(packet.sections.find(({ name }) => name === 'results')?.items.includes(line));
  assert.ok(packet.sections.find(({ name }) => name === 'instructions')?.items.includes(GM_ROLL_PROMPT));
  chooseStrictness(fixture.store, 'off', 'off');
  assert.ok(!instructionsOf(fixture, committed)?.includes(GM_ROLL_PROMPT));
  fixture.connection.close();
});

const TRAIT_INPUT = 'I hail Captain Ilse';

it('rpg-cm63.44 a present npc without voice traits makes the packet ask for them, until they are set', () => {
  const fixture = campaign();
  meetIlse(fixture);
  const asked = instructionsOf(fixture, play(fixture.store, 'greet-ilse', TRAIT_INPUT));
  assert.ok(asked?.includes(voiceTraitsPrompt([ILSE])));
  setVoiceTraits(fixture.store, fixture.entities, {
    ...actionFor(fixture.store, 'ilse-traits'),
    speakerId: ILSE,
    traits: { gender: 'female', age: 'adult', manner: 'calm' },
  });
  const answered = instructionsOf(fixture, play(fixture.store, 'greet-ilse-again', TRAIT_INPUT));
  assert.ok(!answered?.some((line) => line.includes('voice traits')));
  fixture.connection.close();
});

it('rpg-42a.127 the packet explains the npc sheet only when the pack has combat rules', () => {
  const d20 = campaign(CREATED_EVENT.payload, D20_FANTASY());
  const line = d20SheetLine;
  assert.ok(instructionsOf(d20, play(d20.store, 'd20-turn'))?.includes(line));
  for (const needle of [D20_LITE_COMBAT.defense, D20_LITE_COMBAT.hitPoints, D20_LITE_MANIFEST.revision])
    assert.ok(line.includes(needle));
  d20.connection.close();
  const plain = campaign();
  assert.ok(!instructionsOf(plain, play(plain.store, 'plain-turn'))?.some((entry) => entry.includes('sheet')));
  plain.connection.close();
});

it('rpg-cm63.44 no voice-traits request without a present npc and the base prompt explains the traits', () => {
  const fixture = campaign();
  const quiet = instructionsOf(fixture, play(fixture.store, 'quiet'));
  assert.ok(!quiet?.some((line) => line.includes('voice traits')));
  assert.match(SYSTEM_PROMPT, /voiceTraits/);
  fixture.connection.close();
});

it('rpg-42a.73 carries the style of an imported rulebook as data in the stable style section', () => {
  const document: RulesDocument = {
    name: 'house.md',
    format: 'markdown',
    sourceHash: 'a'.repeat(64),
    text: 'Rules text.',
    style: { tone: ['wry'] },
  };
  const fixture = campaign(CREATED_EVENT.payload, undefined, [document]);
  const packet = packetAt(fixture, play(fixture.store, 'turn-1'));
  const items = packet.sections.find(({ name }) => name === 'style')?.items ?? [];
  assert.ok(items.includes('rules-document "house.md" style: {"tone":["wry"]}'));
  fixture.connection.close();
});

it('rpg-42a.73 a large imported style never pushes the table notes out of the style section', () => {
  const long = Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(200, 'x'));
  const document: RulesDocument = {
    name: 'big.md',
    format: 'markdown',
    sourceHash: 'b'.repeat(64),
    text: 'Rules text.',
    style: { tone: long, voice: long, vocabulary: long, pacing: long },
  };
  const fixture = campaign(CREATED_EVENT.payload, undefined, [document]);
  applyOocProposal(fixture.store, {
    campaignId: CAMPAIGN.id,
    actionId: 'note',
    expectedRevision: fixture.store.load(CAMPAIGN.id)?.revision ?? 0,
    proposal: { kind: 'table_note', summary: 'Table note', note: 'NPCs speak modern English' },
  });
  const packet = packetAt(fixture, play(fixture.store, 'turn-1'));
  const items = packet.sections.find(({ name }) => name === 'style')?.items ?? [];
  assert.ok(items.some((item) => item.includes('NPCs speak modern English')));
  fixture.connection.close();
});

it('rpg-42a.73 an imported style with no entries adds no style line', () => {
  const document: RulesDocument = {
    name: 'empty.md',
    format: 'markdown',
    sourceHash: 'c'.repeat(64),
    text: 'Rules text.',
    style: {},
  };
  const fixture = campaign(CREATED_EVENT.payload, undefined, [document]);
  const packet = packetAt(fixture, play(fixture.store, 'turn-1'));
  assert.deepEqual(packet.sections.find(({ name }) => name === 'style')?.items, []);
  fixture.connection.close();
});

const LOOKALIKE_ID = 'ilse-again';
const LOOKALIKE_NAME = 'Ilse Marren';

const rejectedHarbour = (fixture: ReturnType<typeof campaign>, committed: CommittedTurn) => {
  fixture.entities.saveEntity({
    id: ILSE,
    campaignId: CAMPAIGN.id,
    kind: 'npc',
    name: LOOKALIKE_NAME,
    data: {},
    ...PUBLIC,
  });
  return commitProposals(fixture.store, fixture.entities, fixture.facts, committed, [
    { kind: 'entity', id: LOOKALIKE_ID, entityKind: 'npc', name: LOOKALIKE_NAME, visibility: 'public' },
  ] as never);
};

const rejectionItemOf = (fixture: ReturnType<typeof campaign>, committed: CommittedTurn) =>
  (instructionsOf(fixture, committed) ?? []).find((item) => item.includes('rejected'));

it('rpg-42a.138 a rejected entity proposal reaches the next gm context with its reason, then expires', () => {
  const fixture = campaign();
  const first = play(fixture.store, 'turn-1');
  const before = fixture.store.load(CAMPAIGN.id);
  rejectedHarbour(fixture, first);
  const after = fixture.store.load(CAMPAIGN.id);
  assert.equal(after?.revision, before?.revision);
  assert.equal(
    after?.events.some(({ type }) => type === GM_PROPOSALS_REJECTED),
    false,
  );
  const rejected = rejectionItemOf(fixture, play(fixture.store, 'turn-2'));
  assert.ok(rejected?.includes(LOOKALIKE_ID));
  assert.equal(rejectionItemOf(fixture, play(fixture.store, 'turn-3')), undefined);
  fixture.connection.close();
});

it('rpg-42a.138 a system turn between the rejection and the next play turn does not hide it', () => {
  const fixture = campaign();
  const first = play(fixture.store, 'turn-1');
  rejectedHarbour(fixture, first);
  commitSystem(fixture.store, actionFor(fixture.store, 'system-1', 'sheet edit'), []);
  assert.ok(rejectionItemOf(fixture, play(fixture.store, 'turn-2'))?.includes(LOOKALIKE_ID));
  fixture.connection.close();
});
