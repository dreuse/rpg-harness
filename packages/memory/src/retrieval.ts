import type { CampaignEvent, CampaignId, EventId, Scene } from '../../domain/src/campaign.ts';
import type { CampaignEntity, EntityId, Relationship, Visibility } from '../../domain/src/entity.ts';
import { type Fact, type FactId, type Viewer, visibleTo } from './knowledge.ts';

export type ThreadId = string;

export type Thread = {
  readonly id: ThreadId;
  readonly campaignId: CampaignId;
  readonly title: string;
  readonly status: 'active' | 'resolved';
  readonly entityIds: readonly EntityId[];
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
  readonly sourceEventId: EventId | null;
};

export type ContextSnapshot = {
  readonly scene: Scene;
  readonly sceneEntityIds: readonly EntityId[];
  readonly pinnedFactIds: readonly FactId[];
  readonly entities: readonly CampaignEntity[];
  readonly relationships: readonly Relationship[];
  readonly threads: readonly Thread[];
  readonly facts: readonly Fact[];
  readonly events: readonly CampaignEvent[];
};

export type ContextKind = 'scene' | 'entity' | 'thread' | 'fact' | 'history';

export type ContextItem = {
  readonly id: string;
  readonly text: string;
  readonly tokens: number;
  readonly required: boolean;
  readonly sourceEventIds: readonly EventId[];
};

export type RetrievedContext = {
  readonly scene: ContextItem;
  readonly entities: readonly ContextItem[];
  readonly threads: readonly ContextItem[];
  readonly facts: readonly ContextItem[];
  readonly history: readonly ContextItem[];
  readonly budget: number;
  readonly usedTokens: number;
  readonly requiredExceedsBudget: boolean;
  readonly truncated: readonly { readonly kind: ContextKind; readonly id: string }[];
};

const CHARS_PER_TOKEN = 4;
const ACTIVE = 'active';
const CANON = 'canon';
const INVALIDATED = 'invalidated';
const GM_SCOPE = 'gm';
const NO_TOKENS = 0;
const PROVENANCE_LIMIT = 8;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const references = (event: CampaignEvent, id: string): boolean =>
  Object.values(event.payload).some((value) => value === id || (Array.isArray(value) && value.includes(id)));

type Candidate = { readonly kind: ContextKind; readonly item: ContextItem };

export const retrieveContext = (snapshot: ContextSnapshot, viewer: Viewer, budget: number): RetrievedContext => {
  if (!Number.isInteger(budget) || budget < NO_TOKENS) throw new RangeError(`invalid token budget ${budget}`);
  const isGm = viewer.scope === GM_SCOPE;
  const provenance = (id: string, sourceEventId: EventId | null = null): readonly EventId[] => [
    ...(sourceEventId === null ? [] : [sourceEventId]),
    ...(isGm
      ? snapshot.events
          .filter((event) => event.id !== sourceEventId && references(event, id))
          .map((event) => event.id)
          .slice(-PROVENANCE_LIMIT)
      : []),
  ];
  const candidate = (
    kind: ContextKind,
    id: string,
    text: string,
    required: boolean,
    sourceEventIds: readonly EventId[],
  ): Candidate => ({ kind, item: { id, text, tokens: estimateTokens(text), required, sourceEventIds } });

  const threads = visibleTo(snapshot.threads, viewer).filter((thread) => thread.status === ACTIVE);
  const visibleEntities = visibleTo(snapshot.entities, viewer);
  const visibleIds = new Set(visibleEntities.map((entity) => entity.id));
  const sceneIds = snapshot.sceneEntityIds.filter((id) => visibleIds.has(id));
  const related = snapshot.relationships
    .filter((relationship) => visibleIds.has(relationship.sourceId) && visibleIds.has(relationship.targetId))
    .flatMap((relationship) =>
      sceneIds.includes(relationship.sourceId)
        ? [relationship.targetId]
        : sceneIds.includes(relationship.targetId)
          ? [relationship.sourceId]
          : [],
    );
  const focus = new Set([
    snapshot.scene.id,
    ...sceneIds,
    ...related,
    ...threads.flatMap((thread) => thread.entityIds).filter((id) => visibleIds.has(id)),
  ]);
  const entities = visibleEntities.filter((entity) => focus.has(entity.id));
  const facts = visibleTo(snapshot.facts, viewer).filter((fact) => fact.layer !== INVALIDATED);
  const isRequiredFact = (fact: Fact) =>
    snapshot.pinnedFactIds.includes(fact.id) ||
    (fact.layer === CANON && fact.subjectId !== null && focus.has(fact.subjectId));
  const optionalFacts = facts.filter(
    (fact) => !isRequiredFact(fact) && fact.subjectId !== null && focus.has(fact.subjectId),
  );
  const history = isGm
    ? snapshot.events.filter((event) => [...focus].some((id) => references(event, id))).reverse()
    : [];

  const scene = candidate('scene', snapshot.scene.id, snapshot.scene.title, true, provenance(snapshot.scene.id));
  const required = [
    scene,
    ...threads.map((thread) =>
      candidate('thread', thread.id, thread.title, true, provenance(thread.id, thread.sourceEventId)),
    ),
    ...facts
      .filter(isRequiredFact)
      .map((fact) => candidate('fact', fact.id, fact.statement, true, provenance(fact.id, fact.sourceEventId))),
  ];
  const optional = [
    ...entities.map((entity) =>
      candidate('entity', entity.id, `${entity.name} ${JSON.stringify(entity.data)}`, false, provenance(entity.id)),
    ),
    ...optionalFacts.map((fact) =>
      candidate('fact', fact.id, fact.statement, false, provenance(fact.id, fact.sourceEventId)),
    ),
    ...history.map((event) =>
      candidate('history', event.id, `${event.type} ${JSON.stringify(event.payload)}`, false, [event.id]),
    ),
  ];

  const requiredTokens = required.reduce((sum, { item }) => sum + item.tokens, NO_TOKENS);
  let usedTokens = requiredTokens;
  const included: Candidate[] = [...required];
  const truncated: { kind: ContextKind; id: string }[] = [];
  for (const entry of optional) {
    if (usedTokens + entry.item.tokens <= budget) {
      included.push(entry);
      usedTokens += entry.item.tokens;
    } else {
      truncated.push({ kind: entry.kind, id: entry.item.id });
    }
  }
  const ofKind = (kind: ContextKind) => included.filter((entry) => entry.kind === kind).map(({ item }) => item);

  return {
    scene: scene.item,
    entities: ofKind('entity'),
    threads: ofKind('thread'),
    facts: ofKind('fact'),
    history: ofKind('history'),
    budget,
    usedTokens,
    requiredExceedsBudget: requiredTokens > budget,
    truncated,
  };
};
