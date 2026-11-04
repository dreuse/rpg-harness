import type { CampaignEvent, EventId } from '../../domain/src/campaign.ts';
import type { EntityId } from '../../domain/src/entity.ts';
import { type Fact, type FactId, type Viewer, visibleTo } from '../../memory/src/knowledge.ts';

export type NarrationClaim =
  | { readonly kind: 'effect'; readonly ref: string; readonly eventId: EventId | null }
  | { readonly kind: 'equipment'; readonly ref: string; readonly actorId: EntityId; readonly itemId: EntityId }
  | { readonly kind: 'fact'; readonly ref: string; readonly factId: FactId };

export const VIOLATION_KINDS = ['uncommitted-effect', 'impossible-equipment', 'secret-leak', 'unknown-fact'] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

export type Violation = {
  readonly kind: ViolationKind;
  readonly ref: string | null;
  readonly reason: string;
  readonly sourceId: string | null;
};

export type ConsistencyReport = { readonly ok: boolean; readonly violations: readonly Violation[] };

export type ConsistencyInput = {
  readonly narration: string;
  readonly claims: readonly NarrationClaim[];
  readonly events: readonly CampaignEvent[];
  readonly facts: readonly Fact[];
  readonly equipment: Readonly<Record<EntityId, readonly EntityId[]>>;
  readonly viewer: Viewer;
};

const NO_LENGTH = 0;

const REASONS: Readonly<Record<ViolationKind, string>> = {
  'uncommitted-effect': 'claimed effect has no committed event',
  'impossible-equipment': 'actor does not hold the claimed item',
  'secret-leak': 'narration reveals a fact the viewer may not see',
  'unknown-fact': 'claimed fact is not a known fact',
};

const violation = (kind: ViolationKind, ref: string | null, sourceId: string | null): Violation => ({
  kind,
  ref,
  reason: REASONS[kind],
  sourceId,
});

const checkClaim = (claim: NarrationClaim, input: ConsistencyInput, visible: ReadonlySet<FactId>): Violation[] => {
  switch (claim.kind) {
    case 'effect':
      return input.events.some((event) => event.id === claim.eventId)
        ? []
        : [violation('uncommitted-effect', claim.ref, claim.eventId)];
    case 'equipment':
      return Object.hasOwn(input.equipment, claim.actorId) && input.equipment[claim.actorId]?.includes(claim.itemId)
        ? []
        : [violation('impossible-equipment', claim.ref, claim.itemId)];
    case 'fact':
      if (!input.facts.some((fact) => fact.id === claim.factId)) {
        return [violation('unknown-fact', claim.ref, claim.factId)];
      }
      return visible.has(claim.factId) ? [] : [violation('secret-leak', claim.ref, claim.factId)];
    default:
      return [];
  }
};

const WHITESPACE_RUN = /\s+/g;
const SINGLE_SPACE = ' ';

const normalize = (text: string): string => text.toLowerCase().replace(WHITESPACE_RUN, SINGLE_SPACE).trim();

const restatedSecrets = (input: ConsistencyInput, visible: ReadonlySet<FactId>): Violation[] => {
  const narration = normalize(input.narration);
  return input.facts
    .filter((fact) => {
      const statement = normalize(fact.statement);
      return !visible.has(fact.id) && statement.length > NO_LENGTH && narration.includes(statement);
    })
    .map((fact) => violation('secret-leak', null, fact.id));
};

export const checkConsistency = (input: ConsistencyInput): ConsistencyReport => {
  const visible = new Set(visibleTo(input.facts, input.viewer).map((fact) => fact.id));
  const violations = [
    ...input.claims.flatMap((claim) => checkClaim(claim, input, visible)),
    ...restatedSecrets(input, visible),
  ];
  return { ok: violations.length === 0, violations };
};
