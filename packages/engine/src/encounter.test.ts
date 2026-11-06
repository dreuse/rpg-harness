import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CampaignEvent, type CampaignStore, SYSTEM_TURN } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { replayRoll } from '../../rules/src/dice.ts';
import { type EffectiveMechanic, GM_ADJUDICATED, RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import { createScriptedRng } from '../../testkit/src/fixtures.ts';
import {
  actInEncounter,
  currentEncounter,
  type EncounterMove,
  type EncounterStart,
  resolveEncounter,
  startEncounter,
} from './encounter.ts';
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
const STAMINA_MAX = 3;
const STRAIN = 1;
const RULE_PACK = { id: 'harbor-rules', edition: 'first', revision: '1' };
const OTHER_PACK = { ...RULE_PACK, revision: '2' };
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
const RULE: RuleDsl = {
  dslVersion: RULE_DSL_VERSION,
  id: 'contest',
  costs: [{ kind: 'cost', resource: 'stamina', amount: { kind: 'const', value: STRAIN } }],
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

const UNREACHABLE_RULE: RuleDsl = {
  ...RULE,
  id: 'long-shot',
  when: {
    kind: 'compare',
    op: 'gte',
    left: { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 },
    right: { kind: 'const', value: UNREACHABLE },
  },
};

const mechanicOf = (rule: RuleDsl, rulePack = RULE_PACK): EffectiveMechanic => ({
  ruleId: rule.id,
  rulePack,
  source: { kind: 'rulepack', sourceRef: rule.id, revision: rulePack.revision },
  kind: 'deterministic',
  rule: { rule, rulePack, sourceRefs: [rule.id], primitives: [], adjudicated: [], deterministic: true },
});

const ADJUDICATED: EffectiveMechanic = {
  ruleId: 'parley',
  rulePack: RULE_PACK,
  source: { kind: 'rulepack', sourceRef: 'parley', revision: RULE_PACK.revision },
  kind: GM_ADJUDICATED,
  reason: 'AdjudicatedCapability',
  issues: [],
};

const RULES = { rulePack: RULE_PACK, mechanics: [mechanicOf(RULE), mechanicOf(UNREACHABLE_RULE), ADJUDICATED] };

const sheetOf = (characterId: string): TraitSheet => ({
  characterId,
  traits: [
    { id: 'skill', kind: 'trait', value: SKILL },
    { id: 'outcome', kind: 'trait', value: 0 },
    { id: 'stamina', kind: 'resource', current: STAMINA_MAX, max: STAMINA_MAX },
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
  ruleId: RULE.id,
  rng: createScriptedRng([draw]),
});

const PARTICIPANTS = [MARA.id, FERRYMAN.id];

const opening = (overrides: Partial<EncounterStart> = {}): EncounterStart => ({
  ...base('start', MARA.id, SETUP_REVISION),
  participants: PARTICIPANTS,
  rules: RULES,
  sheets: PARTICIPANTS.map(sheetOf),
  ...overrides,
});

const start = (store: CampaignStore) => startEncounter(store, opening());

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
    assert.equal(started.turn.kind, SYSTEM_TURN);
    assert.deepEqual(types(started.events), ['PlayerActionSubmitted', 'ActionValidated', 'EncounterStarted']);
    assertCausalChain(started.events);
    const opened = currentEncounter(loaded(store));
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
        rules: RULES,
        sheets: { [MARA.id]: sheetOf(MARA.id), [FERRYMAN.id]: sheetOf(FERRYMAN.id) },
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
    const encounter = currentEncounter(state);
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
          changes: [
            { id: 'stamina', from: STAMINA_MAX, to: STAMINA_MAX - STRAIN },
            { id: 'outcome', from: 0, to: MID_FACE + SKILL },
          ],
        },
        {
          actorId: FERRYMAN.id,
          round: FIRST_ROUND,
          ruleId: RULE.id,
          dslVersion: RULE_DSL_VERSION,
          modifiers: { situation: SITUATION_BONUS },
          ok: true,
          faces: [[[HIGH_FACE]]],
          changes: [
            { id: 'stamina', from: STAMINA_MAX, to: STAMINA_MAX - STRAIN },
            { id: 'outcome', from: 0, to: HIGH_FACE + SKILL },
          ],
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
    actInEncounter(store, { ...move('mara-1', MARA.id, SETUP_REVISION + 1, MID_DRAW), ruleId: UNREACHABLE_RULE.id });
    const state = loaded(store);
    assert.equal(state.revision, SETUP_REVISION + 2);
    const encounter = currentEncounter(state);
    const [action] = encounter?.actions ?? [];
    assert.equal(action?.resolution.ok, false);
    assert.equal(action?.resolution.ok === false && action.resolution.error.code, 'PreconditionFailed');
    assert.deepEqual(
      action?.resolution.rolls.map((roll) => roll.draws),
      [[[MID_FACE]]],
    );
    assert.equal(encounter?.actorId, FERRYMAN.id);
    assert.equal(encounter?.round, FIRST_ROUND);
    assert.deepEqual(encounter?.sheets[MARA.id], sheetOf(MARA.id));
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
    const opened = start(writer.store);
    const committed = actInEncounter(writer.store, firstMove);
    writer.close();

    const reader = openStore(path);
    try {
      const resumed = currentEncounter(loaded(reader.store));
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
      assert.deepEqual(start(reader.store).events, opened.events);

      actInEncounter(reader.store, move('ferryman-1', FERRYMAN.id, SETUP_REVISION + 2, HIGH_DRAW));
      const after = currentEncounter(loaded(reader.store));
      assert.equal(after?.round, SECOND_ROUND);
      assert.equal(after?.actorId, MARA.id);
      assert.deepEqual(after?.actions[0], recorded);

      actInEncounter(reader.store, move('mara-2', MARA.id, SETUP_REVISION + 3, HIGH_DRAW));
      const carried = currentEncounter(loaded(reader.store));
      const [, , second] = carried?.actions ?? [];
      assert.deepEqual(second?.resolution.ok && second.resolution.changes, [
        { id: 'stamina', from: STAMINA_MAX - STRAIN, to: STAMINA_MAX - STRAIN - STRAIN },
        { id: 'outcome', from: MID_FACE + SKILL, to: HIGH_FACE + SKILL },
      ]);
      assert.deepEqual(carried?.sheets[MARA.id]?.traits, [
        { id: 'skill', kind: 'trait', value: SKILL },
        { id: 'outcome', kind: 'trait', value: HIGH_FACE + SKILL },
        { id: 'stamina', kind: 'resource', current: STAMINA_MAX - STRAIN - STRAIN, max: STAMINA_MAX },
      ]);
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
    const opened = (actionId: string, overrides: Partial<EncounterStart>) => () =>
      startEncounter(store, { ...opening(overrides), actionId });
    rejected(opened('stranger', { participants: [MARA.id, 'stranger'] }));
    rejected(opened('alone', { participants: [], sheets: [] }));
    rejected(opened('twice', { participants: [MARA.id, MARA.id] }));
    rejected(opened('outsider-sheet', { sheets: [sheetOf('stranger')] }));
    rejected(opened('repeated-sheet', { sheets: [sheetOf(MARA.id), sheetOf(MARA.id)] }));
    rejected(opened('bad-sheet', { sheets: [{ characterId: MARA.id, traits: [{ id: '', kind: 'tag' }] }] }));
    rejected(opened('foreign-rule', { rules: { ...RULES, mechanics: [mechanicOf(RULE, OTHER_PACK)] } }));
    rejected(opened('repeated-rule', { rules: { ...RULES, mechanics: [mechanicOf(RULE), mechanicOf(RULE)] } }));
    rejected(
      opened('bad-rule', {
        rules: { ...RULES, mechanics: [mechanicOf({ ...RULE, effects: [{ kind: 'emitEvent', event: '' }] })] },
      }),
    );
    start(store);
    const revision = SETUP_REVISION + 1;
    rejected(() => startEncounter(store, { ...base('again', MARA.id, revision), participants: [MARA.id] }));
    rejected(() => actInEncounter(store, move('out-of-turn', FERRYMAN.id, revision, MID_DRAW)));
    rejected(() => actInEncounter(store, { ...move('unknown-rule', MARA.id, revision, MID_DRAW), ruleId: 'x' }));
    rejected(() =>
      actInEncounter(store, { ...move('adjudicated', MARA.id, revision, MID_DRAW), ruleId: ADJUDICATED.ruleId }),
    );
    rejected(() => resolveEncounter(store, { ...base('blank-end', MARA.id, revision), outcome: ' ' }));
    resolveEncounter(store, { ...base('end', MARA.id, revision), outcome: OUTCOME });
    rejected(() => actInEncounter(store, move('late', MARA.id, revision + 1, MID_DRAW)));
    rejected(() => resolveEncounter(store, { ...base('end-again', MARA.id, revision + 1), outcome: OUTCOME }));
    assert.equal(loaded(store).revision, revision + 1);
  } finally {
    close();
  }
});

test('an encounter without pinned rules or sheets runs narratively and rejects mechanical moves', () => {
  const { store, close } = openStore();
  try {
    setup(store);
    startEncounter(store, { ...base('start', MARA.id, SETUP_REVISION), participants: PARTICIPANTS });
    const encounter = currentEncounter(loaded(store));
    assert.equal(encounter?.rules, undefined);
    assert.deepEqual(encounter?.sheets[MARA.id], { characterId: MARA.id, traits: [] });
    assert.throws(
      () => actInEncounter(store, move('mara-1', MARA.id, SETUP_REVISION + 1, MID_DRAW)),
      InvalidActionError,
    );
    resolveEncounter(store, { ...base('end', MARA.id, SETUP_REVISION + 1), outcome: OUTCOME });
    assert.equal(currentEncounter(loaded(store))?.status, 'resolved');
  } finally {
    close();
  }
});
