import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CampaignId,
  CampaignState,
  CampaignStore,
  CommittedTurn,
  EventId,
  Turn,
} from '../../../packages/domain/src/campaign.ts';
import type { CampaignEntity } from '../../../packages/domain/src/entity.ts';
import { playTurns } from '../../../packages/engine/src/character.ts';
import { contextBudgetOf, recordSummary } from '../../../packages/engine/src/memory.ts';
import { campaignConfigOf, loadState } from '../../../packages/engine/src/turn.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { graphContext, PENDING_HOP_LIMIT, pendingOf } from '../../../packages/memory/src/graph.ts';
import {
  condense,
  type Summary,
  type SummaryLevel,
  summariesOf,
  summarize,
  type WrittenSummary,
} from '../../../packages/memory/src/history.ts';
import { PLAYER_VIEWER, type Viewer, visibleTo } from '../../../packages/memory/src/knowledge.ts';
import {
  buildContextPacket,
  CONTEXT_BUDGETS,
  type ContextPacket,
  RECENT_TURN_LIMIT,
} from '../../../packages/memory/src/packet.ts';
import { createEntityStore, createFactStore } from '../../../packages/persistence/src/entity-store.ts';
import { touchesOf, walkGraph } from '../../../packages/persistence/src/graph.ts';
import { scopedEventsOf, worldOf } from './client-session.ts';
import { SYSTEM_PROMPT } from './gm-api.ts';
import { describeConfig } from './quickstart.ts';
import { panelsOf } from './views.ts';

export const SCENE_TURN_LIMIT = 20;
export const CHAPTER_SCENE_COUNT = 5;
export const FAKE_SUMMARY_LENGTH = 400;

export type Summarizer = (level: SummaryLevel, texts: readonly string[]) => Promise<string>;

const REWRITTEN_LEVEL: SummaryLevel = 'campaign';
const PLAYER_SUMMARY = { visibility: 'player', actorId: null } as const;
const TEXT_SEPARATOR = ' ';
const NONE = 0;

export const fakeSummarizer: Summarizer = async (_level, texts) =>
  texts.join(TEXT_SEPARATOR).slice(NONE, FAKE_SUMMARY_LENGTH);

const turnText = ({ input, narration }: Turn) =>
  narration === '' ? `Player: ${input}` : `Player: ${input} GM: ${narration}`;

const pendingText = ({ kind, text }: { readonly kind: string; readonly text: string }) => `${kind}: ${text}`;

const entityLine = ({ name, kind }: CampaignEntity) => `${name} (${kind})`;

const configOf = (state: CampaignState) => {
  const parsed = parseCampaignConfig(campaignConfigOf(state.events));
  return parsed.ok ? parsed.config : undefined;
};

const visibleSummaries = (summaries: readonly WrittenSummary[], viewer: Viewer, level: SummaryLevel) =>
  summaries
    .filter((written) => written.level === level && visibleTo([written.summary], viewer).length > NONE)
    .map(({ summary }) => summary.text);

const named = (entities: readonly CampaignEntity[], input: string) => {
  const lower = input.toLowerCase();
  return entities.filter(({ name }) => lower.includes(name.toLowerCase())).map(({ id }) => id);
};

export const contextPacketOf = (
  database: DatabaseSync,
  state: CampaignState,
  committed: CommittedTurn,
  viewer: Viewer = PLAYER_VIEWER,
): ContextPacket => {
  const campaignId = state.campaign.id;
  const scoped = scopedEventsOf(database)(campaignId);
  const visibleEvents = new Set(visibleTo(scoped, viewer).map(({ id }) => id));
  const entityStore = createEntityStore(database);
  const entities = visibleTo(entityStore.listEntities(campaignId), viewer);
  const pending = visibleTo(pendingOf(scoped), viewer);
  const turns = playTurns(state).filter(({ id }) => id !== committed.turn.id);
  const recentTurnIds = new Set([...turns.slice(-RECENT_TURN_LIMIT), committed.turn].map(({ id }) => id));
  const turnOf = new Map(state.events.map(({ id, turnId }) => [id, turnId]));
  const touches = touchesOf(database, campaignId);
  const startIds = [
    ...state.characters.map(({ id }) => id),
    ...visibleTo(touches, viewer)
      .filter(({ eventId }) => recentTurnIds.has(turnOf.get(eventId) ?? ''))
      .map(({ entityId }) => entityId),
    ...named(entities, committed.turn.input),
  ];
  const nodes = walkGraph(database, {
    campaignId,
    startIds,
    visibleIds: [...entities.map(({ id }) => id), ...pending.map(({ id }) => id)],
    links: pending.flatMap(({ id, entityIds }) => entityIds.map((entityId) => [id, entityId] as const)),
    maxHops: PENDING_HOP_LIMIT,
  });
  const pendingIds = new Set(pending.map(({ id }) => id));
  const reached = new Set(nodes.filter(({ hops }) => hops <= PENDING_HOP_LIMIT).map(({ id }) => id));
  const context = graphContext(
    {
      nodes,
      entities,
      relationships: entityStore.listRelationships(campaignId),
      facts: createFactStore(database).listFacts(campaignId),
      pending,
      touches,
    },
    viewer,
  ).filter(({ id }) => !pendingIds.has(id));
  const present = new Set(nodes.filter(({ hops, role }) => role === 'link' && hops === NONE).map(({ id }) => id));
  const summaries = summariesOf(scoped);
  const config = configOf(state);
  const world = worldOf(database)(campaignId, state.characters[0]?.id);
  const { inventory, quests } = panelsOf({ state, eventScopes: scoped, ...world }, viewer);
  return buildContextPacket(
    {
      instructions: [SYSTEM_PROMPT],
      ruleset: config === undefined ? [] : [describeConfig(config)],
      setting: [state.currentScene?.title ?? state.campaign.name],
      campaignSummary: visibleSummaries(summaries, viewer, 'campaign'),
      chapterSummaries: visibleSummaries(summaries, viewer, 'chapter'),
      sceneSummaries: visibleSummaries(summaries, viewer, 'scene'),
      context: context.map(({ text }) => text),
      threads: [
        ...quests.map(({ title, status }) => `quest: ${title} (${status})`),
        ...pending.filter(({ id }) => reached.has(id)).map(pendingText),
      ],
      entities: [
        ...entities.filter(({ id }) => present.has(id)).map(entityLine),
        ...inventory.map(({ name }) => `carried: ${name}`),
      ],
      recentTurns: turns.map(turnText),
      results: committed.events
        .filter(({ id }) => visibleEvents.has(id))
        .map(({ type, payload }) => `${type} ${JSON.stringify(payload)}`),
      playerInput: [committed.turn.input],
    },
    CONTEXT_BUDGETS[contextBudgetOf(scoped)],
  );
};

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.floor(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export const summarizeCampaign = async (
  database: DatabaseSync,
  store: CampaignStore,
  campaignId: CampaignId,
  summarizer: Summarizer,
): Promise<void> => {
  const write = (level: SummaryLevel, scopeId: string, summary: Summary) => {
    const stored = summariesOf(scopedEventsOf(database)(campaignId)).filter((written) => written.level === level);
    const cited = new Set(stored.flatMap(({ summary: { sourceEventIds } }) => sourceEventIds));
    if (level !== REWRITTEN_LEVEL && summary.sourceEventIds.some((id) => cited.has(id))) return undefined;
    return recordSummary(store, {
      campaignId,
      actionId: randomUUID(),
      expectedRevision: loadState(store, campaignId).revision,
      level,
      scopeId,
      summary,
    });
  };
  const state = loadState(store, campaignId);
  const written = summariesOf(scopedEventsOf(database)(campaignId));
  const ofLevel = (level: SummaryLevel) =>
    written.filter((summary) => summary.level === level).map(({ summary }) => summary);
  const covered = new Set<EventId>(ofLevel('scene').flatMap(({ sourceEventIds }) => sourceEventIds));
  const eventsOf = (turn: Turn) => state.events.filter(({ turnId }) => turnId === turn.id).map(({ id }) => id);
  const open = playTurns(state).filter((turn) => !eventsOf(turn).some((id) => covered.has(id)));
  const scenes = [...ofLevel('scene')];
  for (const segment of chunks(open, SCENE_TURN_LIMIT)) {
    const text = await summarizer('scene', segment.map(turnText));
    const draft = { id: randomUUID(), campaignId, text, sourceEventIds: segment.flatMap(eventsOf), ...PLAYER_SUMMARY };
    const scene = write('scene', segment[0]?.sceneId ?? campaignId, summarize(state.events, draft));
    if (scene === undefined) return;
    scenes.push(scene);
  }
  const chapters = [...ofLevel('chapter')];
  const uncondensed = scenes.slice(chapters.length * CHAPTER_SCENE_COUNT);
  const before = chapters.length;
  for (const parts of chunks(uncondensed, CHAPTER_SCENE_COUNT)) {
    const text = await summarizer(
      'chapter',
      parts.map(({ text: part }) => part),
    );
    const chapter = write('chapter', randomUUID(), condense(state.events, { id: randomUUID(), text }, parts));
    if (chapter === undefined) return;
    chapters.push(chapter);
  }
  if (chapters.length === before) return;
  const text = await summarizer(
    'campaign',
    chapters.map(({ text: part }) => part),
  );
  write('campaign', campaignId, condense(state.events, { id: randomUUID(), text }, chapters));
};
