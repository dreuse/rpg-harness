import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampaignBoundaryError, type DomainEvent, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { commitCharacter } from '../../engine/src/character.ts';
import { actInEncounter, currentEncounter, resolveEncounter, startEncounter } from '../../engine/src/encounter.ts';
import { createEngine } from '../../engine/src/engine.ts';
import { openScene, type PlayerAction } from '../../engine/src/turn.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEventStore } from '../../persistence/src/event-store.ts';
import type { BuildInput } from '../../rules/src/character-builder.ts';
import type { RollEvent } from '../../rules/src/dice.ts';
import { type EffectiveMechanic, RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { SHEET_SCHEMA_VERSION } from '../../rules/src/sheet-schema.ts';
import { createScriptedRng } from '../../testkit/src/fixtures.ts';
import { CAMPAIGN_PROJECTION_VERSION, campaignProjection, RecordedRollError } from './campaign.ts';
import { checkpoint, EventOrderError, type Projection, replay, SnapshotMismatchError } from './replay.ts';

const IN_MEMORY = ':memory:';
const NAME = 'Harbor Lights';
const NEW_NAME = 'Harbor Lights Reborn';
const FORGED_NAME = 'Forged Cache';
const DIE_SIDES = 6;
const SKILL = 2;
const FIRST_DRAW = 0.5;
const SECOND_DRAW = 0.9;
const FIRST_FACE = 4;
const SECOND_FACE = 6;
const DRAWS = [FIRST_DRAW, SECOND_DRAW];
const OUTCOME = 'The ferryman yields the oar.';
const SIDE_BRANCH = 'branch-what-if';
const OTHER_CAMPAIGN = 'campaign-other';
const ROLL_PATH = 'resolution';
const NO_EVENTS = 0;
const CREATED_NAME = 'Mara of the Tides';
const BUILD: BuildInput = {
  rules: {
    schema: {
      schemaVersion: SHEET_SCHEMA_VERSION,
      rulepack: { id: 'harbor-rules', edition: 'first', revision: '1', sourceRefs: [] },
      fields: [],
    },
    constraints: [],
    startingEquipment: [],
    overridableFields: [],
  },
  backstory: 'A ferryman’s daughter.',
  proposal: { name: CREATED_NAME, values: {}, equipment: [] },
};
const RULE: RuleDsl = {
  dslVersion: RULE_DSL_VERSION,
  id: 'contest',
  effects: [
    {
      kind: 'setTrait',
      trait: 'outcome',
      value: {
        kind: 'arith',
        op: 'add',
        left: { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 },
        right: { kind: 'ref', id: 'skill' },
      },
    },
  ],
};

const RULE_PACK = { id: 'harbor-rules', edition: 'first', revision: '1' };
const CONTEST: EffectiveMechanic = {
  ruleId: RULE.id,
  rulePack: RULE_PACK,
  source: { kind: 'rulepack', sourceRef: RULE.id, revision: RULE_PACK.revision },
  kind: 'deterministic',
  rule: {
    rule: RULE,
    rulePack: RULE_PACK,
    sourceRefs: [RULE.id],
    primitives: [],
    adjudicated: [],
    deterministic: true,
  },
};

const playSession = () => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  const engine = createEngine(store);
  const campaign = engine.createCampaign(NAME);
  const opened = openScene(store, {
    campaignId: campaign.id,
    actorName: 'Mara',
    sceneTitle: 'The Dock at Dusk',
    narration: 'A lantern sways at the end of the pier.',
  });
  engine.renameCampaign(campaign.id, NEW_NAME);
  const actorId = opened.turn.actorId;
  const action = (actionId: string): PlayerAction => ({
    campaignId: campaign.id,
    actionId,
    expectedRevision: engine.getState(campaign.id).revision,
    sceneId: opened.turn.sceneId,
    actorId,
    input: 'Mara acts.',
    intent: 'Mara makes a move.',
  });
  engine.submitAction(action('look'));
  const sheet = {
    characterId: actorId,
    traits: [
      { id: 'skill', kind: 'trait' as const, value: SKILL },
      { id: 'outcome', kind: 'trait' as const, value: 0 },
    ],
  };
  const rules = { rulePack: RULE_PACK, mechanics: [CONTEST] };
  startEncounter(store, { ...action('start'), participants: [actorId], rules, sheets: [sheet] });
  const acts = DRAWS.map((draw, index) =>
    actInEncounter(store, { ...action(`act-${index}`), ruleId: RULE.id, rng: createScriptedRng([draw]) }),
  );
  resolveEncounter(store, { ...action('end'), outcome: OUTCOME });
  const committedRolls = acts.flatMap(({ events }) =>
    events.flatMap(({ payload }) => (payload[ROLL_PATH] as { rolls?: RollEvent[] } | undefined)?.rolls ?? []),
  );
  const timeline = { campaignId: campaign.id, branchId: MAIN_BRANCH };
  const eventStore = createEventStore(connection.database);
  return { connection, store, eventStore, timeline, committedRolls, events: eventStore.list(campaign.id, MAIN_BRANCH) };
};

const materialized = (session: ReturnType<typeof playSession>) => {
  const state = session.store.load(session.timeline.campaignId);
  assert.ok(state);
  return state;
};

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('T01: reconstruct canonical state from events plus versioned snapshots', () => {
  const session = playSession();
  const { events, timeline } = session;
  const full = replay(campaignProjection, timeline, events);
  for (const cut of [NO_EVENTS, 1, Math.floor(events.length / 2), events.length]) {
    const snapshot = roundTrip(checkpoint(campaignProjection, timeline, events.slice(0, cut)));
    assert.equal(snapshot.version, CAMPAIGN_PROJECTION_VERSION);
    assert.equal(snapshot.eventCount, cut);
    assert.equal(snapshot.lastEventId, events[cut - 1]?.id ?? null);
    assert.deepEqual(replay(campaignProjection, timeline, events, snapshot), full);
  }
  const head = checkpoint(campaignProjection, timeline, events.slice(0, 1));
  const chained = checkpoint(campaignProjection, timeline, events.slice(0, -1), head);
  assert.deepEqual(replay(campaignProjection, timeline, events, chained), full);
  session.connection.close();
});

test('T01: replay state matches directly materialized state and recorded roll outcomes', () => {
  const session = playSession();
  const { events, timeline, committedRolls } = session;
  const state = materialized(session);
  const replayed = replay(campaignProjection, timeline, events);
  assert.deepEqual(
    {
      campaign: replayed.campaign,
      revision: replayed.revision,
      characters: replayed.characters,
      currentScene: replayed.currentScene,
      turnIds: replayed.turnIds,
    },
    {
      campaign: state.campaign,
      revision: state.revision,
      characters: state.characters,
      currentScene: state.currentScene,
      turnIds: state.turns.map(({ id }) => id),
    },
  );
  const materializedRolls = currentEncounter(state.events)?.actions.flatMap(({ resolution }) => resolution.rolls);
  assert.equal(committedRolls.length, DRAWS.length);
  assert.deepEqual(replayed.rolls, committedRolls);
  assert.deepEqual(replayed.rolls, materializedRolls);
  assert.deepEqual(
    replayed.rolls.map(({ draws }) => draws),
    [[[FIRST_FACE]], [[SECOND_FACE]]],
  );
  session.connection.close();
});

test('T01: replay applies a created character name like the store', () => {
  const session = playSession();
  const { store, timeline } = session;
  const before = materialized(session);
  const [actor] = before.characters;
  assert.ok(actor && before.currentScene);
  commitCharacter(store, {
    campaignId: timeline.campaignId,
    actionId: 'create-mara',
    expectedRevision: before.revision,
    sceneId: before.currentScene.id,
    actorId: actor.id,
    input: 'Create character.',
    intent: 'create character',
    build: BUILD,
  });
  const state = materialized(session);
  const replayed = replay(campaignProjection, timeline, session.eventStore.list(timeline.campaignId, MAIN_BRANCH));
  assert.deepEqual(replayed.characters, state.characters);
  assert.equal(replayed.characters[0]?.name, CREATED_NAME);
  session.connection.close();
});

test('T01: a snapshot with another projection version falls back to full replay', () => {
  const session = playSession();
  const { events, timeline } = session;
  const snapshot = checkpoint(campaignProjection, timeline, events.slice(0, -1));
  const campaign = { id: timeline.campaignId, name: FORGED_NAME };
  const forged = { ...snapshot, state: { ...snapshot.state, campaign } };
  assert.deepEqual(replay(campaignProjection, timeline, events, forged).campaign, campaign);
  const stale = { ...forged, version: CAMPAIGN_PROJECTION_VERSION + 1 };
  assert.deepEqual(replay(campaignProjection, timeline, events, stale), replay(campaignProjection, timeline, events));
  session.connection.close();
});

test('T01: a snapshot that does not match the event log or timeline is rejected', () => {
  const session = playSession();
  const { events, timeline } = session;
  const snapshot = checkpoint(campaignProjection, timeline, events.slice(0, 2));
  const mismatched = [
    { ...snapshot, lastEventId: events[2]?.id ?? null },
    { ...snapshot, eventCount: events.length + 1 },
    { ...snapshot, eventCount: -1 },
    { ...snapshot, branchId: SIDE_BRANCH },
    { ...snapshot, campaignId: OTHER_CAMPAIGN },
  ];
  for (const bad of mismatched) {
    assert.throws(() => replay(campaignProjection, timeline, events, bad), SnapshotMismatchError);
  }
  session.connection.close();
});

test('T01: replay is branch scoped and requires revision order', () => {
  const session = playSession();
  const { events, timeline, eventStore } = session;
  const last = events.at(-1) as DomainEvent;
  const branched: DomainEvent = { ...last, id: 'event-side', branchId: SIDE_BRANCH };
  eventStore.append(branched, last.revision);
  assert.deepEqual(eventStore.list(timeline.campaignId, MAIN_BRANCH), events);
  assert.throws(() => replay(campaignProjection, timeline, [...events, branched]), CampaignBoundaryError);
  const foreign: DomainEvent = { ...last, id: 'event-foreign', campaignId: OTHER_CAMPAIGN };
  assert.throws(() => replay(campaignProjection, timeline, [...events, foreign]), CampaignBoundaryError);
  const reordered = [...events.slice(1), events[0] as DomainEvent];
  assert.throws(() => replay(campaignProjection, timeline, reordered), EventOrderError);
  session.connection.close();
});

test('T01: replay rejects a recorded roll whose total does not match its stored draws', () => {
  const session = playSession();
  const { events, timeline } = session;
  const tampered = events.map((event) => {
    const resolution = event.payload[ROLL_PATH] as { rolls?: RollEvent[] } | undefined;
    if (resolution?.rolls === undefined) return event;
    const rolls = resolution.rolls.map((roll) => ({ ...roll, total: roll.total + 1 }));
    return { ...event, payload: { ...event.payload, [ROLL_PATH]: { ...resolution, rolls } } };
  });
  assert.throws(() => replay(campaignProjection, timeline, tampered), RecordedRollError);
  session.connection.close();
});

test('T01: replay works for any projection without genre or dice knowledge', () => {
  const counter: Projection<number> = { version: 1, initial: 0, apply: (count) => count + 1 };
  const session = playSession();
  const { events, timeline } = session;
  const snapshot = checkpoint(counter, timeline, events.slice(0, 3));
  assert.equal(replay(counter, timeline, events, snapshot), events.length);
  assert.equal(replay(counter, timeline, []), 0);
  session.connection.close();
});
