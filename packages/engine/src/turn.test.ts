import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAMPAIGN_CONFIGURED,
  CAMPAIGN_PITCHED,
  CampaignNotFoundError,
  type CampaignStore,
  DAMAGE_APPLIED,
  StaleRevisionError,
} from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createRoller, createSeededRng, type Rng } from '../../rules/src/dice.ts';
import { createEngine } from './engine.ts';
import {
  ActionIdConflictError,
  CHECK_RESOLVED,
  type Check,
  campaignConfigOf,
  campaignPitchOf,
  InvalidActionError,
  openScene,
  type PlayerAction,
  performAction,
} from './turn.ts';

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
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};

const openEngineStore = () => {
  const connection = openDatabase(IN_MEMORY);
  const store: CampaignStore = createCampaignStore(connection.database);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [CHARACTER], scenes: [SCENE], events: [] });
  return { store, database: connection.database, close: () => connection.close() };
};

const CHECK_SEED = 7;
const D20 = { dice: [{ count: 1, sides: 20 }], modifier: 0 };
const SELECT_VISIBILITY = 'SELECT visibility FROM event_log WHERE id = ?';

const d20Check =
  (calls: string[]): Check =>
  (actionId: string, rng: Rng) => {
    calls.push(actionId);
    const rolled = createRoller(rng)(`${actionId}:d20`, D20);
    if (!rolled.ok) throw new Error('roll failed');
    return { rolls: [rolled.roll], events: [] };
  };

test('an action with a check resolves its roll in the same turn and shows it to the player', () => {
  const { store, database, close } = openEngineStore();
  const calls: string[] = [];
  const engine = createEngine(store, createSeededRng(CHECK_SEED));
  const committed = engine.submitAction(ACTION, d20Check(calls));
  const resolved = committed.events.at(-1);
  const expected = createRoller(createSeededRng(CHECK_SEED))(`${ACTION.actionId}:d20`, D20);
  assert.ok(expected.ok);
  assert.deepEqual(
    committed.events.map(({ type }) => type),
    ['PlayerActionSubmitted', 'ActionValidated', CHECK_RESOLVED],
  );
  assert.equal(resolved?.causationId, committed.events[1]?.id);
  assert.deepEqual(JSON.parse(JSON.stringify(resolved?.payload)), {
    resolution: { ok: true, rolls: [JSON.parse(JSON.stringify(expected.roll))], events: [] },
  });
  assert.equal(database.prepare(SELECT_VISIBILITY).get(String(resolved?.id))?.visibility, 'player');
  assert.equal(database.prepare(SELECT_VISIBILITY).get(String(committed.events[0]?.id))?.visibility, 'gm');
  assert.equal(store.load(CAMPAIGN.id)?.revision, SETUP_REVISION + 1);

  assert.deepEqual(
    engine.submitAction(ACTION, d20Check(calls)).events.map(({ id }) => id),
    committed.events.map(({ id }) => id),
  );
  assert.deepEqual(calls, [ACTION.actionId]);
  close();
});

test('a check that deals damage commits a DamageApplied event the player sees, after the roll', () => {
  const { store, database, close } = openEngineStore();
  const dealt = { targetId: 'npc-warden', amount: 4, defeated: false };
  const committed = performAction(store, ACTION, () => ({ rolls: [], events: [], damage: dealt }));
  assert.deepEqual(
    committed.events.map(({ type }) => type),
    ['PlayerActionSubmitted', 'ActionValidated', CHECK_RESOLVED, DAMAGE_APPLIED],
  );
  const [resolved, damaged] = committed.events.slice(-2);
  assert.equal(JSON.stringify(resolved?.payload).includes('damage'), false);
  assert.deepEqual(damaged?.payload, dealt);
  assert.equal(damaged?.causationId, resolved?.id);
  assert.equal(database.prepare(SELECT_VISIBILITY).get(String(damaged?.id))?.visibility, 'player');
  const miss = performAction(store, { ...ACTION, actionId: 'action-2', expectedRevision: SETUP_REVISION + 1 }, () => ({
    rolls: [],
    events: [],
    damage: { ...dealt, amount: 0 },
  }));
  assert.equal(
    miss.events.some(({ type }) => type === DAMAGE_APPLIED),
    false,
  );
  close();
});

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

test('a repeated action id with a different action is rejected without writing', () => {
  const { store, close } = openEngineStore();
  performAction(store, ACTION);
  const before = store.load(CAMPAIGN.id);
  const conflicts: PlayerAction[] = [
    { ...ACTION, input: 'I look for the harbour master.' },
    { ...ACTION, intent: 'Mara waits for the ferryman.' },
    { ...ACTION, actorId: 'character-2' },
    { ...ACTION, sceneId: 'scene-2' },
    { ...ACTION, actionId: SETUP_TURN.actionId, expectedRevision: SETUP_REVISION + 1 },
  ];
  for (const action of conflicts) {
    assert.throws(() => performAction(store, action), ActionIdConflictError, action.actionId);
    assert.deepEqual(store.load(CAMPAIGN.id), before);
  }
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

const OPENING = {
  campaignId: CAMPAIGN.id,
  actorName: CHARACTER.name,
  sceneTitle: SCENE.title,
  narration: SETUP_TURN.narration,
};

const openCreatedStore = (): { store: CampaignStore; close: () => void } => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  return { store, close: () => connection.close() };
};

test('opening a scene commits the character, scene and opening turn with an event', () => {
  const { store, close } = openCreatedStore();
  const { turn, events } = openScene(store, OPENING);
  const state = store.load(CAMPAIGN.id);
  assert.equal(state?.revision, SETUP_REVISION);
  assert.deepEqual(
    state?.characters.map(({ campaignId, name }) => ({ campaignId, name })),
    [{ campaignId: CAMPAIGN.id, name: CHARACTER.name }],
  );
  assert.equal(state?.currentScene?.title, SCENE.title);
  assert.deepEqual(state?.turns, [turn]);
  assert.equal(turn.narration, SETUP_TURN.narration);
  assert.equal(turn.actorId, state?.characters[0]?.id);
  assert.equal(turn.sceneId, state?.currentScene?.id);
  assert.deepEqual(state?.events, events);
  assert.deepEqual(
    events.map(({ type, turnId, causationId }) => ({ type, turnId, causationId })),
    [{ type: 'SceneOpened', turnId: turn.id, causationId: null }],
  );
  performAction(store, { ...ACTION, sceneId: turn.sceneId, actorId: turn.actorId });
  assert.equal(store.load(CAMPAIGN.id)?.revision, SETUP_REVISION + 1);
  close();
});

test('opening a scene with a campaign config records CampaignConfigured in the same turn', () => {
  const { store, close } = openCreatedStore();
  const config = { genre: { id: 'horror', version: '1.0.0' } };
  const { turn, events } = openScene(store, { ...OPENING, config });
  assert.deepEqual(
    events.map(({ type, turnId, causationId }) => ({ type, turnId, causationId })),
    [
      { type: 'SceneOpened', turnId: turn.id, causationId: null },
      { type: CAMPAIGN_CONFIGURED, turnId: turn.id, causationId: events[0]?.id },
    ],
  );
  const state = store.load(CAMPAIGN.id);
  assert.equal(state?.revision, SETUP_REVISION);
  assert.deepEqual(campaignConfigOf(state?.events ?? []), config);
  close();
});

test('a campaign opened without config has no saved config', () => {
  const { store, close } = openCreatedStore();
  openScene(store, OPENING);
  assert.equal(campaignConfigOf(store.load(CAMPAIGN.id)?.events ?? []), undefined);
  close();
});

test('opening a scene rejects missing campaigns, blank fields and a second opening without writing', () => {
  const { store, close } = openCreatedStore();
  assert.throws(() => openScene(store, { ...OPENING, campaignId: 'missing' }), CampaignNotFoundError);
  for (const blank of [{ actorName: BLANK }, { sceneTitle: BLANK }, { narration: BLANK }]) {
    assert.throws(() => openScene(store, { ...OPENING, ...blank }), InvalidActionError);
  }
  assert.equal(store.load(CAMPAIGN.id)?.revision, 0);
  openScene(store, OPENING);
  const opened = store.load(CAMPAIGN.id);
  assert.throws(() => openScene(store, OPENING), InvalidActionError);
  assert.deepEqual(store.load(CAMPAIGN.id), opened);
  close();
});

const OLD_ACTIONS = 205;

test('an action id older than the in-memory window still replays and still conflicts', () => {
  const { store, close } = openEngineStore();
  const engine = createEngine(store);
  const actionAt = (index: number): PlayerAction => ({
    ...ACTION,
    actionId: `old-${index}`,
    expectedRevision: SETUP_REVISION + index,
    input: `step ${index}`,
    intent: `step ${index}`,
  });
  const first = engine.submitAction(actionAt(0));
  for (let index = 1; index < OLD_ACTIONS; index++) engine.submitAction(actionAt(index));
  assert.ok(!store.load(CAMPAIGN.id)?.turns.some(({ actionId }) => actionId === 'old-0'));
  assert.deepEqual(engine.submitAction(actionAt(0)), first);
  assert.throws(() => engine.submitAction({ ...actionAt(0), input: 'something else' }), ActionIdConflictError);
  close();
});

test('rpg-cm63.41 opening a scene records the location kind and mood tags on the scene and its event', () => {
  const { store, close } = openCreatedStore();
  const tags = { locationKind: 'tavern', moodTags: ['tense', 'rain'] };
  const { events } = openScene(store, { ...OPENING, ...tags });
  const { currentScene } = store.load(CAMPAIGN.id) ?? {};
  assert.equal(currentScene?.locationKind, tags.locationKind);
  assert.deepEqual(currentScene?.moodTags, tags.moodTags);
  assert.equal(events[0]?.payload.locationKind, tags.locationKind);
  assert.deepEqual(events[0]?.payload.moodTags, tags.moodTags);
  close();
});

test('rpg-cm63.41 opening a scene without tags leaves them off the scene', () => {
  const { store, close } = openCreatedStore();
  openScene(store, OPENING);
  assert.deepEqual(Object.keys(store.load(CAMPAIGN.id)?.currentScene ?? {}).sort(), ['campaignId', 'id', 'title']);
  close();
});

test('rpg-42a.66 opening a scene with a pitch records the full pitch in the same turn', () => {
  const { store, close } = openCreatedStore();
  const pitch = 'a drowned chapel '.repeat(60).trim();
  const { events } = openScene(store, { ...OPENING, pitch });
  assert.deepEqual(
    events.map(({ type }) => type),
    ['SceneOpened', CAMPAIGN_PITCHED],
  );
  assert.equal(campaignPitchOf(store.load(CAMPAIGN.id)?.events ?? []), pitch);
  close();
});

test('rpg-42a.66 a campaign opened without a pitch has none', () => {
  const { store, close } = openCreatedStore();
  openScene(store, OPENING);
  assert.equal(campaignPitchOf(store.load(CAMPAIGN.id)?.events ?? []), undefined);
  close();
});
