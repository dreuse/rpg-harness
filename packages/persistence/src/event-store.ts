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

type Row = Record<string, unknown>;

const nullableString = (value: unknown) => (value === null ? null : String(value));

export const toEvent = (row: Row): DomainEvent => ({
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

export type ScopedEvent = DomainEvent & { readonly seq: number; readonly visibility: Visibility };

export type EventQuery = {
  readonly afterSeq?: number;
  readonly beforeSeq?: number;
  readonly afterRevision?: number;
  readonly type?: string;
  readonly ids?: readonly string[];
  readonly tail?: number;
};

const SCOPED_COLUMNS =
  'seq, visibility, id, campaign_id, branch_id, turn_id, actor_id, revision, causation_id, type, payload';

type Filter = readonly [name: string, condition: string, value: string | number | undefined];

const filtersOf = ({ afterSeq, beforeSeq, afterRevision, type, ids }: EventQuery): Filter[] =>
  (
    [
      ['afterSeq', 'seq > :afterSeq', afterSeq],
      ['beforeSeq', 'seq < :beforeSeq', beforeSeq],
      ['afterRevision', 'revision > :afterRevision', afterRevision],
      ['type', 'type = :type', type],
      ['ids', 'id IN (SELECT value FROM json_each(:ids))', ids === undefined ? undefined : JSON.stringify(ids)],
    ] as Filter[]
  ).filter(([, , value]) => value !== undefined);

export const listScopedEvents = (
  database: DatabaseSync,
  campaignId: CampaignId,
  query: EventQuery = {},
): readonly ScopedEvent[] => {
  const filters = filtersOf(query);
  const onBranch = query.ids === undefined;
  const params = {
    campaignId,
    ...(onBranch ? { branchId: MAIN_BRANCH } : {}),
    ...Object.fromEntries(filters.map(([name, , value]) => [name, value])),
  };
  const byRevision = query.type !== undefined || query.afterRevision !== undefined;
  const campaign = byRevision ? 'campaign_id = :campaignId' : '+campaign_id = :campaignId';
  const branch = onBranch ? ['branch_id = :branchId'] : [];
  const conditions = [campaign, ...branch, ...filters.map(([, condition]) => condition)];
  const order = query.tail === undefined ? 'ORDER BY seq' : `ORDER BY seq DESC LIMIT ${Number(query.tail)}`;
  const sql = `SELECT ${SCOPED_COLUMNS} FROM event_log WHERE ${conditions.join(' AND ')} ${order}`;
  const events = database
    .prepare(sql)
    .all(params as Record<string, string | number>)
    .map((row) => ({ ...toEvent(row), seq: Number(row.seq), visibility: String(row.visibility) as Visibility }));
  return query.tail === undefined ? events : events.reverse();
};
