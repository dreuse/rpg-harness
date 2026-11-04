import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CampaignEvent, CampaignStore } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { replayRoll } from '../../rules/src/dice.ts';
import { RULE_DSL_VERSION } from '../../rules/src/dsl.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import { createScriptedRng } from '../../testkit/src/fixtures.ts';
import { actInEncounter, currentEncounter, type EncounterMove, resolveEncounter, startEncounter } from './encounter.ts';
import { InvalidActionError, type PlayerAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const TEMP_PREFIX = 'rpg-encounter-';
const DATABASE_FILE = 'campaign.sqlite';
const SETUP_REVISION = 1;
const FIRST_ROUND = 1;
const SECOND_ROUND = 2;
const SKILL = 2;
const DIE_SIDES = 6;
const MID_DRAW = 0.5;
const HIGH_DRAW = 0.9;
const MID_FACE = 4;
const HIGH_FACE = 6;
const OUTCOME = 'The ferryman yields the oar.';
const SITUATION_BONUS = 1;
const UNREACHABLE = DIE_SIDES + 1;
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const FERRYMAN = { id: 'ferryman', campaignId: CAMPAIGN.id, name: 'Ferryman' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const SETUP_TURN = {
  id: 'turn-0',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'setup',
  actorId: MARA.id,
  input: 'Begin.',
  narration: 'A lantern sways at the end of the pier.',
};
const RULE = {
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
    { kind: 'emitEvent', event: 'contest.made' },
  ],
};

const sheetOf = (characterId: string): TraitSheet => ({
  characterId,
  traits: [
    { id: 'skill', kind: 'trait', value: SKILL },
    { id: 'outcome', kind: 'trait', value: 0 },
  ],
});

const base = (actionId: string, actorId: string, expectedRevision: number): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision,
  sceneId: SCENE.id,
  actorId,
  input: `${actorId} acts.`,
  intent: `${actorId} makes a move.`,
});

const move = (actionId: string, actorId: string, expectedRevision: number, draw: number): EncounterMove => ({
  ...base(actionId, actorId, expectedRevision),
  rule: RULE,
  sheet: sheetOf(actorId),
  rng: createScriptedRng([draw]),
});

const start = (store: CampaignStore, expectedRevision = SETUP_REVISION) =>
  startEncounter(store, { ...base('start', MARA.id, expectedRevision), participants: [MARA.id, FERRYMAN.id] });

const setup = (store: CampaignStore) => {
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({
    expectedRevision: 0,
    turn: SETUP_TURN,
    characters: [MARA, FERRYMAN],
    scenes: [SCENE],
    events: [],
  });
};

const openStore = (path = IN_MEMORY) => {
  const connection = openDatabase(path);
  return { store: createCampaignStore(connection.database), close: () => connection.close() };
};

const loaded = (store: CampaignStore) => {
  const state = store.load(CAMPAIGN.id);
  assert.ok(state);
  return state;
};

const types = (events: readonly CampaignEvent[]) => events.map(({ type }) => type);

const assertCausalChain = (events: readonly CampaignEvent[]) => {
  const [first, ...rest] = events;
  assert.equal(first?.causationId, null);
  assert.deepEqual(
    rest.map(({ causationId }) => causationId),
    events.slice(0, -1).map(({ id }) => id),
  );
};

test('persist encounter initiation, transitions, mechanical turns and resolution', () => {
  const { store, close } = openStore();
  try {
    setup(store);
    const started = start(store);
    assert.deepEqual(types(started.events), ['PlayerActionSubmitted', 'ActionValidated', 'EncounterStarted']);
    assertCausalChain(started.events);
    const opened = currentEncounter(loaded(store).events);
    assert.deepEqual(
      { ...opened, id: '' },
      {
        id: '',
        participants: [MARA.id, FERRYMAN.id],
        status: 'active',
        round: FIRST_ROUND,
        actorId: MARA.id,
        outcome: undefined,
        actions: [],
      },
    );

    const first = actInEncounter(store, move('mara-1', MARA.id, SETUP_REVISION + 1, MID_DRAW));
    assert.deepEqual(types(first.events), [
      'PlayerActionSubmitted',
      'ActionValidated',
      'EncounterActionResolved',
      'EncounterTurnAdvanced',
    ]);
    assertCausalChain(first.events);
    actInEncounter(store, {
      ...move('ferryman-1', FERRYMAN.id, SETUP_REVISION + 2, HIGH_DRAW),
      modifiers: { situation: SITUATION_BONUS },
    });
    const ended = resolveEncounter(store, { ...base('end', MARA.id, SETUP_REVISION + 3), outcome: OUTCOME });
    assert.deepEqual(types(ended.events), ['PlayerActionSubmitted', 'ActionValidated', 'EncounterResolved']);
    assertCausalChain(ended.events);

    const state = loaded(store);
    assert.equal(state.revision, SETUP_REVISION + 4);
    const encounter = currentEncounter(state.events);
    assert.equal(encounter?.id, opened?.id);
    assert.equal(encounter?.status, 'resolved');
    assert.equal(encounter?.outcome, OUTCOME);
    assert.equal(encounter?.round, SECOND_ROUND);
    assert.equal(encounter?.actorId, MARA.id);
    assert.deepEqual(
      encounter?.actions.map(({ actorId, round, ruleId, dslVersion, modifiers, resolution }) => ({
        actorId,
        round,
        ruleId,
        dslVersion,
        modifiers,
        ok: resolution.ok,
        faces: resolution.rolls.map((roll) => roll.draws),
        changes: resolution.ok ? resolution.changes : [],
      })),
      [
        {
          actorId: MARA.id,
          round: FIRST_ROUND,
          ruleId: RULE.id,
          dslVersion: RULE_DSL_VERSION,
          modifiers: {},
          ok: true,
          faces: [[[MID_FACE]]],
          changes: [{ id: 'outcome', from: 0, to: MID_FACE + SKILL }],
        },
        {
          actorId: FERRYMAN.id,
          round: FIRST_ROUND,
          ruleId: RULE.id,
          dslVersion: RULE_DSL_VERSION,
          modifiers: { situation: SITUATION_BONUS },
          ok: true,
          faces: [[[HIGH_FACE]]],
          changes: [{ id: 'outcome', from: 0, to: HIGH_FACE + SKILL }],
        },
      ],
    );
  } finally {
    close();
  }
});

test('a failed precondition is committed with its partial rolls and uses up the turn', () => {
  const { store, close } = openStore();
  try {
    setup(store);
    start(store);
    const when = {
      kind: 'compare',
      op: 'gte',
      left: { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 },
      right: { kind: 'const', value: UNREACHABLE },
    };
    actInEncounter(store, { ...move('mara-1', MARA.id, SETUP_REVISION + 1, MID_DRAW), rule: { ...RULE, when } });
    const state = loaded(store);
    assert.equal(state.revision, SETUP_REVISION + 2);
    const encounter = currentEncounter(state.events);
    const [action] = encounter?.actions ?? [];
    assert.equal(action?.resolution.ok, false);
    assert.equal(action?.resolution.ok === false && action.resolution.error.code, 'PreconditionFailed');
    assert.deepEqual(
      action?.resolution.rolls.map((roll) => roll.draws),
      [[[MID_FACE]]],
    );
    assert.equal(encounter?.actorId, FERRYMAN.id);
    assert.equal(encounter?.round, FIRST_ROUND);
  } finally {
    close();
  }
});

test('resume mid-encounter without rerolling previously committed mechanics', () => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(directory, DATABASE_FILE);
  const firstMove = move('mara-1', MARA.id, SETUP_REVISION + 1, MID_DRAW);
  try {
    const writer = openStore(path);
    setup(writer.store);
    start(writer.store);
    const committed = actInEncounter(writer.store, firstMove);
    writer.close();

    const reader = openStore(path);
    try {
      const resumed = currentEncounter(loaded(reader.store).events);
      assert.equal(resumed?.status, 'active');
      assert.equal(resumed?.actorId, FERRYMAN.id);
      const [recorded] = resumed?.actions ?? [];
      assert.deepEqual(
        recorded?.resolution.rolls.map((roll) => replayRoll(roll).ok),
        [true],
      );

      const exhausted = () => assert.fail('committed mechanics must not draw again');
      const retried = actInEncounter(reader.store, { ...firstMove, rng: exhausted });
      assert.deepEqual(retried.events, committed.events);

      actInEncounter(reader.store, move('ferryman-1', FERRYMAN.id, SETUP_REVISION + 2, HIGH_DRAW));
      const after = currentEncounter(loaded(reader.store).events);
      assert.equal(after?.round, SECOND_ROUND);
      assert.equal(after?.actorId, MARA.id);
      assert.deepEqual(after?.actions[0], recorded);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects encounter actions outside a valid transition', () => {
  const { store, close } = openStore();
  try {
    setup(store);
    const rejected = (run: () => unknown) => assert.throws(run, InvalidActionError);
    rejected(() => actInEncounter(store, move('early', MARA.id, SETUP_REVISION, MID_DRAW)));
    rejected(() => resolveEncounter(store, { ...base('early-end', MARA.id, SETUP_REVISION), outcome: OUTCOME }));
    rejected(() =>
      startEncounter(store, { ...base('stranger', MARA.id, SETUP_REVISION), participants: [MARA.id, 'stranger'] }),
    );
    rejected(() => startEncounter(store, { ...base('alone', MARA.id, SETUP_REVISION), participants: [] }));
    rejected(() =>
      startEncounter(store, { ...base('twice', MARA.id, SETUP_REVISION), participants: [MARA.id, MARA.id] }),
    );
    start(store);
    const revision = SETUP_REVISION + 1;
    rejected(() => startEncounter(store, { ...base('again', MARA.id, revision), participants: [MARA.id] }));
    rejected(() => actInEncounter(store, move('out-of-turn', FERRYMAN.id, revision, MID_DRAW)));
    rejected(() => actInEncounter(store, { ...move('wrong-sheet', MARA.id, revision, MID_DRAW), sheet: sheetOf('x') }));
    rejected(() => actInEncounter(store, { ...move('bad-rule', MARA.id, revision, MID_DRAW), rule: {} }));
    rejected(() => resolveEncounter(store, { ...base('blank-end', MARA.id, revision), outcome: ' ' }));
    resolveEncounter(store, { ...base('end', MARA.id, revision), outcome: OUTCOME });
    rejected(() => actInEncounter(store, move('late', MARA.id, revision + 1, MID_DRAW)));
    rejected(() => resolveEncounter(store, { ...base('end-again', MARA.id, revision + 1), outcome: OUTCOME }));
    assert.equal(loaded(store).revision, revision + 1);
  } finally {
    close();
  }
});
