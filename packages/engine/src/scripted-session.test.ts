import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEngine } from './engine.ts';
import {
  createFakeGameMaster,
  GameMasterInterruptedError,
  INTERRUPT,
  runScript,
  type ScriptStep,
} from './scripted-session.ts';

const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN_NAME = 'Long Road';
const SCENE_ID = 'scene-1';
const ACTOR_ID = 'character-1';
const SETUP_REVISION = 1;
const SESSION_TURNS = 24;
const TURNS_BEFORE_RESTART = 11;
const EVENTS_PER_TURN = 2;
const UNIQUE_BEFORE_RESTART = 1;
const UNIQUE_ACTIONS = 2;
const SUBMITTED = 'PlayerActionSubmitted';
const VALIDATED = 'ActionValidated';
const COUNT_TURNS = 'SELECT COUNT(*) AS count FROM turn WHERE campaign_id = ?';
const COUNT_EVENTS = 'SELECT COUNT(*) AS count FROM event_log WHERE campaign_id = ?';

const withDatabaseFile = (run: (path: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-fake-gm-'));
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
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'turn-0',
      campaignId: campaign.id,
      sceneId: SCENE_ID,
      actionId: 'setup',
      actorId: ACTOR_ID,
      input: 'Begin.',
      narration: 'The road bends north.',
    },
    characters: [{ id: ACTOR_ID, campaignId: campaign.id, name: 'Ilse' }],
    scenes: [{ id: SCENE_ID, campaignId: campaign.id, title: 'The North Road' }],
    events: [],
  });
  connection.close();
  return campaign.id;
};

const step = (index: number): ScriptStep => ({
  proposal: {
    actionId: `action-${index}`,
    sceneId: SCENE_ID,
    actorId: ACTOR_ID,
    input: `I walk to milestone ${index}.`,
    intent: `travel-${index}`,
  },
  narration: `Milestone ${index} passes.`,
});

const countRows = (path: string, campaignId: string) => {
  const { connection } = openSession(path);
  const turns = Number(connection.database.prepare(COUNT_TURNS).get(campaignId)?.count);
  const events = Number(connection.database.prepare(COUNT_EVENTS).get(campaignId)?.count);
  connection.close();
  return { turns, events };
};

test('plays a long scripted session without model API calls and exposes committed events', () =>
  withDatabaseFile((path) => {
    const campaignId = startCampaign(path);
    const script = Array.from({ length: SESSION_TURNS }, (_, index) => step(index));
    const gameMaster = createFakeGameMaster(script);

    const first = openSession(path);
    const beforeRestart = runScript(first.store, gameMaster, campaignId, TURNS_BEFORE_RESTART);
    first.connection.close();

    const second = openSession(path);
    const afterRestart = runScript(second.store, gameMaster, campaignId, SESSION_TURNS - TURNS_BEFORE_RESTART);
    const state = second.engine.getState(campaignId);
    second.connection.close();

    const outcomes = [...beforeRestart, ...afterRestart];
    assert.deepEqual(
      outcomes.map((outcome) => ('narration' in outcome ? outcome.narration : undefined)),
      script.map((entry) => (entry === INTERRUPT ? undefined : entry.narration)),
    );
    assert.equal(state.revision, SETUP_REVISION + SESSION_TURNS);
    assert.deepEqual(
      state.turns.slice(SETUP_REVISION).map(({ actionId }) => actionId),
      script.map((_, index) => `action-${index}`),
    );
    assert.equal(state.events.length, SESSION_TURNS * EVENTS_PER_TURN);
    state.turns.slice(SETUP_REVISION).forEach((turn, index) => {
      const [submitted, validated] = state.events.slice(index * EVENTS_PER_TURN, (index + 1) * EVENTS_PER_TURN);
      assert.equal(submitted?.type, SUBMITTED);
      assert.equal(submitted?.turnId, turn.id);
      assert.equal(submitted?.causationId, null);
      assert.equal(validated?.type, VALIDATED);
      assert.equal(validated?.causationId, submitted?.id);
      assert.deepEqual(validated?.payload, { revision: SETUP_REVISION + index + 1 });
    });
  }));

test('repeated or interrupted fake-model responses cannot duplicate mutations', () =>
  withDatabaseFile((path) => {
    const campaignId = startCampaign(path);
    const setup = countRows(path, campaignId);
    const interruptedSession: ScriptStep[] = [step(0), step(0), INTERRUPT];
    const resumedSession: ScriptStep[] = [step(1), step(1)];
    const gameMaster = createFakeGameMaster([...interruptedSession, ...resumedSession]);

    const session = openSession(path);
    const outcomes = runScript(session.store, gameMaster, campaignId, interruptedSession.length);
    const afterInterrupt = session.engine.getState(campaignId);
    session.connection.close();

    const [first, replay, interrupted] = outcomes;
    assert.ok(first !== undefined && 'committed' in first);
    assert.ok(replay !== undefined && 'committed' in replay);
    assert.deepEqual(replay.committed, first.committed);
    assert.ok(interrupted !== undefined && 'interrupted' in interrupted);
    assert.ok(interrupted.interrupted instanceof GameMasterInterruptedError);
    assert.equal(afterInterrupt.revision, SETUP_REVISION + UNIQUE_BEFORE_RESTART);
    assert.deepEqual(countRows(path, campaignId), {
      turns: setup.turns + UNIQUE_BEFORE_RESTART,
      events: setup.events + UNIQUE_BEFORE_RESTART * EVENTS_PER_TURN,
    });

    const resumed = openSession(path);
    const [retried, retriedAgain] = runScript(resumed.store, gameMaster, campaignId, resumedSession.length);
    resumed.connection.close();
    assert.ok(retried !== undefined && 'committed' in retried);
    assert.ok(retriedAgain !== undefined && 'committed' in retriedAgain);
    assert.deepEqual(retriedAgain.committed, retried.committed);
    assert.deepEqual(countRows(path, campaignId), {
      turns: setup.turns + UNIQUE_ACTIONS,
      events: setup.events + UNIQUE_ACTIONS * EVENTS_PER_TURN,
    });
    assert.throws(() => gameMaster.respond(afterInterrupt), RangeError);
  }));
