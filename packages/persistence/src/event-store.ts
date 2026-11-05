import type { DatabaseSync } from 'node:sqlite';
import {
  type BranchId,
  type CampaignId,
  type DomainEvent,
  MAIN_BRANCH,
  StaleRevisionError,
} from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';

export type { DomainEvent };

export type EventStore = {
  append(event: DomainEvent, expectedRevision: number): void;
  list(campaignId: CampaignId, branchId: BranchId): readonly DomainEvent[];
};

const BRANCH_HEAD =
  'SELECT revision FROM event_log WHERE campaign_id = :campaignId AND branch_id = :branchId ORDER BY seq DESC LIMIT 1';
const APPEND_AT_HEAD = `INSERT INTO event_log (id, campaign_id, branch_id, turn_id, actor_id, revision, causation_id, type, payload)
  SELECT :id, :campaignId, :branchId, :turnId, :actorId, :revision, :causationId, :type, :payload
  WHERE IFNULL((${BRANCH_HEAD}), :expectedRevision) = :expectedRevision`;
const NO_CHANGES = 0;
const SELECT_EVENTS =
  'SELECT id, campaign_id, branch_id, turn_id, actor_id, revision, causation_id, type, payload FROM event_log WHERE campaign_id = ? AND branch_id = ? ORDER BY seq';

const SELECT_EVENT_VISIBILITY = 'SELECT id, visibility FROM event_log WHERE campaign_id = ?';
const HIDDEN: Visibility = 'gm';

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
  append: ({ id, campaignId, branchId, turnId, actorId, revision, causationId, type, payload }, expectedRevision) => {
    const { changes } = database.prepare(APPEND_AT_HEAD).run({
      id,
      campaignId,
      branchId,
      turnId,
      actorId,
      revision,
      causationId,
      type,
      payload: JSON.stringify(payload),
      expectedRevision,
    });
    if (Number(changes) !== NO_CHANGES) return;
    const head = database.prepare(BRANCH_HEAD).get({ campaignId, branchId });
    throw new StaleRevisionError(expectedRevision, Number(head?.revision));
  },
  list: (campaignId, branchId) => database.prepare(SELECT_EVENTS).all(campaignId, branchId).map(toEvent),
});

export type ScopedEvent = DomainEvent & { readonly visibility: Visibility };

export const listScopedEvents = (database: DatabaseSync, campaignId: CampaignId): readonly ScopedEvent[] => {
  const rows = database.prepare(SELECT_EVENT_VISIBILITY).all(campaignId);
  const visibility = new Map(rows.map((row) => [String(row.id), String(row.visibility) as Visibility]));
  return createEventStore(database)
    .list(campaignId, MAIN_BRANCH)
    .map((event) => ({ ...event, visibility: visibility.get(event.id) ?? HIDDEN }));
};
