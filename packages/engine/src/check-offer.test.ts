import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, CHECK_OFFERED, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { D20_LITE_VOCABULARY } from '../../rules/src/d20-lite.ts';
import { playTurns } from './character.ts';
import { type CheckOffer, offerCheck, pendingCheckOffer } from './check-offer.ts';
import { ActionIdConflictError, type PlayerAction, performAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const CAMPAIGN = { id: 'campaign-1', name: 'Hollow Lantern' };
const HERO = { id: 'hero', campaignId: CAMPAIGN.id, name: 'Hero' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Tavern' };
const OFFER: CheckOffer = { offerId: 'tam-attack', ruleId: 'attack.melee', target: 'Old Tam', label: 'Attack Old Tam' };
const OTHER_OFFER: CheckOffer = { ...OFFER, offerId: 'tam-grab', ruleId: 'check.might' };

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

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? assert.fail(),
  sceneId: SCENE.id,
  actorId: HERO.id,
  input: `GM check ${actionId}`,
  intent: `GM check ${actionId}`,
});

const eventsOf = (store: CampaignStore) => store.load(CAMPAIGN.id)?.events ?? assert.fail();

test('rpg-42a.74: an offered check is pending until a check resolves', () => {
  const { store, close } = seeded();
  try {
    assert.equal(pendingCheckOffer(eventsOf(store)), undefined);
    offerCheck(store, { ...actionFor(store, 'offer-1'), offer: OFFER });
    assert.deepEqual(pendingCheckOffer(eventsOf(store)), OFFER);
    performAction(store, actionFor(store, 'roll-1'), () => ({ rolls: [], events: [] }));
    assert.equal(pendingCheckOffer(eventsOf(store)), undefined);
  } finally {
    close();
  }
});

test('rpg-42a.74: a newer offer replaces the pending one', () => {
  const { store, close } = seeded();
  try {
    offerCheck(store, { ...actionFor(store, 'offer-1'), offer: OFFER });
    offerCheck(store, { ...actionFor(store, 'offer-2'), offer: OTHER_OFFER });
    assert.deepEqual(pendingCheckOffer(eventsOf(store)), OTHER_OFFER);
  } finally {
    close();
  }
});

test('rpg-42a.74: the offer turn is not a play turn and replays by action id', () => {
  const { store, close } = seeded();
  try {
    const first = offerCheck(store, { ...actionFor(store, 'offer-1'), offer: OFFER });
    assert.ok(first.events.some(({ type }) => type === CHECK_OFFERED));
    assert.equal(playTurns(store.load(CAMPAIGN.id) ?? assert.fail()).length, 1);
    const again = offerCheck(store, { ...actionFor(store, 'offer-1'), offer: OFFER });
    assert.equal(again.turn.id, first.turn.id);
    assert.throws(
      () => offerCheck(store, { ...actionFor(store, 'offer-1'), offer: OTHER_OFFER }),
      ActionIdConflictError,
    );
  } finally {
    close();
  }
});

test('rpg-42a.90: a retried offer with modifiers returns the stored turn without validating again', () => {
  const { store, close } = seeded();
  try {
    const request = {
      ...actionFor(store, 'offer-1'),
      offer: { ...OFFER, ruleId: 'check.wits' },
      requested: [{ id: 'darkness', reason: 'no light' }],
      policy: { vocabulary: D20_LITE_VOCABULARY, strictness: 'as-written' },
    } as const;
    const first = offerCheck(store, request);
    const { policy: _policy, ...unpolicied } = request;
    const retry = offerCheck(store, unpolicied);
    assert.equal(retry.turn.id, first.turn.id);
    assert.equal(eventsOf(store).filter(({ type }) => type === CHECK_OFFERED).length, 1);
  } finally {
    close();
  }
});

test('rpg-42a.153: a turn that accepts an offer exposes the offer id on the play turn', () => {
  const { store, close } = seeded();
  performAction(store, actionFor(store, 'typed'));
  offerCheck(store, { ...actionFor(store, 'offer-1'), offer: OFFER });
  performAction(store, { ...actionFor(store, 'accepted'), rollOfferId: OFFER.offerId });
  const turns = playTurns(store.load(CAMPAIGN.id) ?? assert.fail());
  assert.deepEqual(
    turns
      .filter(({ actionId }) => actionId === 'typed' || actionId === 'accepted')
      .map(({ rollOfferId }) => rollOfferId),
    [undefined, OFFER.offerId],
  );
  close();
});
