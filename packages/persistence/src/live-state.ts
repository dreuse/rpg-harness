import type { DatabaseSync } from 'node:sqlite';
import { type CampaignId, MAIN_BRANCH, SCENE_OPENED } from '../../domain/src/campaign.ts';
import {
  createLiveAccumulator,
  LIVE_PROJECTION_VERSION,
  type LiveState,
  liveProjection,
  SNAPSHOT_EVERY_EVENTS,
} from '../../timelines/src/live.ts';
import { isResumable, type Snapshot } from '../../timelines/src/replay.ts';
import { toEvent } from './event-store.ts';

export const SNAPSHOTS_KEPT = 3;

const ON_MAIN_BRANCH = `IFNULL(branch_id, '${MAIN_BRANCH}') = '${MAIN_BRANCH}'`;
const SELECT_AFTER = `SELECT seq, id, campaign_id, branch_id, turn_id, actor_id, revision, causation_id, type, payload FROM event_log WHERE seq > ? AND +campaign_id = ? AND ${ON_MAIN_BRANCH} ORDER BY seq`;
const SELECT_SNAPSHOTS =
  'SELECT version, event_count, last_event_id, state FROM campaign_snapshot WHERE campaign_id = ? AND branch_id = ? ORDER BY event_count DESC';
const SELECT_SEQ = 'SELECT seq FROM event_log WHERE id = ? AND campaign_id = ?';
const COUNT_THROUGH = `SELECT COUNT(*) AS total FROM event_log WHERE +campaign_id = ? AND seq <= ? AND ${ON_MAIN_BRANCH}`;
const WRITE_SNAPSHOT =
  'INSERT OR REPLACE INTO campaign_snapshot (campaign_id, branch_id, version, event_count, last_event_id, state) VALUES (?, ?, ?, ?, ?, ?)';
const PRUNE_SNAPSHOTS = `DELETE FROM campaign_snapshot WHERE campaign_id = ? AND branch_id = ? AND event_count NOT IN (
  SELECT event_count FROM campaign_snapshot WHERE campaign_id = ? AND branch_id = ? ORDER BY event_count DESC LIMIT ${SNAPSHOTS_KEPT})`;
const SELECT_LAST_ID = 'SELECT id FROM event_log WHERE seq = ?';
const NO_EVENTS = 0;

type Entry = {
  readonly accumulator: ReturnType<typeof createLiveAccumulator>;
  cursor: number;
  count: number;
  snapshotAt: number;
  sceneOpened: boolean;
  published: LiveState | undefined;
};

const entryFrom = (state: LiveState, cursor: number): Entry => ({
  accumulator: createLiveAccumulator(state),
  cursor,
  count: state.count,
  snapshotAt: state.count,
  sceneOpened: false,
  published: undefined,
});

const stateOf = (entry: Entry): LiveState => {
  entry.published ??= entry.accumulator.state();
  return entry.published;
};

const isLiveState = (value: unknown): value is LiveState =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LiveState).count === 'number' &&
  Array.isArray((value as LiveState).events) &&
  typeof (value as LiveState).changes === 'object' &&
  typeof (value as LiveState).gmUsage === 'object';

const parsed = (text: string): LiveState | undefined => {
  try {
    const value = JSON.parse(text);
    return isLiveState(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const createLiveStates = (database: DatabaseSync, snapshotEvery = SNAPSHOT_EVERY_EVENTS) => {
  const entries = new Map<CampaignId, Entry>();

  const anchoredCursor = (campaignId: CampaignId, { eventCount, lastEventId }: Snapshot<LiveState>) => {
    const found = database.prepare(SELECT_SEQ).get(lastEventId, campaignId);
    if (found === undefined) return undefined;
    const seq = Number(found.seq);
    const total = Number(database.prepare(COUNT_THROUGH).get(campaignId, seq)?.total);
    return total === eventCount ? seq : undefined;
  };

  const newestValid = (campaignId: CampaignId): Entry => {
    const timeline = { campaignId, branchId: MAIN_BRANCH };
    for (const row of database.prepare(SELECT_SNAPSHOTS).all(campaignId, MAIN_BRANCH)) {
      const state = parsed(String(row.state));
      if (state === undefined) continue;
      const snapshot: Snapshot<LiveState> = {
        ...timeline,
        version: Number(row.version),
        eventCount: Number(row.event_count),
        lastEventId: String(row.last_event_id),
        state,
      };
      const cursor = isResumable(liveProjection, timeline, snapshot) ? anchoredCursor(campaignId, snapshot) : undefined;
      if (cursor !== undefined) return entryFrom(state, cursor);
    }
    return entryFrom(liveProjection.initial, NO_EVENTS);
  };

  const advance = (campaignId: CampaignId): Entry => {
    const entry = entries.get(campaignId) ?? newestValid(campaignId);
    entries.set(campaignId, entry);
    const before = entry.cursor;
    for (const row of database.prepare(SELECT_AFTER).iterate(entry.cursor, campaignId)) {
      const event = toEvent(row);
      entry.accumulator.push(event);
      entry.count += 1;
      entry.cursor = Number(row.seq);
      entry.sceneOpened ||= event.type === SCENE_OPENED;
    }
    if (entry.cursor !== before) entry.published = undefined;
    return entry;
  };

  const snapshotDue = ({ count, snapshotAt, sceneOpened }: Entry) =>
    count > snapshotAt && (sceneOpened || count - snapshotAt >= snapshotEvery);

  return {
    read: (campaignId: CampaignId): LiveState => stateOf(advance(campaignId)),
    checkpoint: (campaignId: CampaignId) => {
      const entry = advance(campaignId);
      if (!snapshotDue(entry)) return;
      const state = stateOf(entry);
      const lastEventId = database.prepare(SELECT_LAST_ID).get(entry.cursor)?.id;
      database
        .prepare(WRITE_SNAPSHOT)
        .run(campaignId, MAIN_BRANCH, LIVE_PROJECTION_VERSION, state.count, String(lastEventId), JSON.stringify(state));
      database.prepare(PRUNE_SNAPSHOTS).run(campaignId, MAIN_BRANCH, campaignId, MAIN_BRANCH);
      entry.snapshotAt = state.count;
      entry.sceneOpened = false;
    },
  };
};
