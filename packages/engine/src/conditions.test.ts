import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CampaignStore,
  CONDITION_APPLIED,
  CONDITION_REMOVED,
  MAIN_BRANCH,
  SCENE_OPENED,
} from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { D20_LITE_VOCABULARY } from '../../rules/src/d20-lite.ts';
import { activeConditionsOf, applyCondition, endCondition, mergeModifiers } from './conditions.ts';
import { commitSystem, InvalidActionError, type PlayerAction, performAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = { id: 'campaign-1', name: 'Hollow Lantern' };
const HERO = { id: 'hero', campaignId: CAMPAIGN.id, name: 'Hero' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Tavern' };
const WITS_CHECK = 'check.wits';
const ATTACK = 'attack.melee';
const ONE_TURN = { unit: 'turns', count: 1 } as const;
const DARKENED = { conditionId: 'darkened', reason: 'the lantern gutters out' };

const seeded = () => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  store.createCampaign(CAMPAIGN, {
    id: 'created-1',
    campaignId: CAMPAIGN.id,
    branchId: MAIN_BRANCH,
    actionId: 'create',
    type: 'CampaignCreated',
    payload: { name: CAMPAIGN.name },
  });
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'turn-0',
      campaignId: CAMPAIGN.id,
      sceneId: SCENE.id,
      actionId: 'setup',
      actorId: HERO.id,
      input: 'Begin.',
      narration: 'A lantern sways.',
    },
    characters: [HERO],
    scenes: [SCENE],
    events: [],
  });
  return { store, close: () => connection.close() };
};

const actionFor = (
  store: CampaignStore,
  actionId: string,
  input = `GM proposal condition ${actionId}`,
): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? assert.fail(),
  sceneId: SCENE.id,
  actorId: HERO.id,
  input,
  intent: `The GM records ${actionId}.`,
});

const eventsOf = (store: CampaignStore) => store.load(CAMPAIGN.id)?.events ?? assert.fail();

const policy = { vocabulary: D20_LITE_VOCABULARY, strictness: 'as-written' } as const;
const relaxed = { vocabulary: D20_LITE_VOCABULARY, strictness: 'relaxed' } as const;

test('a condition adds its modifiers to the next matching roll and then expires', () => {
  const { store, close } = seeded();
  try {
    applyCondition(store, { ...actionFor(store, 'dark'), condition: { ...DARKENED, duration: ONE_TURN }, ...relaxed });
    const active = activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK);
    assert.deepEqual(
      active.flatMap(({ modifiers }) => modifiers.map(({ id, condition }) => [id, condition])),
      [['darkness', 'darkened']],
    );
    performAction(store, actionFor(store, 'player-1', 'I try to read the map'), { noCheck: 'dice-off' });
    assert.deepEqual(activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK), []);
  } finally {
    close();
  }
});

test('a scene condition lasts until the scene changes and ends early when removed', () => {
  const { store, close } = seeded();
  try {
    applyCondition(store, { ...actionFor(store, 'dark'), condition: DARKENED, ...policy });
    performAction(store, actionFor(store, 'player-1', 'I look around'), { noCheck: 'dice-off' });
    assert.equal(activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK).length, 1);
    const events = [...eventsOf(store), { ...eventsOf(store)[0], type: SCENE_OPENED, payload: {} }] as never;
    assert.equal(activeConditionsOf(events, HERO.id, WITS_CHECK).length, 0);
    endCondition(store, { ...actionFor(store, 'light'), conditionId: DARKENED.conditionId });
    assert.equal(activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK).length, 0);
    assert.ok(eventsOf(store).some(({ type }) => type === CONDITION_REMOVED));
  } finally {
    close();
  }
});

test('a condition limited to some rules skips the others', () => {
  const { store, close } = seeded();
  try {
    const only = { ...DARKENED, conditionId: 'shaken', label: 'Shaken', appliesTo: [ATTACK], duration: ONE_TURN };
    applyCondition(store, {
      ...actionFor(store, 'shaken'),
      condition: { ...only, modifiers: [{ id: 'jitters', reason: 'hands tremble', value: -1 }] },
      vocabulary: D20_LITE_VOCABULARY,
      strictness: 'relaxed',
    });
    assert.equal(activeConditionsOf(eventsOf(store), HERO.id, ATTACK).length, 1);
    assert.equal(activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK).length, 0);
  } finally {
    close();
  }
});

test('as-written refuses a condition the rulepack does not declare', () => {
  const { store, close } = seeded();
  try {
    assert.throws(
      () =>
        applyCondition(store, {
          ...actionFor(store, 'bad'),
          condition: { conditionId: 'cursed', reason: 'a hex', duration: ONE_TURN },
          ...policy,
        }),
      InvalidActionError,
    );
    assert.equal(
      eventsOf(store).some(({ type }) => type === CONDITION_APPLIED),
      false,
    );
  } finally {
    close();
  }
});

test('replaying the event log gives the same active conditions as live state at every step', () => {
  const { store, close } = seeded();
  try {
    const steps = [
      () => applyCondition(store, { ...actionFor(store, 'dark'), condition: DARKENED, ...policy }),
      () =>
        applyCondition(store, {
          ...actionFor(store, 'hurt'),
          condition: { conditionId: 'wounded', reason: 'a cut' },
          ...policy,
        }),
      () => performAction(store, actionFor(store, 'p1', 'I look'), { noCheck: 'dice-off' }),
      () => endCondition(store, { ...actionFor(store, 'light'), conditionId: 'darkened' }),
    ];
    for (const step of steps) {
      step();
      const live = activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK);
      const replayed = activeConditionsOf(JSON.parse(JSON.stringify(eventsOf(store))), HERO.id, WITS_CHECK);
      assert.deepEqual(replayed, live);
    }
    assert.deepEqual(
      activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK).map(({ conditionId }) => conditionId),
      ['wounded'],
    );
  } finally {
    close();
  }
});

test('explicit modifiers win over a condition modifier with the same id', () => {
  const explicit = [{ id: 'darkness', reason: 'no light', effect: { kind: 'flat', value: -2 } }] as const;
  const fromCondition = [
    { id: 'darkness', reason: 'darkened', effect: { kind: 'flat', value: -2 }, condition: 'darkened' },
    { id: 'wounded', reason: 'cut', effect: { kind: 'flat', value: -1 }, condition: 'wounded' },
  ] as const;
  assert.deepEqual(
    mergeModifiers(explicit, fromCondition).map(({ id }) => id),
    ['darkness', 'wounded'],
  );
});

test('a system turn such as a sheet edit does not consume a turn-based condition', () => {
  const { store, close } = seeded();
  try {
    applyCondition(store, { ...actionFor(store, 'dark'), condition: { ...DARKENED, duration: ONE_TURN }, ...relaxed });
    commitSystem(store, actionFor(store, 'sheet-edit', 'Edit might to 4'), []);
    assert.equal(activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK).length, 1);
    performAction(store, actionFor(store, 'player-1', 'I look around'), { noCheck: 'dice-off' });
    assert.equal(activeConditionsOf(eventsOf(store), HERO.id, WITS_CHECK).length, 0);
  } finally {
    close();
  }
});

test('as-written uses the declared duration, rules and label and ignores GM overrides', () => {
  const { store, close } = seeded();
  try {
    applyCondition(store, {
      ...actionFor(store, 'dark'),
      condition: { ...DARKENED, label: 'Gloom', duration: ONE_TURN, appliesTo: [ATTACK] },
      ...policy,
    });
    const [applied] = eventsOf(store).filter(({ type }) => type === CONDITION_APPLIED);
    assert.equal(applied?.payload.label, 'Darkened');
    assert.deepEqual(applied?.payload.duration, { unit: 'scenes', count: 1 });
    assert.equal(applied?.payload.appliesTo, undefined);
  } finally {
    close();
  }
});

test('relaxed keeps the GM override for a declared condition', () => {
  const { store, close } = seeded();
  try {
    applyCondition(store, {
      ...actionFor(store, 'dark'),
      condition: { ...DARKENED, duration: ONE_TURN, appliesTo: [ATTACK] },
      vocabulary: D20_LITE_VOCABULARY,
      strictness: 'relaxed',
    });
    const [applied] = eventsOf(store).filter(({ type }) => type === CONDITION_APPLIED);
    assert.deepEqual(applied?.payload.duration, ONE_TURN);
    assert.deepEqual(applied?.payload.appliesTo, [ATTACK]);
  } finally {
    close();
  }
});
