import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, HEALING_APPLIED, StaleRevisionError } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import type { Combatant } from './damage.ts';
import { healCombatant } from './healing.ts';
import { InvalidActionError, type PlayerAction } from './turn.ts';

const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CHARACTER = { id: 'character-1', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const SETUP_REVISION = 1;
const ACTION: PlayerAction = {
  campaignId: CAMPAIGN.id,
  actionId: 'heal-1',
  expectedRevision: SETUP_REVISION,
  sceneId: SCENE.id,
  actorId: CHARACTER.id,
  input: 'GM proposal heal',
  intent: 'heal',
};
const WOUNDED: Combatant = { id: CHARACTER.id, name: 'Mara', defense: 10, current: 3, max: 9 };
const MISSING = WOUNDED.max - WOUNDED.current;
const SELECT_VISIBILITY = 'SELECT visibility FROM event_log WHERE id = ?';

const openStore = () => {
  const connection = openDatabase(':memory:');
  const store: CampaignStore = createCampaignStore(connection.database);
  store.createCampaign(CAMPAIGN, {
    id: 'created-1',
    campaignId: CAMPAIGN.id,
    branchId: 'main',
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
      actorId: CHARACTER.id,
      input: 'Begin.',
      narration: 'A lantern sways.',
    },
    characters: [CHARACTER],
    scenes: [SCENE],
    events: [],
  });
  return { store, database: connection.database, close: () => connection.close() };
};

test('a heal commits a player-visible HealingApplied event for the target and amount', () => {
  const { store, database, close } = openStore();
  const committed = healCombatant(store, { ...ACTION, target: WOUNDED, amount: MISSING });
  const healed = committed.events.find(({ type }) => type === HEALING_APPLIED);
  assert.deepEqual(healed?.payload, { targetId: WOUNDED.id, amount: MISSING });
  assert.equal(database.prepare(SELECT_VISIBILITY).get(String(healed?.id))?.visibility, 'player');
  assert.deepEqual(healCombatant(store, { ...ACTION, target: WOUNDED, amount: MISSING }).events, committed.events);
  close();
});

test('a heal that is not a whole number from one up to the missing hit points is refused', () => {
  const { store, close } = openStore();
  for (const amount of [0, -1, 1.5, Number.NaN, MISSING + 1])
    assert.throws(() => healCombatant(store, { ...ACTION, target: WOUNDED, amount }), InvalidActionError);
  const full = { ...WOUNDED, current: WOUNDED.max };
  assert.throws(() => healCombatant(store, { ...ACTION, target: full, amount: 1 }), InvalidActionError);
  assert.equal(store.load(CAMPAIGN.id)?.revision, SETUP_REVISION);
  close();
});

test('a heal against a stale revision is refused', () => {
  const { store, close } = openStore();
  assert.throws(
    () => healCombatant(store, { ...ACTION, expectedRevision: 0, target: WOUNDED, amount: 1 }),
    StaleRevisionError,
  );
  close();
});
