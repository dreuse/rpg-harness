import type { DatabaseSync } from 'node:sqlite';
import {
  type Campaign,
  CampaignBoundaryError,
  type CampaignChange,
  type CampaignEvent,
  CampaignNotFoundError,
  type CampaignStore,
  type Character,
  type CommittedTurn,
  MAIN_BRANCH,
  type Scene,
  StaleRevisionError,
  type Turn,
  type TurnCommit,
} from '../../domain/src/campaign.ts';

const INSERT_CAMPAIGN = 'INSERT INTO campaign (id, name) VALUES (?, ?)';
const SELECT_CAMPAIGN = 'SELECT id, name, revision FROM campaign WHERE id = ?';
const SELECT_REVISION = 'SELECT revision FROM campaign WHERE id = ?';
const RENAME_CAMPAIGN = 'UPDATE campaign SET name = ?, revision = ? WHERE id = ?';
const ADVANCE_CAMPAIGN = 'UPDATE campaign SET revision = ?, current_scene_id = ? WHERE id = ?';
const UPSERT_CHARACTER =
  'INSERT INTO character (id, campaign_id, name) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name WHERE character.campaign_id = excluded.campaign_id';
const UPSERT_SCENE =
  'INSERT INTO scene (id, campaign_id, title) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title WHERE scene.campaign_id = excluded.campaign_id';
const OWNED_CHARACTER = 'SELECT 1 FROM character WHERE id = ? AND campaign_id = ?';
const OWNED_SCENE = 'SELECT 1 FROM scene WHERE id = ? AND campaign_id = ?';
const OWNED_EVENT = 'SELECT 1 FROM event_log WHERE id = ? AND campaign_id = ?';
const INSERT_TURN =
  'INSERT INTO turn (id, campaign_id, scene_id, action_id, actor_id, input, narration, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
const APPEND_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, revision, action_id, turn_id, causation_id, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SELECT_CHARACTERS = 'SELECT id, campaign_id, name FROM character WHERE campaign_id = ? ORDER BY rowid';
const SELECT_CURRENT_SCENE =
  'SELECT scene.id, scene.campaign_id, scene.title FROM scene JOIN campaign ON campaign.current_scene_id = scene.id WHERE campaign.id = ?';
const TURN_COLUMNS = 'SELECT id, campaign_id, scene_id, action_id, actor_id, input, narration FROM turn';
const SELECT_TURNS = `${TURN_COLUMNS} WHERE campaign_id = ? ORDER BY revision`;
const SELECT_TURN_BY_ACTION = `${TURN_COLUMNS} WHERE campaign_id = ? AND action_id = ?`;
const EVENT_COLUMNS = 'SELECT id, campaign_id, turn_id, causation_id, type, payload FROM event_log';
const ON_MAIN_BRANCH = `IFNULL(branch_id, '${MAIN_BRANCH}') = '${MAIN_BRANCH}'`;
const SELECT_EVENTS = `${EVENT_COLUMNS} WHERE campaign_id = ? AND turn_id IS NOT NULL AND ${ON_MAIN_BRANCH} ORDER BY seq`;
const SELECT_TURN_EVENTS = `${EVENT_COLUMNS} WHERE turn_id = ? AND ${ON_MAIN_BRANCH} ORDER BY seq`;

type Row = Record<string, unknown>;

const toCharacter = (row: Row): Character => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  name: String(row.name),
});

const toScene = (row: Row): Scene => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  title: String(row.title),
});

const toTurn = (row: Row): Turn => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  sceneId: String(row.scene_id),
  actionId: String(row.action_id),
  actorId: String(row.actor_id),
  input: String(row.input),
  narration: String(row.narration),
});

const toEvent = (row: Row): CampaignEvent => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  turnId: String(row.turn_id),
  causationId: row.causation_id === null ? null : String(row.causation_id),
  type: String(row.type),
  payload: JSON.parse(String(row.payload)),
});

const inTransaction = <T>(database: DatabaseSync, run: () => T): T => {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

const NO_CHANGES = 0;
const INITIAL_REVISION = 0;

const requireInCampaign = (campaignId: string, reference: string, inCampaign: boolean) => {
  if (!inCampaign) throw new CampaignBoundaryError(campaignId, reference);
};

const ownedBy = (database: DatabaseSync, sql: string, id: string, campaignId: string) =>
  database.prepare(sql).get(id, campaignId) !== undefined;

const upsertOwned = (database: DatabaseSync, sql: string, values: readonly string[]) =>
  database.prepare(sql).run(...values).changes !== NO_CHANGES;

const nextRevision = (database: DatabaseSync, campaignId: string, expectedRevision: number) => {
  const current = database.prepare(SELECT_REVISION).get(campaignId);
  if (current === undefined) throw new CampaignNotFoundError(campaignId);
  const actual = Number(current.revision);
  if (actual !== expectedRevision) throw new StaleRevisionError(expectedRevision, actual);
  return expectedRevision + 1;
};

const appendCampaignChange = (database: DatabaseSync, campaignId: string, event: CampaignChange, revision: number) => {
  requireInCampaign(campaignId, `event ${event.id}`, event.campaignId === campaignId);
  requireInCampaign(campaignId, `branch ${event.branchId}`, event.branchId === MAIN_BRANCH);
  database
    .prepare(APPEND_EVENT)
    .run(
      event.id,
      campaignId,
      event.branchId,
      revision,
      event.actionId,
      null,
      null,
      event.type,
      JSON.stringify(event.payload),
    );
};

const storedTurn = (database: DatabaseSync, { campaignId, actionId }: Turn): CommittedTurn | undefined => {
  const row = database.prepare(SELECT_TURN_BY_ACTION).get(campaignId, actionId);
  if (row === undefined) return undefined;
  const turn = toTurn(row);
  return { turn, events: database.prepare(SELECT_TURN_EVENTS).all(turn.id).map(toEvent) };
};

const writeTurn = (
  database: DatabaseSync,
  { expectedRevision, turn, characters, scenes, events }: TurnCommit,
): CommittedTurn => {
  const { campaignId } = turn;
  const revision = nextRevision(database, campaignId, expectedRevision);
  for (const { id, campaignId: owner, name } of characters) {
    const reference = `character ${id}`;
    requireInCampaign(campaignId, reference, owner === campaignId);
    requireInCampaign(campaignId, reference, upsertOwned(database, UPSERT_CHARACTER, [id, owner, name]));
  }
  for (const { id, campaignId: owner, title } of scenes) {
    const reference = `scene ${id}`;
    requireInCampaign(campaignId, reference, owner === campaignId);
    requireInCampaign(campaignId, reference, upsertOwned(database, UPSERT_SCENE, [id, owner, title]));
  }
  requireInCampaign(campaignId, `scene ${turn.sceneId}`, ownedBy(database, OWNED_SCENE, turn.sceneId, campaignId));
  requireInCampaign(
    campaignId,
    `character ${turn.actorId}`,
    ownedBy(database, OWNED_CHARACTER, turn.actorId, campaignId),
  );
  database
    .prepare(INSERT_TURN)
    .run(turn.id, campaignId, turn.sceneId, turn.actionId, turn.actorId, turn.input, turn.narration, revision);
  for (const event of events) {
    const reference = `event ${event.id}`;
    requireInCampaign(campaignId, reference, event.campaignId === campaignId && event.turnId === turn.id);
    if (event.causationId !== null) {
      const cause = `event ${event.causationId}`;
      requireInCampaign(campaignId, cause, ownedBy(database, OWNED_EVENT, event.causationId, campaignId));
    }
    database
      .prepare(APPEND_EVENT)
      .run(
        event.id,
        campaignId,
        MAIN_BRANCH,
        revision,
        turn.actionId,
        turn.id,
        event.causationId,
        event.type,
        JSON.stringify(event.payload),
      );
  }
  database.prepare(ADVANCE_CAMPAIGN).run(revision, turn.sceneId, campaignId);
  return { turn, events };
};

export const createCampaignStore = (database: DatabaseSync): CampaignStore => ({
  createCampaign: (campaign: Campaign, event: CampaignChange) =>
    inTransaction(database, () => {
      database.prepare(INSERT_CAMPAIGN).run(campaign.id, campaign.name);
      appendCampaignChange(database, campaign.id, event, INITIAL_REVISION);
    }),
  renameCampaign: ({ expectedRevision, campaign, event }) =>
    inTransaction(database, () => {
      const revision = nextRevision(database, campaign.id, expectedRevision);
      database.prepare(RENAME_CAMPAIGN).run(campaign.name, revision, campaign.id);
      appendCampaignChange(database, campaign.id, event, revision);
    }),
  commitTurn: (commit) =>
    inTransaction(database, () => storedTurn(database, commit.turn) ?? writeTurn(database, commit)),
  load: (id) => {
    const row = database.prepare(SELECT_CAMPAIGN).get(id);
    if (row === undefined) return undefined;
    const sceneRow = database.prepare(SELECT_CURRENT_SCENE).get(id);
    return {
      campaign: { id: String(row.id), name: String(row.name) },
      revision: Number(row.revision),
      characters: database.prepare(SELECT_CHARACTERS).all(id).map(toCharacter),
      currentScene: sceneRow === undefined ? undefined : toScene(sceneRow),
      turns: database.prepare(SELECT_TURNS).all(id).map(toTurn),
      events: database.prepare(SELECT_EVENTS).all(id).map(toEvent),
    };
  },
});
