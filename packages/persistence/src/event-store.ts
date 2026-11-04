import type { DatabaseSync } from 'node:sqlite';
import type { BranchId, CampaignEvent, CampaignId, TurnId } from '../../domain/src/campaign.ts';
import type { EntityId } from '../../domain/src/entity.ts';

export type DomainEvent = Omit<CampaignEvent, 'turnId'> & {
  readonly branchId: BranchId;
  readonly turnId: TurnId | null;
  readonly actorId: EntityId | null;
  readonly revision: number;
};

export type EventStore = {
  append(event: DomainEvent): void;
  list(campaignId: CampaignId, branchId: BranchId): readonly DomainEvent[];
};

const APPEND_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, turn_id, actor_id, revision, causation_id, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SELECT_EVENTS =
  'SELECT id, campaign_id, branch_id, turn_id, actor_id, revision, causation_id, type, payload FROM event_log WHERE campaign_id = ? AND branch_id = ? ORDER BY seq';

type Row = Record<string, unknown>;

const nullableString = (value: unknown) => (value === null ? null : String(value));

const toEvent = (row: Row): DomainEvent => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  branchId: String(row.branch_id),
  turnId: nullableString(row.turn_id),
  actorId: nullableString(row.actor_id),
  revision: Number(row.revision),
  causationId: nullableString(row.causation_id),
  type: String(row.type),
  payload: JSON.parse(String(row.payload)),
});

export const createEventStore = (database: DatabaseSync): EventStore => ({
  append: ({ id, campaignId, branchId, turnId, actorId, revision, causationId, type, payload }) => {
    database
      .prepare(APPEND_EVENT)
      .run(id, campaignId, branchId, turnId, actorId, revision, causationId, type, JSON.stringify(payload));
  },
  list: (campaignId, branchId) => database.prepare(SELECT_EVENTS).all(campaignId, branchId).map(toEvent),
});
