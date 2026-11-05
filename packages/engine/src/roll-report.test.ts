import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, CHECK_RESOLVED, MAIN_BRANCH, ROLL_REPORTED } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createRoller } from '../../rules/src/dice.ts';
import { RollReportError, reportedCheck, rollExpressionOf } from './roll-report.ts';
import { type PlayerAction, performAction } from './turn.ts';

const CAMPAIGN = { id: 'campaign-1', name: 'Hollow Lantern' };
const HERO = { id: 'hero', campaignId: CAMPAIGN.id, name: 'Hero' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Tavern' };
const BONUS = 1;
const TWO_D6 = { dice: [{ count: 2, sides: 6 }], modifier: 0 };
const ONE_D20 = { dice: [{ count: 1, sides: 20 }], modifier: 0 };

const checkOf = (pool: typeof TWO_D6) => (actionId: string, rng: () => number) => {
  const rolled = createRoller(rng)(`${actionId}-roll`, pool);
  if (!rolled.ok) throw new RangeError('bad pool');
  return { rolls: [rolled.roll], events: [{ event: 'check.success' }], bonus: BONUS };
};

const seeded = () => {
  const connection = openDatabase(':memory:');
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

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? assert.fail(),
  sceneId: SCENE.id,
  actorId: HERO.id,
  input: 'I rolled',
  intent: 'I rolled',
});

test('rpg-42a.83: the dice expression of a check comes from its pool', () => {
  assert.equal(rollExpressionOf(checkOf(TWO_D6)), '2d6');
  assert.equal(rollExpressionOf(checkOf(ONE_D20)), '1d20');
});

test('rpg-42a.83: an in-range report resolves the check with the modifier applied', () => {
  const { store, close } = seeded();
  try {
    const committed = performAction(store, actionFor(store, 'a-1'), reportedCheck(checkOf(TWO_D6), [9]));
    const types = committed.events.map(({ type }) => type);
    assert.deepEqual(types.slice(-2), [ROLL_REPORTED, CHECK_RESOLVED]);
    const reported = committed.events.find(({ type }) => type === ROLL_REPORTED);
    assert.deepEqual(reported?.payload, { values: [9], source: 'player' });
    const resolution = committed.events.find(({ type }) => type === CHECK_RESOLVED)?.payload.resolution as {
      source: string;
      bonus: number;
      rolls: { total: number; draws: number[][] }[];
    };
    assert.equal(resolution.source, 'player');
    assert.equal(resolution.rolls[0]?.total, 9);
    assert.equal(
      resolution.rolls[0]?.draws.flat().reduce((a, b) => a + b, 0),
      9,
    );
  } finally {
    close();
  }
});

test('rpg-42a.83: per-die faces are accepted and recorded as drawn', () => {
  const { store, close } = seeded();
  try {
    const committed = performAction(store, actionFor(store, 'a-1'), reportedCheck(checkOf(TWO_D6), [2, 6]));
    const resolution = committed.events.find(({ type }) => type === CHECK_RESOLVED)?.payload.resolution as {
      rolls: { draws: number[][] }[];
    };
    assert.deepEqual(resolution.rolls[0]?.draws, [[2, 6]]);
  } finally {
    close();
  }
});

test('rpg-42a.83: out-of-range reports are rejected with a localizable key and write nothing', () => {
  const { store, close } = seeded();
  try {
    for (const bad of [[1], [13], [0, 6], [7, 1], [2.5], [], [3, 3, 3], [Number.NaN]]) {
      assert.throws(
        () => performAction(store, actionFor(store, 'a-1'), reportedCheck(checkOf(TWO_D6), bad)),
        (error: unknown) =>
          error instanceof RollReportError &&
          error.key === 'rollReport.outOfRange' &&
          error.params.expression === '2d6' &&
          error.params.min === 2 &&
          error.params.max === 12,
      );
    }
    assert.equal(
      store.load(CAMPAIGN.id)?.events.some(({ type }) => type === ROLL_REPORTED),
      false,
    );
  } finally {
    close();
  }
});

test('rpg-42a.83: replay of a reported roll is deterministic and ignores the rng', () => {
  const { store, close } = seeded();
  try {
    const first = performAction(store, actionFor(store, 'a-1'), reportedCheck(checkOf(ONE_D20), [17]), () => 0);
    const resolved = first.events.find(({ type }) => type === CHECK_RESOLVED) ?? assert.fail();
    const stored = (resolved.payload.resolution as { rolls: unknown[] }).rolls;
    const again = performAction(store, { ...actionFor(store, 'a-1'), expectedRevision: 0 }, undefined);
    assert.equal(again.turn.id, first.turn.id);
    const rebuilt = reportedCheck(checkOf(ONE_D20), [17])('a-1', () => 0.99);
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt.rolls)), JSON.parse(JSON.stringify(stored)));
  } finally {
    close();
  }
});

test('rpg-42a.83: without a RulePack a report is recorded alone', () => {
  const { store, close } = seeded();
  try {
    const committed = performAction(store, actionFor(store, 'a-1'), { reportedRoll: [17] });
    const types = committed.events.map(({ type }) => type);
    assert.ok(types.includes(ROLL_REPORTED));
    assert.equal(types.includes(CHECK_RESOLVED), false);
  } finally {
    close();
  }
});
