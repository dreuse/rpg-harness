import type { EventId } from '../../domain/src/campaign.ts';
import type { EntityId, FactLayer } from '../../domain/src/entity.ts';
import { type Fact, type FactId, type Viewer, visibleTo } from '../../memory/src/knowledge.ts';

export const INFORMATION_CHANNELS = ['witnessed', 'told', 'rumor'] as const;
export type InformationChannel = (typeof INFORMATION_CHANNELS)[number];

export const STANCES = ['hostile', 'wary', 'neutral', 'friendly', 'loyal'] as const;
export type Stance = (typeof STANCES)[number];

export type Learning = {
  readonly channel: InformationChannel;
  readonly sourceId: EntityId | null;
  readonly eventId: EventId | null;
};

export type LearnedFact = Learning & { readonly factId: FactId };

export type NpcState = {
  readonly id: EntityId;
  readonly goals: readonly string[];
  readonly disposition: string;
  readonly relationships: Readonly<Record<EntityId, Stance>>;
  readonly learned: readonly LearnedFact[];
};

export type KnownFact = {
  readonly factId: FactId;
  readonly statement: string;
  readonly channel: InformationChannel;
  readonly sourceId: EntityId | null;
  readonly reliable: boolean;
  readonly sourceEventIds: readonly EventId[];
};

export type DialogueContext = {
  readonly npcId: EntityId;
  readonly speakerId: EntityId;
  readonly goals: readonly string[];
  readonly disposition: string;
  readonly stance: Stance;
  readonly knownFacts: readonly KnownFact[];
};

const NEUTRAL: Stance = 'neutral';
const UNRELIABLE_CHANNEL: InformationChannel = 'rumor';
const UNRELIABLE_LAYER: FactLayer = 'rumor';
const INVALIDATED: FactLayer = 'invalidated';

const viewerOf = (npc: NpcState): Viewer => ({ scope: 'actor', actorId: npc.id });

const isEventId = (eventId: EventId | null): eventId is EventId => eventId !== null;

export const stanceToward = (npc: NpcState, otherId: EntityId): Stance => {
  const stance = Object.hasOwn(npc.relationships, otherId) ? npc.relationships[otherId] : undefined;
  return stance !== undefined && STANCES.includes(stance) ? stance : NEUTRAL;
};

export const learnFact = (npc: NpcState, fact: Fact, learning: Learning): NpcState =>
  !visibleTo([fact], viewerOf(npc)).includes(fact) || npc.learned.some(({ factId }) => factId === fact.id)
    ? npc
    : { ...npc, learned: [...npc.learned, { factId: fact.id, ...learning }] };

export const knownFacts = (npc: NpcState, facts: readonly Fact[]): readonly KnownFact[] => {
  const visible = visibleTo(facts, viewerOf(npc)).filter(({ layer }) => layer !== INVALIDATED);
  return npc.learned.flatMap(({ factId, channel, sourceId, eventId }) => {
    const fact = visible.find(({ id }) => id === factId);
    return fact
      ? [
          {
            factId,
            statement: fact.statement,
            channel,
            sourceId,
            reliable: channel !== UNRELIABLE_CHANNEL && fact.layer !== UNRELIABLE_LAYER,
            sourceEventIds: [eventId].filter(isEventId),
          },
        ]
      : [];
  });
};

export const canActOn = (npc: NpcState, facts: readonly Fact[], factId: FactId): boolean =>
  knownFacts(npc, facts).some((known) => known.factId === factId);

export const dialogueContext = (npc: NpcState, facts: readonly Fact[], speakerId: EntityId): DialogueContext => ({
  npcId: npc.id,
  speakerId,
  goals: npc.goals,
  disposition: npc.disposition,
  stance: stanceToward(npc, speakerId),
  knownFacts: knownFacts(npc, facts),
});
