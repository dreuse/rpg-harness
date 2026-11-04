import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEngine } from './engine.ts';
import { type PlayerAction, performAction } from './turn.ts';

const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN_NAME = 'Harbor Lights';
const SETUP_REVISION = 1;
const EVENTS_PER_TURN = 2;
const PLAYED_INPUTS = ['I look for the ferryman.', 'I ask about the lantern.', 'I board the ferry.'];
const RESUMED_INPUT = 'I pay the fare.';
const COUNT_TURNS = 'SELECT COUNT(*) AS count FROM turn WHERE campaign_id = ? AND action_id = ?';
const COUNT_EVENTS = 'SELECT COUNT(*) AS count FROM event_log WHERE campaign_id = ? AND action_id = ?';

const withDatabaseFile = (run: (path: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-smoke-'));
  try {
    run(join(directory, DATABASE_FILE));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const openSession = (path: string) => {
  const connection = openDatabase(path);
  const store = createCampaignStore(connection.database);
  return { connection, store, engine: createEngine(store) };
};

const startCampaign = (path: string) => {
  const { connection, store, engine } = openSession(path);
  const campaign = engine.createCampaign(CAMPAIGN_NAME);
  const character = { id: 'character-1', campaignId: campaign.id, name: 'Mara' };
  const scene = { id: 'scene-1', campaignId: campaign.id, title: 'The Dock at Dusk' };
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'turn-0',
      campaignId: campaign.id,
      sceneId: scene.id,
      actionId: 'setup',
      actorId: character.id,
      input: 'Begin.',
      narration: 'A lantern sways at the end of the pier.',
    },
    characters: [character],
    scenes: [scene],
    events: [],
  });
  connection.close();
  return { campaignId: campaign.id, sceneId: scene.id, actorId: character.id };
};

const actionAt = (
  target: { campaignId: string; sceneId: string; actorId: string },
  revision: number,
  input: string,
): PlayerAction => ({ ...target, actionId: `action-${revision}`, expectedRevision: revision, input, intent: input });

test('scripted test creates a campaign, plays multiple turns, exits and resumes', () =>
  withDatabaseFile((path) => {
    const target = startCampaign(path);

    const played = openSession(path);
    const committed = PLAYED_INPUTS.map((input, index) =>
      performAction(played.store, actionAt(target, SETUP_REVISION + index, input)),
    );
    const beforeExit = played.engine.getState(target.campaignId);
    played.connection.close();

    const resumed = openSession(path);
    const afterResume = resumed.engine.getState(target.campaignId);
    assert.deepEqual(afterResume, beforeExit);
    assert.equal(afterResume.revision, SETUP_REVISION + PLAYED_INPUTS.length);
    assert.deepEqual(
      afterResume.turns.slice(SETUP_REVISION),
      committed.map(({ turn }) => turn),
    );
    assert.deepEqual(
      afterResume.events,
      committed.flatMap(({ events }) => events),
    );

    const next = performAction(resumed.store, actionAt(target, afterResume.revision, RESUMED_INPUT));
    const final = resumed.engine.getState(target.campaignId);
    assert.equal(final.revision, afterResume.revision + 1);
    assert.deepEqual(final.turns.at(-1), next.turn);
    assert.equal(final.events.length, (PLAYED_INPUTS.length + 1) * EVENTS_PER_TURN);
    resumed.connection.close();
  }));

test('duplicate tool calls cannot duplicate the committed action', () =>
  withDatabaseFile((path) => {
    const target = startCampaign(path);
    const action = actionAt(target, SETUP_REVISION, PLAYED_INPUTS[0] ?? '');

    const first = openSession(path);
    const committed = performAction(first.store, action);
    assert.deepEqual(performAction(first.store, action), committed);
    const afterCommit = first.engine.getState(target.campaignId);
    first.connection.close();

    const retried = openSession(path);
    assert.deepEqual(performAction(retried.store, action), committed);
    assert.deepEqual(performAction(retried.store, { ...action, expectedRevision: afterCommit.revision }), committed);
    assert.deepEqual(retried.engine.getState(target.campaignId), afterCommit);
    const { database } = retried.connection;
    assert.equal(database.prepare(COUNT_TURNS).get(target.campaignId, action.actionId)?.count, 1);
    assert.equal(database.prepare(COUNT_EVENTS).get(target.campaignId, action.actionId)?.count, EVENTS_PER_TURN);
    retried.connection.close();
  }));
