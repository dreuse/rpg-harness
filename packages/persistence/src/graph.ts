import type { DatabaseSync } from 'node:sqlite';
import { type CampaignId, type EventId, MAIN_BRANCH, type SceneId } from '../../domain/src/campaign.ts';
import type { EntityId, Visibility } from '../../domain/src/entity.ts';

export const CONTAINMENT_DEPTH_LIMIT = 8;

export type GraphQuery = {
  readonly campaignId: CampaignId;
  readonly startIds: readonly string[];
  readonly visibleIds: readonly string[];
  readonly links: readonly (readonly [string, string])[];
  readonly maxHops: number;
};

export type GraphRow = { readonly id: string; readonly hops: number; readonly role: 'link' | 'parent' | 'child' };

export type TouchRow = {
  readonly entityId: EntityId;
  readonly eventId: EventId;
  readonly seq: number;
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
  readonly sceneId: SceneId | null;
};

const CONTAINS = 'contains';
const CONTAINMENT = 'relationship.campaign_id = :campaignId AND relationship.kind = :contains';

const WALK = `
WITH RECURSIVE
  visible(id) AS (SELECT value FROM json_each(:visible)),
  start(id) AS (SELECT value FROM json_each(:start) WHERE value IN (SELECT id FROM visible)),
  edge(a, b) AS (
    SELECT source_id, target_id FROM relationship WHERE campaign_id = :campaignId AND kind <> :contains
    UNION ALL SELECT target_id, source_id FROM relationship WHERE campaign_id = :campaignId AND kind <> :contains
    UNION ALL SELECT value ->> '$[0]', value ->> '$[1]' FROM json_each(:links)
    UNION ALL SELECT value ->> '$[1]', value ->> '$[0]' FROM json_each(:links)
  ),
  walk(id, hops) AS (
    SELECT id, 0 FROM start
    UNION SELECT edge.b, walk.hops + 1 FROM walk JOIN edge ON edge.a = walk.id
      WHERE walk.hops < :maxHops AND edge.b IN (SELECT id FROM visible)
  ),
  up(id, hops) AS (
    SELECT relationship.source_id, 1 FROM start JOIN relationship ON relationship.target_id = start.id
      WHERE ${CONTAINMENT} AND relationship.source_id IN (SELECT id FROM visible)
    UNION SELECT relationship.source_id, up.hops + 1 FROM up JOIN relationship ON relationship.target_id = up.id
      WHERE ${CONTAINMENT} AND relationship.source_id IN (SELECT id FROM visible) AND up.hops < :depth
  )
SELECT id, MIN(hops) AS hops, 'link' AS role FROM walk GROUP BY id
UNION ALL SELECT id, MIN(hops), 'parent' FROM up GROUP BY id
UNION ALL SELECT DISTINCT relationship.target_id, 1, 'child' FROM start JOIN relationship ON relationship.source_id = start.id
  WHERE ${CONTAINMENT} AND relationship.target_id IN (SELECT id FROM visible)
ORDER BY role DESC, hops, id`;

const TOUCHES = `
SELECT DISTINCT tree.atom AS entity_id, event_log.id AS event_id, event_log.seq, event_log.visibility,
  event_log.actor_id, turn.scene_id
FROM event_log
JOIN json_tree(event_log.payload) AS tree
JOIN entity ON entity.id = tree.atom AND entity.campaign_id = event_log.campaign_id
LEFT JOIN turn ON turn.id = event_log.turn_id
WHERE event_log.campaign_id = ? AND IFNULL(event_log.branch_id, '${MAIN_BRANCH}') = '${MAIN_BRANCH}'
ORDER BY event_log.seq, entity_id`;

const nullable = (value: unknown) => (value === null ? null : String(value));

export const walkGraph = (database: DatabaseSync, query: GraphQuery): readonly GraphRow[] =>
  database
    .prepare(WALK)
    .all({
      campaignId: query.campaignId,
      contains: CONTAINS,
      visible: JSON.stringify(query.visibleIds),
      start: JSON.stringify(query.startIds),
      links: JSON.stringify(query.links),
      maxHops: query.maxHops,
      depth: CONTAINMENT_DEPTH_LIMIT,
    })
    .map((row) => ({ id: String(row.id), hops: Number(row.hops), role: String(row.role) as GraphRow['role'] }));

export const touchesOf = (database: DatabaseSync, campaignId: CampaignId): readonly TouchRow[] =>
  database
    .prepare(TOUCHES)
    .all(campaignId)
    .map((row) => ({
      entityId: String(row.entity_id),
      eventId: String(row.event_id),
      seq: Number(row.seq),
      visibility: String(row.visibility) as Visibility,
      actorId: nullable(row.actor_id),
      sceneId: nullable(row.scene_id),
    }));
