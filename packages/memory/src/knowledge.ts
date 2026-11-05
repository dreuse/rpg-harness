import {
  type EntityId,
  type Fact,
  type FactId,
  type FactLayer,
  VISIBILITY_LEVELS,
  type Visibility,
} from '../../domain/src/entity.ts';

export type { Fact, FactId };

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

export type Scoped = { readonly visibility: Visibility; readonly actorId: EntityId | null };

const readable = (fact: Scoped, viewer: Viewer): boolean => {
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

export const visibleTo = <T extends Scoped>(facts: readonly T[], viewer: Viewer): readonly T[] =>
  facts.filter((fact) => readable(fact, viewer));

export const canonicalFacts = (facts: readonly Fact[], viewer: Viewer): readonly Fact[] =>
  visibleTo(facts, viewer).filter((fact) => fact.layer === CANON);

export const beliefsOf = (facts: readonly Fact[], actorId: EntityId, viewer: Viewer): readonly Fact[] =>
  visibleTo(facts, viewer).filter((fact) => BELIEF_LAYERS.includes(fact.layer) && fact.actorId === actorId);

export const gmSecrets = (facts: readonly Fact[], viewer: Viewer): readonly Fact[] =>
  visibleTo(facts, viewer).filter((fact) => fact.visibility === GM);
