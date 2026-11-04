import type { CampaignId, EventId } from '../../domain/src/campaign.ts';
import { type EntityId, type FactLayer, VISIBILITY_LEVELS, type Visibility } from '../../domain/src/entity.ts';

export type FactId = string;

export type Fact = {
  readonly id: FactId;
  readonly campaignId: CampaignId;
  readonly subjectId: EntityId | null;
  readonly statement: string;
  readonly layer: FactLayer;
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
  readonly sourceEventId: EventId | null;
};

export type Viewer =
  | { readonly scope: 'gm' }
  | { readonly scope: 'player' }
  | { readonly scope: 'actor'; readonly actorId: EntityId };

export const GM_VIEWER: Viewer = { scope: 'gm' };
export const PLAYER_VIEWER: Viewer = { scope: 'player' };

const CANON: FactLayer = 'canon';
const BELIEF_LAYERS: readonly FactLayer[] = ['belief', 'rumor'];
const GM: Visibility = 'gm';
const PUBLIC: Visibility = 'public';
const ACTOR_SCOPED: Visibility = 'actor-scoped';
const PLAYER_READABLE: readonly Visibility[] = [PUBLIC, 'player'];
const NO_LENGTH = 0;

const isActorId = (actorId: unknown): actorId is EntityId => typeof actorId === 'string' && actorId.length > NO_LENGTH;

const readable = (fact: Fact, viewer: Viewer): boolean => {
  switch (viewer.scope) {
    case 'gm':
      return VISIBILITY_LEVELS.includes(fact.visibility);
    case 'player':
      return PLAYER_READABLE.includes(fact.visibility);
    case 'actor':
      return (
        isActorId(viewer.actorId) &&
        (fact.visibility === PUBLIC || (fact.visibility === ACTOR_SCOPED && fact.actorId === viewer.actorId))
      );
    default:
      return false;
  }
};

export const visibleTo = (facts: readonly Fact[], viewer: Viewer): readonly Fact[] =>
  facts.filter((fact) => readable(fact, viewer));

export const canonicalFacts = (facts: readonly Fact[], viewer: Viewer): readonly Fact[] =>
  visibleTo(facts, viewer).filter((fact) => fact.layer === CANON);

export const beliefsOf = (facts: readonly Fact[], actorId: EntityId, viewer: Viewer): readonly Fact[] =>
  visibleTo(facts, viewer).filter((fact) => BELIEF_LAYERS.includes(fact.layer) && fact.actorId === actorId);

export const gmSecrets = (facts: readonly Fact[], viewer: Viewer): readonly Fact[] =>
  visibleTo(facts, viewer).filter((fact) => fact.visibility === GM);
