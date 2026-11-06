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
  PLAYER_TURN,
  type Scene,
  StaleRevisionError,
  SYSTEM_TURN,
  TURN_VISIBILITIES,
  type Turn,
  type TurnCommit,
  type TurnSegment,
} from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import { RECENT_TURN_WINDOW, SNAPSHOT_EVERY_EVENTS } from '../../timelines/src/live.ts';
import { createLiveStates } from './live-state.ts';

const GM_VISIBILITY: Visibility = 'gm';
const INSERT_CAMPAIGN = 'INSERT INTO campaign (id, name) VALUES (?, ?)';
const SELECT_CAMPAIGN = 'SELECT id, name, revision FROM campaign WHERE id = ?';
const SELECT_REVISION = 'SELECT revision FROM campaign WHERE id = ?';
const RENAME_CAMPAIGN = 'UPDATE campaign SET name = ?, revision = ? WHERE id = ?';
const ADVANCE_REVISION = 'UPDATE campaign SET revision = ? WHERE id = ?';
const ADVANCE_CAMPAIGN = 'UPDATE campaign SET revision = ?, current_scene_id = ? WHERE id = ?';
const UPSERT_CHARACTER =
  'INSERT INTO character (id, campaign_id, name) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name WHERE character.campaign_id = excluded.campaign_id';
const UPSERT_SCENE =
  'INSERT INTO scene (id, campaign_id, title, location_kind, mood_tags) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title, location_kind = excluded.location_kind, mood_tags = excluded.mood_tags WHERE scene.campaign_id = excluded.campaign_id';
const OWNED_CHARACTER = 'SELECT 1 FROM character WHERE id = ? AND campaign_id = ?';
const OWNED_SCENE = 'SELECT 1 FROM scene WHERE id = ? AND campaign_id = ?';
const OWNED_EVENT = 'SELECT 1 FROM event_log WHERE id = ? AND campaign_id = ?';
const INSERT_TURN =
  'INSERT INTO turn (id, campaign_id, scene_id, action_id, actor_id, input, narration, kind, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
const APPEND_EVENT =
  'INSERT INTO event_log (id, campaign_id, branch_id, revision, action_id, turn_id, causation_id, type, payload, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const RECORD_NARRATION = 'UPDATE turn SET narration = ?, segments = ? WHERE id = ? AND campaign_id = ?';
const SELECT_CHARACTERS = 'SELECT id, campaign_id, name FROM character WHERE campaign_id = ? ORDER BY rowid';
const SELECT_CURRENT_SCENE =
  'SELECT scene.id, scene.campaign_id, scene.title, scene.location_kind, scene.mood_tags FROM scene JOIN campaign ON campaign.current_scene_id = scene.id WHERE campaign.id = ?';
const TURN_COLUMNS =
  'SELECT id, campaign_id, scene_id, action_id, actor_id, input, narration, segments, kind FROM turn';
const SELECT_RECENT_TURNS = `${TURN_COLUMNS} WHERE campaign_id = ? ORDER BY revision DESC LIMIT ${RECENT_TURN_WINDOW}`;
const SELECT_TURN_BY_ACTION = `${TURN_COLUMNS} WHERE campaign_id = ? AND action_id = ?`;
const EVENT_COLUMNS = 'SELECT id, campaign_id, turn_id, causation_id, type, payload FROM event_log';
const ON_MAIN_BRANCH = `IFNULL(branch_id, '${MAIN_BRANCH}') = '${MAIN_BRANCH}'`;
const HAS_TURN_EVENT = `SELECT 1 FROM event_log WHERE campaign_id = ? AND type = ? AND turn_id IS NOT NULL AND ${ON_MAIN_BRANCH} LIMIT 1`;
const HAS_TURN_EVENT_ID = `SELECT 1 FROM event_log WHERE campaign_id = ? AND type = ? AND id = ? AND turn_id IS NOT NULL AND ${ON_MAIN_BRANCH} LIMIT 1`;
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
  ...(row.location_kind === null || row.location_kind === undefined ? {} : { locationKind: String(row.location_kind) }),
  ...(typeof row.mood_tags === 'string' ? { moodTags: JSON.parse(row.mood_tags) as string[] } : {}),
});

const isSegment = (value: unknown): value is TurnSegment =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Row).text === 'string' &&
  ((value as Row).speakerId === undefined || typeof (value as Row).speakerId === 'string') &&
  ((value as Row).delivery === undefined ||
    (typeof (value as Row).delivery === 'object' && (value as Row).delivery !== null));

const segmentsOf = (stored: unknown): { segments?: readonly TurnSegment[] } => {
  if (typeof stored !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every(isSegment) ? { segments: parsed } : {};
  } catch {
    return {};
  }
};

const toTurn = (row: Row): Turn => ({
  id: String(row.id),
  campaignId: String(row.campaign_id),
  sceneId: String(row.scene_id),
  actionId: String(row.action_id),
  actorId: String(row.actor_id),
  input: String(row.input),
  narration: String(row.narration),
  ...segmentsOf(row.segments),
  ...(row.kind === SYSTEM_TURN ? { kind: SYSTEM_TURN } : {}),
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

const upsertOwned = (database: DatabaseSync, sql: string, values: readonly (string | null)[]) =>
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
      GM_VISIBILITY,
    );
};

const storedTurn = (
  database: DatabaseSync,
  { campaignId, actionId }: Pick<Turn, 'campaignId' | 'actionId'>,
): CommittedTurn | undefined => {
  const row = database.prepare(SELECT_TURN_BY_ACTION).get(campaignId, actionId);
  if (row === undefined) return undefined;
  const turn = toTurn(row);
  return { turn, events: database.prepare(SELECT_TURN_EVENTS).all(turn.id).map(toEvent) };
};

const writeTurn = (
  database: DatabaseSync,
  { expectedRevision, turn, characters, scenes, events, visibility }: TurnCommit,
): CommittedTurn => {
  const { campaignId } = turn;
  for (const [id, shown] of Object.entries(visibility ?? {}))
    if (!TURN_VISIBILITIES.includes(shown)) throw new RangeError(`event ${id} cannot be ${shown} in a turn`);
  const revision = nextRevision(database, campaignId, expectedRevision);
  for (const { id, campaignId: owner, name } of characters) {
    const reference = `character ${id}`;
    requireInCampaign(campaignId, reference, owner === campaignId);
    requireInCampaign(campaignId, reference, upsertOwned(database, UPSERT_CHARACTER, [id, owner, name]));
  }
  for (const { id, campaignId: owner, title, locationKind, moodTags } of scenes) {
    const reference = `scene ${id}`;
    requireInCampaign(campaignId, reference, owner === campaignId);
    requireInCampaign(
      campaignId,
      reference,
      upsertOwned(database, UPSERT_SCENE, [
        id,
        owner,
        title,
        locationKind ?? null,
        moodTags === undefined ? null : JSON.stringify(moodTags),
      ]),
    );
  }
  requireInCampaign(campaignId, `scene ${turn.sceneId}`, ownedBy(database, OWNED_SCENE, turn.sceneId, campaignId));
  requireInCampaign(
    campaignId,
    `character ${turn.actorId}`,
    ownedBy(database, OWNED_CHARACTER, turn.actorId, campaignId),
  );
  database
    .prepare(INSERT_TURN)
    .run(
      turn.id,
      campaignId,
      turn.sceneId,
      turn.actionId,
      turn.actorId,
      turn.input,
      turn.narration,
      turn.kind ?? PLAYER_TURN,
      revision,
    );
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
        visibility?.[event.id] ?? GM_VISIBILITY,
      );
  }
  database.prepare(ADVANCE_CAMPAIGN).run(revision, turn.sceneId, campaignId);
  return { turn, events };
};

export type CampaignStoreOptions = { readonly snapshotEvery?: number };

export const createCampaignStore = (
  database: DatabaseSync,
  { snapshotEvery = SNAPSHOT_EVERY_EVENTS }: CampaignStoreOptions = {},
): CampaignStore => {
  const live = createLiveStates(database, snapshotEvery);
  const written = <T>(campaignId: string, write: () => T): T => {
    const result = write();
    try {
      live.checkpoint(campaignId);
    } catch {
      return result;
    }
    return result;
  };
  return {
    createCampaign: (campaign: Campaign, event: CampaignChange) =>
      written(campaign.id, () =>
        inTransaction(database, () => {
          database.prepare(INSERT_CAMPAIGN).run(campaign.id, campaign.name);
          appendCampaignChange(database, campaign.id, event, INITIAL_REVISION);
        }),
      ),
    renameCampaign: ({ expectedRevision, campaign, event }) =>
      written(campaign.id, () =>
        inTransaction(database, () => {
          const revision = nextRevision(database, campaign.id, expectedRevision);
          database.prepare(RENAME_CAMPAIGN).run(campaign.name, revision, campaign.id);
          appendCampaignChange(database, campaign.id, event, revision);
        }),
      ),
    recordChange: ({ expectedRevision, event }) =>
      written(event.campaignId, () =>
        inTransaction(database, () => {
          const revision = nextRevision(database, event.campaignId, expectedRevision);
          database.prepare(ADVANCE_REVISION).run(revision, event.campaignId);
          appendCampaignChange(database, event.campaignId, event, revision);
        }),
      ),
    commitTurn: (commit) =>
      written(commit.turn.campaignId, () =>
        inTransaction(database, () => storedTurn(database, commit.turn) ?? writeTurn(database, commit)),
      ),
    recordNarration: (campaignId, turnId, narration, segments) =>
      requireInCampaign(
        campaignId,
        `turn ${turnId}`,
        database
          .prepare(RECORD_NARRATION)
          .run(narration, segments === undefined ? null : JSON.stringify(segments), turnId, campaignId).changes !==
          NO_CHANGES,
      ),
    recordUsage: (event) =>
      written(event.campaignId, () =>
        inTransaction(database, () => {
          const current = database.prepare(SELECT_REVISION).get(event.campaignId);
          if (current === undefined) throw new CampaignNotFoundError(event.campaignId);
          appendCampaignChange(database, event.campaignId, event, Number(current.revision));
        }),
      ),
    findTurn: (campaignId, actionId) => storedTurn(database, { campaignId, actionId }),
    hasEvent: (campaignId, type, eventId) =>
      eventId === undefined
        ? database.prepare(HAS_TURN_EVENT).get(campaignId, type) !== undefined
        : database.prepare(HAS_TURN_EVENT_ID).get(campaignId, type, eventId) !== undefined,
    load: (id) => {
      const row = database.prepare(SELECT_CAMPAIGN).get(id);
      if (row === undefined) return undefined;
      const sceneRow = database.prepare(SELECT_CURRENT_SCENE).get(id);
      const { events, changes, gmUsage, folds } = live.read(id);
      return {
        campaign: { id: String(row.id), name: String(row.name) },
        revision: Number(row.revision),
        characters: database.prepare(SELECT_CHARACTERS).all(id).map(toCharacter),
        currentScene: sceneRow === undefined ? undefined : toScene(sceneRow),
        turns: database.prepare(SELECT_RECENT_TURNS).all(id).map(toTurn).reverse(),
        events,
        changes: Object.values(changes),
        gmUsage,
        folds,
      };
    },
  };
};
