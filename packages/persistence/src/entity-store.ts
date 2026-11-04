import type { DatabaseSync } from 'node:sqlite';
import { CampaignBoundaryError, type CampaignId } from '../../domain/src/campaign.ts';
import {
  type CampaignEntity,
  DanglingReferenceError,
  type EntityId,
  type EntityKind,
  type EntityStore,
  type Relationship,
  type Visibility,
} from '../../domain/src/entity.ts';

const UPSERT_ENTITY =
  'INSERT INTO entity (id, campaign_id, kind, name, data, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, data = excluded.data, visibility = excluded.visibility, actor_id = excluded.actor_id WHERE entity.campaign_id = excluded.campaign_id';
const UPSERT_RELATIONSHIP =
  'INSERT INTO relationship (id, campaign_id, kind, source_id, target_id, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, source_id = excluded.source_id, target_id = excluded.target_id, data = excluded.data WHERE relationship.campaign_id = excluded.campaign_id';
const SELECT_ENTITY_OWNER = 'SELECT campaign_id FROM entity WHERE id = ?';
const ENTITY_COLUMNS = 'SELECT id, campaign_id, kind, name, data, visibility, actor_id FROM entity';
const SELECT_ENTITY = `${ENTITY_COLUMNS} WHERE campaign_id = ? AND id = ?`;
const SELECT_ENTITIES = `${ENTITY_COLUMNS} WHERE campaign_id = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY rowid`;
const SELECT_RELATIONSHIPS =
  'SELECT id, campaign_id, kind, source_id, target_id, data FROM relationship WHERE campaign_id = ?1 AND (?2 IS NULL OR source_id = ?2 OR target_id = ?2) ORDER BY rowid';

const NO_CHANGES = 0;

type Row = Record<string, unknown>;

const toEntity = (row: Row): CampaignEntity => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  kind: String(row.kind) as EntityKind,
  name: String(row.name),
  data: JSON.parse(String(row.data)),
  visibility: String(row.visibility) as Visibility,
  actorId: row.actor_id === null ? null : String(row.actor_id),
});

const toRelationship = (row: Row): Relationship => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  kind: String(row.kind),
  sourceId: String(row.source_id),
  targetId: String(row.target_id),
  data: JSON.parse(String(row.data)),
});

const requireEntity = (database: DatabaseSync, campaignId: CampaignId, id: EntityId) => {
  const reference = `entity ${id}`;
  const owner = database.prepare(SELECT_ENTITY_OWNER).get(id);
  if (owner === undefined) throw new DanglingReferenceError(reference);
  if (owner.campaign_id !== campaignId) throw new CampaignBoundaryError(campaignId, reference);
};

const requireUpserted = (campaignId: CampaignId, reference: string, changes: number | bigint) => {
  if (Number(changes) === NO_CHANGES) throw new CampaignBoundaryError(campaignId, reference);
};

export const createEntityStore = (database: DatabaseSync): EntityStore => ({
  saveEntity: ({ id, campaignId, kind, name, data, visibility, actorId }) => {
    if (actorId !== null) requireEntity(database, campaignId, actorId);
    const { changes } = database
      .prepare(UPSERT_ENTITY)
      .run(id, campaignId, kind, name, JSON.stringify(data), visibility, actorId);
    requireUpserted(campaignId, `entity ${id}`, changes);
  },
  getEntity: (campaignId, id) => {
    const row = database.prepare(SELECT_ENTITY).get(campaignId, id);
    return row === undefined ? undefined : toEntity(row);
  },
  listEntities: (campaignId, kind) =>
    database
      .prepare(SELECT_ENTITIES)
      .all(campaignId, kind ?? null)
      .map(toEntity),
  saveRelationship: ({ id, campaignId, kind, sourceId, targetId, data }) => {
    requireEntity(database, campaignId, sourceId);
    requireEntity(database, campaignId, targetId);
    const { changes } = database
      .prepare(UPSERT_RELATIONSHIP)
      .run(id, campaignId, kind, sourceId, targetId, JSON.stringify(data));
    requireUpserted(campaignId, `relationship ${id}`, changes);
  },
  listRelationships: (campaignId, entityId) =>
    database
      .prepare(SELECT_RELATIONSHIPS)
      .all(campaignId, entityId ?? null)
      .map(toRelationship),
});
