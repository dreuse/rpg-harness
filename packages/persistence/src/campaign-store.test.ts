import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type Campaign,
  CampaignBoundaryError,
  CampaignNotFoundError,
  type CampaignState,
  StaleRevisionError,
  type TurnCommit,
} from '../../domain/src/campaign.ts';
import { createCampaignStore } from './campaign-store.ts';
import { openDatabase } from './database.ts';

const IN_MEMORY = ':memory:';
const TEMP_PREFIX = 'rpg-campaign-store-';
const DATABASE_FILE = 'campaign.sqlite';
const INITIAL_REVISION = 0;
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CHARACTER = { id: 'character-1', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const TURN = {
  id: 'turn-1',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'action-1',
  actorId: CHARACTER.id,
  input: 'I look for the ferryman.',
  narration: 'A lantern sways at the end of the pier.',
};
const ACTION_EVENT = {
  id: 'event-1',
  campaignId: CAMPAIGN.id,
  turnId: TURN.id,
  causationId: null,
  type: 'PlayerActionSubmitted',
  payload: { input: TURN.input },
};
const NARRATION_EVENT = {
  id: 'event-2',
  campaignId: CAMPAIGN.id,
  turnId: TURN.id,
  causationId: ACTION_EVENT.id,
  type: 'TurnNarrated',
  payload: { narration: TURN.narration },
};
const COMMIT: TurnCommit = {
  expectedRevision: INITIAL_REVISION,
  turn: TURN,
  characters: [CHARACTER],
  scenes: [SCENE],
  events: [ACTION_EVENT, NARRATION_EVENT],
};
const EXPECTED_STATE: CampaignState = {
  campaign: CAMPAIGN,
  revision: INITIAL_REVISION + 1,
  characters: [CHARACTER],
  currentScene: SCENE,
  turns: [TURN],
  events: [ACTION_EVENT, NARRATION_EVENT],
};

const OTHER_CAMPAIGN = { id: 'campaign-2', name: 'Salt Roads' };
const MISSING_ID = 'missing';
const DUPLICATE_ACTION = /UNIQUE constraint failed: turn\.campaign_id, turn\.action_id/;
const DUPLICATE_EVENT = /UNIQUE constraint failed: event_log\.id/;

const emptyState = (campaign: Campaign): CampaignState => ({
  campaign,
  revision: INITIAL_REVISION,
  characters: [],
  currentScene: undefined,
  turns: [],
  events: [],
});

const openStore = (path: string) => {
  const connection = openDatabase(path);
  return { connection, store: createCampaignStore(connection.database) };
};

test('store and retrieve a campaign, character, current scene and single turn', () => {
  const { connection, store } = openStore(IN_MEMORY);
  store.createCampaign(CAMPAIGN);
  assert.deepEqual(store.load(CAMPAIGN.id), emptyState(CAMPAIGN));
  store.commitTurn(COMMIT);
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  assert.equal(store.load(MISSING_ID), undefined);
  connection.close();
});

test('stale revision or failed turn writes nothing', () => {
  const { connection, store } = openStore(IN_MEMORY);
  store.createCampaign(CAMPAIGN);
  store.commitTurn(COMMIT);
  const second = { ...COMMIT, turn: { ...TURN, id: 'turn-2', actionId: 'action-2' }, events: [] };
  assert.throws(() => store.commitTurn(second), StaleRevisionError);
  const duplicateAction = { ...second, expectedRevision: INITIAL_REVISION + 1, turn: { ...TURN, id: 'turn-2' } };
  assert.throws(() => store.commitTurn(duplicateAction), DUPLICATE_ACTION);
  const lateFailure: TurnCommit = {
    expectedRevision: INITIAL_REVISION + 1,
    turn: { ...TURN, id: 'turn-2', actionId: 'action-2', sceneId: 'scene-2', actorId: 'character-2' },
    characters: [{ ...CHARACTER, id: 'character-2', name: 'Oren' }],
    scenes: [{ ...SCENE, id: 'scene-2', title: 'The Ferry' }],
    events: [
      { ...ACTION_EVENT, id: 'event-3', turnId: 'turn-2' },
      { ...NARRATION_EVENT, id: 'event-3', turnId: 'turn-2', causationId: 'event-3' },
    ],
  };
  assert.throws(() => store.commitTurn(lateFailure), DUPLICATE_EVENT);
  assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
  assert.throws(
    () => store.commitTurn({ ...COMMIT, turn: { ...TURN, campaignId: MISSING_ID } }),
    CampaignNotFoundError,
  );
  connection.close();
});

test('a turn for one campaign cannot write or reference another campaign', () => {
  const { connection, store } = openStore(IN_MEMORY);
  store.createCampaign(CAMPAIGN);
  store.commitTurn(COMMIT);
  store.createCampaign(OTHER_CAMPAIGN);
  const ownCharacter = { id: 'character-2', campaignId: OTHER_CAMPAIGN.id, name: 'Oren' };
  const ownScene = { id: 'scene-2', campaignId: OTHER_CAMPAIGN.id, title: 'The Ferry' };
  const ownTurn = {
    ...TURN,
    id: 'turn-2',
    campaignId: OTHER_CAMPAIGN.id,
    sceneId: ownScene.id,
    actorId: ownCharacter.id,
  };
  const ownEvent = { ...ACTION_EVENT, id: 'event-3', campaignId: OTHER_CAMPAIGN.id, turnId: ownTurn.id };
  const valid: TurnCommit = {
    expectedRevision: INITIAL_REVISION,
    turn: ownTurn,
    characters: [ownCharacter],
    scenes: [ownScene],
    events: [ownEvent],
  };
  const attempts: TurnCommit[] = [
    { ...valid, characters: [ownCharacter, { ...CHARACTER, campaignId: OTHER_CAMPAIGN.id, name: 'Impostor' }] },
    { ...valid, characters: [ownCharacter, { ...CHARACTER, name: 'Impostor' }] },
    { ...valid, scenes: [ownScene, { ...SCENE, campaignId: OTHER_CAMPAIGN.id, title: 'Stolen' }] },
    { ...valid, scenes: [ownScene, { ...SCENE, title: 'Stolen' }] },
    { ...valid, turn: { ...ownTurn, sceneId: SCENE.id } },
    { ...valid, turn: { ...ownTurn, actorId: CHARACTER.id } },
    { ...valid, events: [{ ...ownEvent, campaignId: CAMPAIGN.id }] },
    { ...valid, events: [{ ...ownEvent, turnId: TURN.id }] },
    { ...valid, events: [{ ...ownEvent, causationId: ACTION_EVENT.id }] },
  ];
  for (const attempt of attempts) {
    assert.throws(() => store.commitTurn(attempt), CampaignBoundaryError);
    assert.deepEqual(store.load(CAMPAIGN.id), EXPECTED_STATE);
    assert.deepEqual(store.load(OTHER_CAMPAIGN.id), emptyState(OTHER_CAMPAIGN));
  }
  store.commitTurn(valid);
  assert.equal(store.load(OTHER_CAMPAIGN.id)?.revision, INITIAL_REVISION + 1);
  connection.close();
});

test('opening the same campaign after process restart yields identical identifiers and state', async () => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(dir, DATABASE_FILE);
    const first = openStore(path);
    first.store.createCampaign(CAMPAIGN);
    first.store.commitTurn(COMMIT);
    const before = first.store.load(CAMPAIGN.id);
    first.connection.close();

    const reopened = openStore(path);
    const after = reopened.store.load(CAMPAIGN.id);
    reopened.connection.close();
    assert.deepEqual(after, before);
    assert.deepEqual(after, EXPECTED_STATE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
