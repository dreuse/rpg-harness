import type { CampaignEvent, EventId } from '../../domain/src/campaign.ts';
import type { CampaignEntity, EntityId, Relationship } from '../../domain/src/entity.ts';
import { type Fact, GM_VIEWER, type Scoped, type Viewer, visibleTo } from './knowledge.ts';
import { type ContextItem, estimateTokens } from './retrieval.ts';

export const CONTAINS = 'contains';
export const PENDING_OPENED = 'PendingOpened';
export const PENDING_RESOLVED = 'PendingResolved';
export const PENDING_KINDS = ['clock', 'trigger', 'promise', 'thread', 'plan'] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];
export const LINK_HOP_LIMIT = 1;
export const PENDING_HOP_LIMIT = 2;
export const KEY_FACT_LIMIT = 2;
export const RANK_WEIGHTS = { hop: 4, thread: 4, recency: 2, salience: 1 } as const;
export const NPC_STATE_RELATIONSHIP = 'npc-state';

export type Pending = Scoped & {
  readonly id: string;
  readonly kind: PendingKind;
  readonly text: string;
  readonly entityIds: readonly EntityId[];
  readonly sourceEventId: EventId;
};

export type GraphRole = 'link' | 'parent' | 'child';
export type GraphNode = { readonly id: string; readonly hops: number; readonly role: GraphRole };
export type Touch = Scoped & { readonly entityId: EntityId; readonly eventId: EventId; readonly seq: number };

export type GraphInput = {
  readonly nodes: readonly GraphNode[];
  readonly entities: readonly CampaignEntity[];
  readonly relationships: readonly Relationship[];
  readonly facts: readonly Fact[];
  readonly pending: readonly Pending[];
  readonly touches: readonly Touch[];
};

const CANON = 'canon';
const INVALIDATED = 'invalidated';
const SCENE_HOPS = 0;
const NONE = 0;
const SUMMARY_KEY = 'summary';

type PendingPayload = Omit<Pending, 'id' | 'sourceEventId'> & { readonly pendingId: string };

export const pendingOf = (events: readonly Pick<CampaignEvent, 'id' | 'type' | 'payload'>[]): readonly Pending[] => {
  const resolved = new Set(
    events.filter(({ type }) => type === PENDING_RESOLVED).map(({ payload }) => payload.pendingId),
  );
  return events
    .filter(({ type, payload }) => type === PENDING_OPENED && !resolved.has(payload.pendingId))
    .map(({ id, payload }) => {
      const { pendingId, kind, text, entityIds, visibility, actorId } = payload as PendingPayload;
      return { id: pendingId, kind, text, entityIds, visibility, actorId, sourceEventId: id };
    });
};

type Ranked = { readonly item: ContextItem; readonly score: number };

const item = (id: string, text: string, sourceEventIds: readonly (EventId | null)[] = []): ContextItem => ({
  id,
  text,
  tokens: estimateTokens(text),
  required: false,
  sourceEventIds: sourceEventIds.filter((source): source is EventId => source !== null),
});

const GM_SCOPE = GM_VIEWER.scope;

const summaryOf = ({ data }: CampaignEntity) => {
  const summary = data[SUMMARY_KEY];
  return typeof summary === 'string' ? summary : undefined;
};

const outline = (entity: CampaignEntity) => {
  const summary = summaryOf(entity);
  return summary === undefined ? entity.name : `${entity.name}: ${summary}`;
};

const describe = (entity: CampaignEntity, viewer: Viewer) => {
  const { name, kind, data } = entity;
  if (viewer.scope === GM_SCOPE && Object.keys(data).length > NONE) return `${name} (${kind}) ${JSON.stringify(data)}`;
  const summary = summaryOf(entity);
  return summary === undefined ? `${name} (${kind})` : `${name} (${kind}): ${summary}`;
};

export const graphContext = (input: GraphInput, viewer: Viewer): readonly ContextItem[] => {
  const entities = new Map(visibleTo(input.entities, viewer).map((entity) => [entity.id, entity]));
  const pending = new Map(visibleTo(input.pending, viewer).map((open) => [open.id, open]));
  const facts = visibleTo(input.facts, viewer).filter(({ layer }) => layer !== INVALIDATED);
  const touches = visibleTo(input.touches, viewer);
  const maxSeq = Math.max(NONE, ...touches.map(({ seq }) => seq));
  const lastSeq = new Map<string, number>();
  const mentions = new Map<string, number>();
  for (const { entityId, seq } of touches) {
    lastSeq.set(entityId, Math.max(lastSeq.get(entityId) ?? NONE, seq));
    mentions.set(entityId, (mentions.get(entityId) ?? NONE) + 1);
  }
  const maxMentions = Math.max(NONE, ...mentions.values());
  const threaded = new Set([...pending.values()].flatMap(({ entityIds }) => entityIds));
  const ratio = (value: number | undefined, max: number) => (max === NONE ? NONE : (value ?? NONE) / max);
  const score = (id: string, hops: number) =>
    -hops * RANK_WEIGHTS.hop +
    RANK_WEIGHTS.recency * ratio(lastSeq.get(id), maxSeq) +
    RANK_WEIGHTS.salience * ratio(mentions.get(id), maxMentions) +
    (threaded.has(id) ? RANK_WEIGHTS.thread : NONE);

  const factsAbout = (id: string | null) => facts.filter(({ subjectId }) => subjectId === id);
  const factItem = ({ id, statement, sourceEventId }: Fact) => item(id, statement, [sourceEventId]);
  const edgesOf = (id: EntityId) =>
    input.relationships.flatMap((edge) => {
      const source = entities.get(edge.sourceId);
      const target = entities.get(edge.targetId);
      if (source === undefined || target === undefined || (edge.sourceId !== id && edge.targetId !== id)) return [];
      if (edge.kind === NPC_STATE_RELATIONSHIP) return [];
      return [item(edge.id, `${source.name} ${edge.kind} ${target.name}`)];
    });

  const ranked: Ranked[] = factsAbout(null).map((fact) => ({ item: factItem(fact), score: score('', SCENE_HOPS) }));
  for (const { id, hops, role } of input.nodes) {
    const open = pending.get(id);
    if (open !== undefined && hops <= PENDING_HOP_LIMIT) {
      const entry = item(id, `${open.kind}: ${open.text}`, [open.sourceEventId]);
      ranked.push({ item: entry, score: -hops * RANK_WEIGHTS.hop + RANK_WEIGHTS.thread });
    }
    const entity = entities.get(id);
    if (entity === undefined) continue;
    const rank = score(id, hops);
    const add = (entries: readonly ContextItem[]) =>
      ranked.push(...entries.map((entry) => ({ item: entry, score: rank })));
    if (role !== 'link') add([item(id, outline(entity))]);
    else if (hops === SCENE_HOPS)
      add([item(id, describe(entity, viewer)), ...factsAbout(id).map(factItem), ...edgesOf(id)]);
    else if (hops <= LINK_HOP_LIMIT)
      add([
        item(id, describe(entity, viewer)),
        ...factsAbout(id)
          .filter(({ layer }) => layer === CANON)
          .slice(-KEY_FACT_LIMIT)
          .map(factItem),
      ]);
  }
  const best = new Map<string, ContextItem>();
  for (const { item: entry } of ranked.sort((left, right) => right.score - left.score))
    if (!best.has(entry.id)) best.set(entry.id, entry);
  return [...best.values()];
};
