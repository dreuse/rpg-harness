import { type CampaignStore, type CommittedTurn, StaleRevisionError } from '../../../packages/domain/src/campaign.ts';
import {
  ENTITY_KINDS,
  type EntityId,
  type EntityKind,
  type EntityStore,
  type FactStore,
} from '../../../packages/domain/src/entity.ts';
import { introduceEntity, openPending } from '../../../packages/engine/src/memory.ts';
import {
  ActionIdConflictError,
  InvalidActionError,
  loadState,
  type PlayerAction,
} from '../../../packages/engine/src/turn.ts';
import { PENDING_KINDS, type PendingKind } from '../../../packages/memory/src/graph.ts';
import { isRecord } from '../../../packages/rules/src/rulepack.ts';

export const MAX_PROPOSALS = 8;
export const MAX_ID_LENGTH = 64;
export const MAX_NAME_LENGTH = 80;
export const MAX_FACT_LENGTH = 300;
export const MAX_FACTS = 5;
export const MAX_PENDING_TEXT_LENGTH = 300;
export const MAX_PENDING_ENTITIES = 5;
export const PROPOSAL_ENTITY_KINDS = ENTITY_KINDS.filter((kind) => kind !== 'character');
export const PROPOSAL_VISIBILITIES = ['player', 'gm'] as const;
export const ENTITY_PROPOSAL = 'entity';
export const PENDING_PROPOSAL = 'pending';

const ID_PATTERN = '^[a-z0-9][a-z0-9-]*$';
const ID_REGEX = new RegExp(ID_PATTERN);
const DEFAULT_VISIBILITY = 'player';
const FACT_LAYER = 'canon';
const PROPOSAL_KEYS = {
  [ENTITY_PROPOSAL]: ['kind', 'id', 'entityKind', 'name', 'facts', 'visibility'],
  [PENDING_PROPOSAL]: ['kind', 'id', 'pendingKind', 'text', 'entityIds', 'visibility'],
} as const;

type ProposalVisibility = (typeof PROPOSAL_VISIBILITIES)[number];

export type EntityProposal = {
  readonly kind: typeof ENTITY_PROPOSAL;
  readonly id: EntityId;
  readonly entityKind: EntityKind;
  readonly name: string;
  readonly facts?: readonly string[];
  readonly visibility: ProposalVisibility;
};

export type PendingProposal = {
  readonly kind: typeof PENDING_PROPOSAL;
  readonly id: string;
  readonly pendingKind: PendingKind;
  readonly text: string;
  readonly entityIds: readonly EntityId[];
  readonly visibility: ProposalVisibility;
};

export type GmProposal = EntityProposal | PendingProposal;

const idSchema = { type: 'string', maxLength: MAX_ID_LENGTH, pattern: ID_PATTERN } as const;
const visibilitySchema = { type: 'string', enum: PROPOSAL_VISIBILITIES } as const;

export const PROPOSALS_SCHEMA = {
  type: 'array',
  maxItems: MAX_PROPOSALS,
  items: {
    anyOf: [
      {
        type: 'object',
        properties: {
          kind: { const: ENTITY_PROPOSAL },
          id: idSchema,
          entityKind: { type: 'string', enum: PROPOSAL_ENTITY_KINDS },
          name: { type: 'string', maxLength: MAX_NAME_LENGTH },
          facts: { type: 'array', maxItems: MAX_FACTS, items: { type: 'string', maxLength: MAX_FACT_LENGTH } },
          visibility: visibilitySchema,
        },
        required: ['kind', 'id', 'entityKind', 'name'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          kind: { const: PENDING_PROPOSAL },
          id: idSchema,
          pendingKind: { type: 'string', enum: PENDING_KINDS },
          text: { type: 'string', maxLength: MAX_PENDING_TEXT_LENGTH },
          entityIds: { type: 'array', minItems: 1, maxItems: MAX_PENDING_ENTITIES, items: idSchema },
          visibility: visibilitySchema,
        },
        required: ['kind', 'id', 'pendingKind', 'text', 'entityIds'],
        additionalProperties: false,
      },
    ],
  },
} as const;

const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_REGEX.test(value) ? value : undefined;

const textOf = (value: unknown, max: number): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' || text.length > max ? undefined : text;
};

const visibilityOf = (value: unknown): ProposalVisibility | undefined =>
  value === undefined ? DEFAULT_VISIBILITY : PROPOSAL_VISIBILITIES.find((visibility) => visibility === value);

const listOf = <T>(value: unknown, max: number, item: (entry: unknown) => T | undefined): T[] | undefined => {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const items = value.map(item);
  return items.every((entry) => entry !== undefined) ? (items as T[]) : undefined;
};

const entityOf = (value: Record<string, unknown>): EntityProposal | undefined => {
  const id = idOf(value.id);
  const name = textOf(value.name, MAX_NAME_LENGTH);
  const entityKind = PROPOSAL_ENTITY_KINDS.find((kind) => kind === value.entityKind);
  const visibility = visibilityOf(value.visibility);
  const facts =
    value.facts === undefined ? [] : listOf(value.facts, MAX_FACTS, (fact) => textOf(fact, MAX_FACT_LENGTH));
  if (id === undefined || name === undefined || entityKind === undefined || visibility === undefined) return undefined;
  if (facts === undefined) return undefined;
  return { kind: ENTITY_PROPOSAL, id, entityKind, name, ...(facts.length === 0 ? {} : { facts }), visibility };
};

const pendingOf = (value: Record<string, unknown>): PendingProposal | undefined => {
  const id = idOf(value.id);
  const text = textOf(value.text, MAX_PENDING_TEXT_LENGTH);
  const pendingKind = PENDING_KINDS.find((kind) => kind === value.pendingKind);
  const visibility = visibilityOf(value.visibility);
  const entityIds = listOf(value.entityIds, MAX_PENDING_ENTITIES, idOf);
  if (id === undefined || text === undefined || pendingKind === undefined || visibility === undefined) return undefined;
  if (entityIds === undefined || entityIds.length === 0) return undefined;
  return { kind: PENDING_PROPOSAL, id, pendingKind, text, entityIds, visibility };
};

const proposalOf = (value: unknown): GmProposal | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind === ENTITY_PROPOSAL || value.kind === PENDING_PROPOSAL ? value.kind : undefined;
  if (kind === undefined || !Object.keys(value).every((key) => PROPOSAL_KEYS[kind].some((known) => known === key)))
    return undefined;
  return kind === ENTITY_PROPOSAL ? entityOf(value) : pendingOf(value);
};

export const proposalsOf = (value: unknown): readonly GmProposal[] | undefined => {
  const listed = isRecord(value) ? value.proposals : undefined;
  const proposals = listOf(listed, MAX_PROPOSALS, proposalOf);
  return proposals === undefined || proposals.length === 0 ? undefined : proposals;
};

const REFUSALS = [InvalidActionError, ActionIdConflictError, StaleRevisionError];

const actionFor = (committed: CommittedTurn, { kind, id }: GmProposal, revision: number): PlayerAction => ({
  campaignId: committed.turn.campaignId,
  actionId: `${committed.turn.actionId}:proposal:${kind}:${id}`,
  expectedRevision: revision,
  sceneId: committed.turn.sceneId,
  actorId: committed.turn.actorId,
  input: `GM proposal ${kind} ${id}`,
  intent: `The GM records ${kind} ${id}.`,
});

export const commitProposals = (
  store: CampaignStore,
  entities: EntityStore,
  facts: FactStore,
  committed: CommittedTurn,
  proposals: readonly GmProposal[],
): readonly CommittedTurn[] => {
  const { campaignId } = committed.turn;
  const results: CommittedTurn[] = [];
  for (const proposal of proposals) {
    const action = actionFor(committed, proposal, loadState(store, campaignId).revision);
    const scope = { visibility: proposal.visibility, actorId: null };
    try {
      if (proposal.kind === ENTITY_PROPOSAL)
        results.push(
          introduceEntity(store, entities, facts, {
            ...action,
            entity: {
              id: proposal.id,
              kind: proposal.entityKind,
              name: proposal.name,
              data: {},
              ...scope,
            },
            facts: (proposal.facts ?? []).map((statement, index) => ({
              id: `${proposal.id}-fact-${index}`,
              statement,
              layer: FACT_LAYER,
              ...scope,
            })),
            relationships: [],
          }),
        );
      else if (proposal.entityIds.every((id) => entities.getEntity(campaignId, id) !== undefined))
        results.push(
          openPending(store, {
            ...action,
            pending: {
              pendingId: proposal.id,
              kind: proposal.pendingKind,
              text: proposal.text,
              entityIds: proposal.entityIds,
              ...scope,
            },
          }),
        );
    } catch (error) {
      if (!REFUSALS.some((refusal) => error instanceof refusal)) throw error;
    }
  }
  return results;
};
