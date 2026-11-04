import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampaignNotFoundError, type CampaignStore, StaleRevisionError } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { InvalidActionError, type PlayerAction, performAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const SETUP_REVISION = 1;
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CHARACTER = { id: 'character-1', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const SETUP_TURN = {
  id: 'turn-0',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'setup',
  actorId: CHARACTER.id,
  input: 'Begin.',
  narration: 'A lantern sways at the end of the pier.',
};
const ACTION: PlayerAction = {
  campaignId: CAMPAIGN.id,
  actionId: 'action-1',
  expectedRevision: SETUP_REVISION,
  sceneId: SCENE.id,
  actorId: CHARACTER.id,
  input: 'I look for the ferryman.',
  intent: 'Mara searches the dock for the ferryman.',
};
const BLANK = '   ';

const openEngineStore = (): { store: CampaignStore; close: () => void } => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  store.createCampaign(CAMPAIGN);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [CHARACTER], scenes: [SCENE], events: [] });
  return { store, close: () => connection.close() };
};

test('player can perform an action and persist a validated corresponding state change', () => {
  const { store, close } = openEngineStore();
  const committed = performAction(store, ACTION);
  const { turn, events } = committed;
  assert.deepEqual(
    { ...turn, id: '' },
    {
      id: '',
      campaignId: CAMPAIGN.id,
      sceneId: SCENE.id,
      actionId: ACTION.actionId,
      actorId: CHARACTER.id,
      input: ACTION.input,
      narration: '',
    },
  );
  const [submitted, validated] = events;
  assert.equal(events.length, 2);
  assert.equal(submitted?.type, 'PlayerActionSubmitted');
  assert.equal(submitted?.causationId, null);
  assert.deepEqual(submitted?.payload, {
    actorId: ACTION.actorId,
    sceneId: ACTION.sceneId,
    input: ACTION.input,
    intent: ACTION.intent,
  });
  assert.equal(validated?.type, 'ActionValidated');
  assert.equal(validated?.causationId, submitted?.id);
  assert.deepEqual(validated?.payload, { revision: SETUP_REVISION + 1 });
  for (const event of events) assert.equal(event.turnId, turn.id);

  const state = store.load(CAMPAIGN.id);
  assert.equal(state?.revision, SETUP_REVISION + 1);
  assert.deepEqual(state?.turns, [SETUP_TURN, turn]);
  assert.deepEqual(state?.events, events);

  assert.deepEqual(performAction(store, ACTION), committed);
  assert.deepEqual(store.load(CAMPAIGN.id), state);
  close();
});

test('a failed action produces no partial state mutation', () => {
  const { store, close } = openEngineStore();
  const before = store.load(CAMPAIGN.id);
  const failures: [PlayerAction, new (...args: never[]) => Error][] = [
    [{ ...ACTION, campaignId: 'missing' }, CampaignNotFoundError],
    [{ ...ACTION, expectedRevision: SETUP_REVISION - 1 }, StaleRevisionError],
    [{ ...ACTION, sceneId: 'scene-2' }, InvalidActionError],
    [{ ...ACTION, actorId: 'character-2' }, InvalidActionError],
    [{ ...ACTION, input: BLANK }, InvalidActionError],
    [{ ...ACTION, intent: BLANK }, InvalidActionError],
  ];
  for (const [action, error] of failures) {
    assert.throws(() => performAction(store, action), error);
    assert.deepEqual(store.load(CAMPAIGN.id), before);
  }
  close();
});
