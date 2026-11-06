import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, GM_ROLLED, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore } from '../../persistence/src/entity-store.ts';
import { listScopedEvents } from '../../persistence/src/event-store.ts';
import { D20_LITE_VOCABULARY } from '../../rules/src/d20-lite.ts';
import { createSeededRng, replayRoll } from '../../rules/src/dice.ts';
import { playTurns } from './character.ts';
import { applyCondition } from './conditions.ts';
import {
  GM_ROLLER,
  type GmRollRequest,
  MAX_ROLL_EXPRESSION_LENGTH,
  MAX_ROLL_REASON_LENGTH,
  MAX_ROLL_SECTION_LENGTH,
  PLAYER_ROLLER,
  rollForGm,
} from './gm-roll.ts';
import { ActionIdConflictError, InvalidActionError, type PlayerAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const SEED = 42;
const CAMPAIGN = { id: 'campaign-1', name: 'Hollow Lantern' };
const HERO = { id: 'hero', campaignId: CAMPAIGN.id, name: 'Hero' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Tavern' };
const TAM = { id: 'old-tam', kind: 'npc', name: 'Old Tam', data: {}, visibility: 'player', actorId: null } as const;
const INN = { id: 'inn', kind: 'location', name: 'The Inn', data: {}, visibility: 'player', actorId: null } as const;
const ATTACK: GmRollRequest = {
  roller: TAM.id,
  reason: 'Tam swings his cudgel',
  visibility: 'shown',
  expression: '1d20+3',
};

const seeded = () => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  const entities = createEntityStore(connection.database);
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
  entities.saveEntity({ ...TAM, campaignId: CAMPAIGN.id });
  entities.saveEntity({ ...INN, campaignId: CAMPAIGN.id });
  return { store, entities, database: connection.database, close: () => connection.close() };
};

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? assert.fail(),
  sceneId: SCENE.id,
  actorId: HERO.id,
  input: `GM proposal gm-roll ${actionId}`,
  intent: `The GM rolls ${actionId}.`,
});

test('rpg-42a.89: an NPC roll is recorded with its roller, name, reason and the engine dice', () => {
  const { store, entities, close } = seeded();
  try {
    const committed = rollForGm(
      store,
      entities,
      { ...actionFor(store, 'roll-1'), gmRoll: ATTACK },
      createSeededRng(SEED),
    );
    const event = committed.events.find(({ type }) => type === GM_ROLLED) ?? assert.fail();
    assert.equal(event.payload.roller, TAM.id);
    assert.equal(event.payload.rollerName, TAM.name);
    assert.equal(event.payload.reason, ATTACK.reason);
    assert.equal(event.payload.visibility, 'shown');
    const { resolution } = event.payload as { resolution: { rolls: unknown[] } };
    const replayed = replayRoll(resolution.rolls[0]);
    assert.ok(replayed.ok);
    assert.equal(replayed.event.pool.modifier, 3);
    assert.equal(replayed.event.pool.dice[0]?.sides, 20);
    assert.equal(playTurns(store.load(CAMPAIGN.id) ?? assert.fail()).length, 1);
  } finally {
    close();
  }
});

test('rpg-42a.89: a secret roll is stored GM-only and a shown roll is player-visible', () => {
  const { store, entities, database, close } = seeded();
  try {
    rollForGm(
      store,
      entities,
      { ...actionFor(store, 'secret'), gmRoll: { ...ATTACK, visibility: 'secret' } },
      createSeededRng(SEED),
    );
    rollForGm(store, entities, { ...actionFor(store, 'shown'), gmRoll: ATTACK }, createSeededRng(SEED));
    const rolled = listScopedEvents(database, CAMPAIGN.id, { type: GM_ROLLED });
    assert.deepEqual(
      rolled.map(({ visibility }) => visibility),
      ['gm', 'player'],
    );
  } finally {
    close();
  }
});

test('rpg-42a.89: the GM may roll for itself and the roller carries no NPC name', () => {
  const { store, entities, close } = seeded();
  try {
    const { events } = rollForGm(
      store,
      entities,
      { ...actionFor(store, 'table'), gmRoll: { ...ATTACK, roller: GM_ROLLER, expression: '1d6' } },
      createSeededRng(SEED),
    );
    const payload = events.find(({ type }) => type === GM_ROLLED)?.payload ?? assert.fail();
    assert.equal(payload.roller, GM_ROLLER);
    assert.equal('rollerName' in payload, false);
  } finally {
    close();
  }
});

test('rpg-42a.89: the same seed gives the same roll and a repeated action id does not roll again', () => {
  const totals = [1, 2].map(() => {
    const { store, entities, close } = seeded();
    try {
      const request = { ...actionFor(store, 'roll-1'), gmRoll: ATTACK };
      const first = rollForGm(store, entities, request, createSeededRng(SEED));
      const again = rollForGm(store, entities, request, createSeededRng(SEED + 1));
      assert.equal(again.turn.id, first.turn.id);
      return JSON.stringify(first.events.find(({ type }) => type === GM_ROLLED)?.payload);
    } finally {
      close();
    }
  });
  assert.equal(totals[0], totals[1]);
  assert.throws(() => {
    const { store, entities, close } = seeded();
    try {
      rollForGm(store, entities, { ...actionFor(store, 'roll-1'), gmRoll: ATTACK }, createSeededRng(SEED));
      rollForGm(
        store,
        entities,
        { ...actionFor(store, 'roll-1'), gmRoll: { ...ATTACK, expression: '1d8' } },
        createSeededRng(SEED),
      );
    } finally {
      close();
    }
  }, ActionIdConflictError);
});

test('rpg-42a.89: an unknown roller, a non-NPC roller and a bad expression are refused', () => {
  const { store, entities, close } = seeded();
  try {
    for (const gmRoll of [
      { ...ATTACK, roller: 'nobody' },
      { ...ATTACK, roller: INN.id },
      { ...ATTACK, expression: 'roll 1d20' },
      { ...ATTACK, reason: ' ' },
      { ...ATTACK, reason: 'x'.repeat(MAX_ROLL_REASON_LENGTH + 1) },
      { ...ATTACK, expression: `1d20${'+1'.repeat(MAX_ROLL_EXPRESSION_LENGTH)}` },
    ]) {
      assert.throws(
        () => rollForGm(store, entities, { ...actionFor(store, 'bad'), gmRoll }, createSeededRng(SEED)),
        InvalidActionError,
      );
    }
    assert.equal(
      store.load(CAMPAIGN.id)?.events.some(({ type }) => type === GM_ROLLED),
      false,
    );
  } finally {
    close();
  }
});

test('rpg-42a.82: a player roll is never secret and a rule section has a length limit', () => {
  const { store, entities, close } = seeded();
  try {
    const roll = (actionId: string, gmRoll: GmRollRequest) => () =>
      rollForGm(store, entities, { ...actionFor(store, actionId), gmRoll }, createSeededRng(SEED));
    const player = { ...ATTACK, roller: PLAYER_ROLLER, expression: '2d6' };
    assert.throws(roll('secret-player', { ...player, visibility: 'secret' }), InvalidActionError);
    assert.throws(
      roll('long-section', { ...player, section: 'x'.repeat(MAX_ROLL_SECTION_LENGTH + 1) }),
      InvalidActionError,
    );
    const { events } = roll('fine', { ...player, section: 'x'.repeat(MAX_ROLL_SECTION_LENGTH) })();
    assert.equal(events.find(({ type }) => type === GM_ROLLED)?.payload.roller, PLAYER_ROLLER);
  } finally {
    close();
  }
});

const MELEE_SECTION = 'attack.melee';
const DARKENED_FLAT = -2;
const BASE_MODIFIER = 3;
const relaxed = { vocabulary: D20_LITE_VOCABULARY, strictness: 'relaxed' } as const;

test('rpg-42a.104: a roll takes the conditions of the rolling actor that apply to its section', () => {
  const { store, entities, close } = seeded();
  try {
    applyCondition(store, {
      ...actionFor(store, 'dark'),
      condition: { conditionId: 'darkened', reason: 'the lantern gutters out', appliesTo: [MELEE_SECTION] },
      ...relaxed,
    });
    const roll = (actionId: string, section?: string, policy?: typeof relaxed) =>
      rollForGm(
        store,
        entities,
        {
          ...actionFor(store, actionId),
          gmRoll: { ...ATTACK, roller: PLAYER_ROLLER, ...(section === undefined ? {} : { section }) },
        },
        createSeededRng(SEED),
        policy,
      );
    const resolutionOf = (events: readonly { type: string; payload: Record<string, unknown> }[]) =>
      events.find(({ type }) => type === GM_ROLLED)?.payload.resolution as {
        modifiers?: { id: string }[];
        rolls: unknown[];
      };
    const hit = resolutionOf(roll('hit', MELEE_SECTION, relaxed).events);
    assert.deepEqual(
      hit.modifiers?.map(({ id }) => id),
      ['darkness'],
    );
    const replayed = replayRoll(hit.rolls[0]);
    assert.ok(replayed.ok);
    assert.equal(replayed.event.pool.modifier, BASE_MODIFIER + DARKENED_FLAT);
    assert.equal(resolutionOf(roll('other', 'check.wits', relaxed).events).modifiers, undefined);
    assert.equal(resolutionOf(roll('no-policy', MELEE_SECTION).events).modifiers, undefined);
  } finally {
    close();
  }
});

test('rpg-42a.144: a condition on an npc modifies only that npc and player conditions skip npc and gm rolls', () => {
  const { store, entities, close } = seeded();
  try {
    applyCondition(
      store,
      {
        ...actionFor(store, 'npc-dark'),
        condition: { conditionId: 'darkened', reason: 'blinded', appliesTo: [MELEE_SECTION], targetId: TAM.id },
        ...relaxed,
      },
      entities,
    );
    applyCondition(
      store,
      {
        ...actionFor(store, 'hero-dark'),
        condition: { conditionId: 'darkened', reason: 'lantern out', appliesTo: [MELEE_SECTION] },
        ...relaxed,
      },
      entities,
    );
    const modifierOf = (actionId: string, roller: string) => {
      const { events } = rollForGm(
        store,
        entities,
        { ...actionFor(store, actionId), gmRoll: { ...ATTACK, roller, section: MELEE_SECTION } },
        createSeededRng(SEED),
        relaxed,
      );
      const { resolution } = (events.find(({ type }) => type === GM_ROLLED) ?? assert.fail()).payload as {
        resolution: { rolls: unknown[] };
      };
      const replayed = replayRoll(resolution.rolls[0]);
      return replayed.ok ? replayed.event.pool.modifier : assert.fail();
    };
    assert.equal(modifierOf('npc-roll', TAM.id), BASE_MODIFIER + DARKENED_FLAT);
    assert.equal(modifierOf('gm-roll', GM_ROLLER), BASE_MODIFIER);
    assert.equal(modifierOf('player-roll', PLAYER_ROLLER), BASE_MODIFIER + DARKENED_FLAT);
    const target = (actionId: string, targetId: string) => () =>
      applyCondition(
        store,
        {
          ...actionFor(store, actionId),
          condition: { conditionId: 'darkened', reason: 'x', targetId },
          ...relaxed,
        },
        entities,
      );
    assert.throws(target('bad-loc', INN.id), InvalidActionError);
    assert.throws(target('bad-unknown', 'nobody'), InvalidActionError);
    entities.saveEntity({
      ...TAM,
      id: 'hidden-brute',
      name: 'Hidden Brute',
      visibility: 'gm',
      campaignId: CAMPAIGN.id,
    });
    assert.throws(target('bad-hidden', 'hidden-brute'), InvalidActionError);
  } finally {
    close();
  }
});
