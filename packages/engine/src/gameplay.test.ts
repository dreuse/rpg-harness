import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import type { CampaignEntity, EntityStore } from '../../domain/src/entity.ts';
import { type Fact, PLAYER_VIEWER } from '../../memory/src/knowledge.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore } from '../../persistence/src/entity-store.ts';
import { createSeededRng } from '../../rules/src/dice.ts';
import { type EffectiveMechanic, RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import { createScriptedRng } from '../../testkit/src/fixtures.ts';
import { actInEncounter, type EncounterMove, startEncounter } from './encounter.ts';
import {
  type GameplayOutcome,
  type NarratedTurn,
  type NarrationContext,
  type Narrator,
  narrateTurn,
  playGameplayTurn,
  UncommittedTurnError,
} from './gameplay.ts';
import { GM_ROLL_ACTION_INFIX, GM_ROLLER, rollForGm } from './gm-roll.ts';
import { recordNpcLearning, saveNpc } from './npc.ts';
import { activateQuest, completeObjective, defineQuest } from './quest.ts';
import { GameMasterInterruptedError } from './scripted-session.ts';
import { ActionIdConflictError, type PlayerAction, performAction, storedTurn } from './turn.ts';

const IN_MEMORY = ':memory:';
const TEMP_PREFIX = 'rpg-gameplay-';
const DATABASE_FILE = 'campaign.sqlite';
const PENDING_NARRATION = '';
const OTHER_OBJECTIVE_ID = 'search';
const UNCOMMITTED_ACTION = 'never-committed';
const NARRATOR_FAILURE = 'narrator crashed';
const SECRET_LEAK = 'secret-leak';
const DIE_SIDES = 6;
const DRAW = 0.5;
const INTERRUPTED_STEP = 0;
const NARRATION_SEPARATOR = ' then ';
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
const WARDEN_ENTITY: CampaignEntity = {
  id: 'npc-warden',
  campaignId: CAMPAIGN.id,
  kind: 'npc',
  name: 'Warden',
  data: {},
  visibility: 'public',
  actorId: null,
};
const TRAITOR: Fact = {
  id: 'fact-traitor',
  campaignId: CAMPAIGN.id,
  subjectId: null,
  statement: 'The captain is the traitor.',
  layer: 'canon',
  visibility: 'gm',
  actorId: null,
  sourceEventId: null,
};
const CONTEXT: NarrationContext = { facts: [TRAITOR], equipment: {}, viewer: PLAYER_VIEWER };
const GATE: Fact = {
  id: 'fact-gate',
  campaignId: CAMPAIGN.id,
  subjectId: null,
  statement: 'The gate opens at dawn.',
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
};
const TOLD_BY_MARA = { channel: 'told', sourceId: MARA.id, eventId: null } as const;
const QUEST_ID = 'find-ferry';
const OBJECTIVE_ID = 'ask';
const RULE: RuleDsl = {
  dslVersion: RULE_DSL_VERSION,
  id: 'contest',
  effects: [
    {
      kind: 'setTrait',
      trait: 'outcome',
      value: { kind: 'dice', count: 1, sides: DIE_SIDES, modifier: 0 },
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
const MARA_SHEET: TraitSheet = { characterId: MARA.id, traits: [{ id: 'outcome', kind: 'trait', value: 0 }] };
const MECHANICS = {
  combat: 'EncounterActionResolved',
  investigation: 'QuestObjectiveCompleted',
  social: 'NpcLearnedFact',
} as const;
type SceneKind = keyof typeof MECHANICS;

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
  sceneId: SCENE.id,
  actorId: MARA.id,
  input: `${actionId}.`,
  intent: `Mara does ${actionId}.`,
});

const connect = (path: string) => {
  const connection = openDatabase(path);
  const store = createCampaignStore(connection.database);
  const entities = createEntityStore(connection.database);
  return { store, entities, close: () => connection.close() };
};

const open = (path = IN_MEMORY) => {
  const { store, entities, close } = connect(path);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({
    expectedRevision: 0,
    turn: SETUP_TURN,
    characters: [MARA, FERRYMAN],
    scenes: [SCENE],
    events: [],
  });
  entities.saveEntity(WARDEN_ENTITY);
  saveNpc(entities, CAMPAIGN.id, {
    id: WARDEN_ENTITY.id,
    goals: [],
    disposition: 'calm',
    relationships: {},
    learned: [],
  });
  startEncounter(store, {
    ...actionFor(store, 'start'),
    participants: [MARA.id, FERRYMAN.id],
    rules: { rulePack: RULE_PACK, mechanics: [CONTEST] },
    sheets: [MARA_SHEET],
  });
  defineQuest(store, {
    ...actionFor(store, 'define'),
    questId: QUEST_ID,
    title: 'Find the ferryman',
    objectives: [
      { id: OBJECTIVE_ID, summary: 'Ask the dockhands' },
      { id: OTHER_OBJECTIVE_ID, summary: 'Search the boathouse' },
    ],
    prerequisites: [],
  });
  activateQuest(store, { ...actionFor(store, 'activate'), questId: QUEST_ID });
  return { store, entities, close };
};

const playScene = (store: CampaignStore, entities: EntityStore, kind: SceneKind, narrator: Narrator) => {
  const action = actionFor(store, kind);
  if (kind === 'combat') {
    const move: EncounterMove = {
      ...action,
      ruleId: RULE.id,
      rng: createScriptedRng([DRAW]),
    };
    return playGameplayTurn(store, narrator, actInEncounter, move, CONTEXT);
  }
  if (kind === 'investigation')
    return playGameplayTurn(
      store,
      narrator,
      completeObjective,
      {
        ...action,
        questId: QUEST_ID,
        objectiveId: OBJECTIVE_ID,
      },
      CONTEXT,
    );
  return playGameplayTurn(
    store,
    narrator,
    (s, a) => recordNpcLearning(s, entities, a),
    { ...action, npcId: WARDEN_ENTITY.id, fact: GATE, learning: TOLD_BY_MARA },
    CONTEXT,
  );
};

const textOf = ({ events }: CommittedTurn) => events.map(({ type }) => type).join(NARRATION_SEPARATOR);

const narrationOf = (committed: CommittedTurn) => ({ narration: textOf(committed), claims: [] });

const failingNarrator: Narrator = {
  narrate: () => assert.fail('narrator must not run'),
};

const eventIds = (store: CampaignStore) => store.load(CAMPAIGN.id)?.events.map(({ id }) => id) ?? [];

const narrated = (outcome: GameplayOutcome) => {
  assert.ok('narration' in outcome);
  return outcome;
};

test('commit mechanics before narrated results across combat, investigation and social scenes', () => {
  const { store, entities, close } = open();
  try {
    for (const kind of Object.keys(MECHANICS) as SceneKind[]) {
      const received: CommittedTurn[] = [];
      const narrator: Narrator = {
        narrate: (committed) => {
          const stored = storedTurn(store.load(CAMPAIGN.id) ?? assert.fail(), kind);
          assert.deepEqual(committed, stored);
          assert.ok(committed.events.some(({ type }) => type === MECHANICS[kind]));
          received.push(committed);
          return narrationOf(committed);
        },
      };
      const outcome = narrated(playScene(store, entities, kind, narrator));
      assert.equal(received.length, 1);
      assert.equal(outcome.narration, textOf(outcome.committed));
      assert.deepEqual(outcome.committed, received[0]);
    }
  } finally {
    close();
  }
});

test('model interruption resumes from committed state without duplication', () => {
  const { store, entities, close } = open();
  try {
    for (const kind of Object.keys(MECHANICS) as SceneKind[]) {
      const interrupting: Narrator = {
        narrate: () => {
          throw new GameMasterInterruptedError(INTERRUPTED_STEP);
        },
      };
      const interrupted = playScene(store, entities, kind, interrupting);
      assert.ok('interrupted' in interrupted);
      assert.ok(interrupted.interrupted instanceof GameMasterInterruptedError);
      const committedIds = eventIds(store);
      const resumed = narrated(playScene(store, entities, kind, { narrate: narrationOf }));
      assert.deepEqual(eventIds(store), committedIds);
      assert.equal(new Set(committedIds).size, committedIds.length);
      assert.deepEqual(resumed.committed, interrupted.committed);
      assert.equal(
        resumed.narration,
        textOf(storedTurn(store.load(CAMPAIGN.id) ?? assert.fail(), kind) ?? assert.fail()),
      );
    }
  } finally {
    close();
  }
});

test('narration never runs without a committed revision', () => {
  const { store, close } = open();
  try {
    const action = actionFor(store, UNCOMMITTED_ACTION);
    const before = store.load(CAMPAIGN.id);
    const fabricated = (): CommittedTurn => ({ turn: { ...SETUP_TURN, actionId: UNCOMMITTED_ACTION }, events: [] });
    assert.throws(() => playGameplayTurn(store, failingNarrator, fabricated, action, CONTEXT), UncommittedTurnError);
    assert.deepEqual(store.load(CAMPAIGN.id), before);
  } finally {
    close();
  }
});

test('reusing an action id with a different payload is rejected in every gameplay resolver', () => {
  const { store, entities, close } = open();
  try {
    for (const kind of Object.keys(MECHANICS) as SceneKind[])
      playScene(store, entities, kind, { narrate: narrationOf });
    const before = store.load(CAMPAIGN.id);
    const objective = { ...actionFor(store, 'investigation'), questId: QUEST_ID, objectiveId: OTHER_OBJECTIVE_ID };
    assert.throws(() => completeObjective(store, objective), ActionIdConflictError);
    const learning = { ...actionFor(store, 'social'), npcId: WARDEN_ENTITY.id, fact: TRAITOR, learning: TOLD_BY_MARA };
    assert.throws(() => recordNpcLearning(store, entities, learning), ActionIdConflictError);
    const move: EncounterMove = {
      ...actionFor(store, 'combat'),
      ruleId: RULE.id,
      rng: createScriptedRng([DRAW]),
      modifiers: { outcome: DIE_SIDES },
    };
    assert.throws(() => actInEncounter(store, move), ActionIdConflictError);
    const crossed = { ...actionFor(store, 'combat'), questId: QUEST_ID, objectiveId: OTHER_OBJECTIVE_ID };
    assert.throws(() => completeObjective(store, crossed), ActionIdConflictError);
    assert.deepEqual(store.load(CAMPAIGN.id), before);
  } finally {
    close();
  }
});

test('narration is persisted after commit and visible on resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(dir, DATABASE_FILE);
    const first = open(path);
    const outcome = narrated(playScene(first.store, first.entities, 'investigation', { narrate: narrationOf }));
    first.close();
    const reopened = connect(path);
    try {
      const stored = storedTurn(reopened.store.load(CAMPAIGN.id) ?? assert.fail(), 'investigation');
      assert.equal(stored?.turn.narration, outcome.narration);
      const resumed = narrated(playScene(reopened.store, reopened.entities, 'investigation', failingNarrator));
      assert.equal(resumed.narration, outcome.narration);
      assert.deepEqual(resumed.committed, stored);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('consistency check runs before narration is persisted or presented', () => {
  const { store, entities, close } = open();
  try {
    const leaking: Narrator = { narrate: () => ({ narration: TRAITOR.statement, claims: [] }) };
    const outcome = playScene(store, entities, 'investigation', leaking);
    assert.ok('inconsistent' in outcome);
    assert.deepEqual(
      outcome.inconsistent.violations.map(({ kind }) => kind),
      [SECRET_LEAK],
    );
    const stored = storedTurn(store.load(CAMPAIGN.id) ?? assert.fail(), 'investigation');
    assert.equal(stored?.turn.narration, PENDING_NARRATION);
    const resumed = narrated(playScene(store, entities, 'investigation', { narrate: narrationOf }));
    assert.equal(resumed.narration, textOf(resumed.committed));
  } finally {
    close();
  }
});

test('a narrator error that is not an interruption is rethrown after commit', () => {
  const { store, entities, close } = open();
  try {
    const crashing: Narrator = {
      narrate: () => {
        throw new Error(NARRATOR_FAILURE);
      },
    };
    assert.throws(() => playScene(store, entities, 'investigation', crashing), { message: NARRATOR_FAILURE });
    const stored = storedTurn(store.load(CAMPAIGN.id) ?? assert.fail(), 'investigation');
    assert.equal(stored?.turn.narration, PENDING_NARRATION);
  } finally {
    close();
  }
});

test('rpg-42a.28 an async narrator narrates a committed turn through the same consistency gate', async () => {
  const { store, close } = open();
  try {
    const committed = completeObjective(store, {
      ...actionFor(store, 'investigation'),
      questId: QUEST_ID,
      objectiveId: OBJECTIVE_ID,
    });
    const leaked = await narrateTurn(
      store,
      { narrate: async () => ({ narration: TRAITOR.statement, claims: [] }) },
      committed,
      CONTEXT,
    );
    assert.ok('inconsistent' in leaked);
    const interrupted = await narrateTurn(
      store,
      { narrate: async () => Promise.reject(new GameMasterInterruptedError(INTERRUPTED_STEP)) },
      committed,
      CONTEXT,
    );
    assert.ok('interrupted' in interrupted);
    assert.equal(
      storedTurn(store.load(CAMPAIGN.id) ?? assert.fail(), 'investigation')?.turn.narration,
      PENDING_NARRATION,
    );
    const outcome = narrated(
      await narrateTurn(store, { narrate: async (turn) => narrationOf(turn) }, committed, CONTEXT),
    );
    assert.equal(outcome.narration, textOf(committed));
    const stored = storedTurn(store.load(CAMPAIGN.id) ?? assert.fail(), 'investigation') ?? assert.fail();
    assert.equal(stored.turn.narration, textOf(committed));
    const again = narrated(
      await narrateTurn(store, { narrate: async () => assert.fail('narrated twice') }, stored, CONTEXT),
    );
    assert.equal(again.narration, textOf(committed));
  } finally {
    close();
  }
});

const HIT_NARRATION = 'Your blade hits the goblin for 5 damage.';
const HIT_REPLY: NarratedTurn = { narration: HIT_NARRATION, claims: [{ kind: 'outcome', ref: 'hit on the goblin' }] };
const MISS_FREE_NARRATION = 'The goblin snarls and waits for your move.';
const MISS_FREE_REPLY: NarratedTurn = { narration: MISS_FREE_NARRATION, claims: [] };
const AS_WRITTEN: NarrationContext = { ...CONTEXT, rulesStrictness: 'as-written' };
const RESOLVED_CHECK = () => ({ rolls: [], events: [] });

const scripted = (...replies: NarratedTurn[]) => {
  const retries: (readonly string[] | undefined)[] = [];
  const narrator = {
    narrate: async (_committed: CommittedTurn, retry?: readonly { readonly kind: string }[]) => {
      retries.push(retry?.map(({ kind }) => kind));
      return replies[Math.min(retries.length, replies.length) - 1] ?? { narration: '', claims: [] };
    },
  };
  return { narrator, retries };
};

test('rpg-42a.58: as-written rejects a hit with no resolved attack and regenerates once', async () => {
  const { store, close } = open();
  try {
    const committed = performAction(store, actionFor(store, 'swing'));
    const { narrator, retries } = scripted(HIT_REPLY, MISS_FREE_REPLY);
    const outcome = narrated(await narrateTurn(store, narrator, committed, AS_WRITTEN));
    assert.equal(outcome.narration, MISS_FREE_NARRATION);
    assert.deepEqual(retries, [undefined, ['unresolved-outcome']]);
  } finally {
    close();
  }
});

test('rpg-42a.58: a second rejected narration is not regenerated again and falls back', async () => {
  const { store, close } = open();
  try {
    const committed = performAction(store, actionFor(store, 'swing'));
    const { narrator, retries } = scripted(HIT_REPLY, HIT_REPLY, MISS_FREE_REPLY);
    const outcome = await narrateTurn(store, narrator, committed, AS_WRITTEN);
    assert.ok('inconsistent' in outcome);
    assert.equal(retries.length, 2);
  } finally {
    close();
  }
});

test('rpg-42a.58: a resolved check lets the narration claim its result without a retry', async () => {
  const { store, close } = open();
  try {
    const committed = performAction(store, actionFor(store, 'swing'), RESOLVED_CHECK);
    const { narrator, retries } = scripted(HIT_REPLY);
    assert.equal(narrated(await narrateTurn(store, narrator, committed, AS_WRITTEN)).narration, HIT_NARRATION);
    assert.equal(retries.length, 1);
  } finally {
    close();
  }
});

test('rpg-42a.58: relaxed and off skip the check and never regenerate', async () => {
  for (const rulesStrictness of ['relaxed', 'off'] as const) {
    const { store, close } = open();
    try {
      const committed = performAction(store, actionFor(store, 'swing'));
      const { narrator, retries } = scripted(HIT_REPLY);
      const context = { ...CONTEXT, rulesStrictness };
      assert.equal(narrated(await narrateTurn(store, narrator, committed, context)).narration, HIT_NARRATION);
      assert.equal(retries.length, 1);
    } finally {
      close();
    }
  }
});

const NO_ENTITIES = {} as EntityStore;
const rolledFor = (store: CampaignStore, parent: string, rollId: string) =>
  rollForGm(
    store,
    NO_ENTITIES,
    {
      ...actionFor(store, `${parent}${GM_ROLL_ACTION_INFIX}${rollId}`),
      gmRoll: { roller: GM_ROLLER, reason: 'Tam swings', visibility: 'secret', expression: '1d20' },
    },
    createSeededRng(1),
  );

test('rpg-42a.89: a GM roll resolves only the outcome claim that names its roll id', async () => {
  const { store, close } = open();
  try {
    const committed = performAction(store, actionFor(store, 'swing'));
    rolledFor(store, 'swing', 'tam-swing');
    const named = scripted({ narration: HIT_NARRATION, claims: [{ kind: 'outcome', ref: 'tam-swing' }] });
    assert.equal(narrated(await narrateTurn(store, named.narrator, committed, AS_WRITTEN)).narration, HIT_NARRATION);
    const other = open();
    try {
      const unrelated = performAction(other.store, actionFor(other.store, 'swing'));
      rolledFor(other.store, 'swing', 'tam-swing');
      const { narrator, retries } = scripted(
        { narration: HIT_NARRATION, claims: [{ kind: 'outcome', ref: 'player-attack' }] },
        MISS_FREE_REPLY,
      );
      assert.equal(
        narrated(await narrateTurn(other.store, narrator, unrelated, AS_WRITTEN)).narration,
        MISS_FREE_NARRATION,
      );
      assert.deepEqual(retries, [undefined, ['unresolved-outcome']]);
    } finally {
      other.close();
    }
  } finally {
    close();
  }
});

test('rpg-42a.100: a GM roll proposed under another action does not resolve this turn', async () => {
  const { store, close } = open();
  try {
    const committed = performAction(store, actionFor(store, 'swing'));
    rolledFor(store, 'elsewhere', 'tam-swing');
    const { narrator, retries } = scripted(
      { narration: HIT_NARRATION, claims: [{ kind: 'outcome', ref: 'tam-swing' }] },
      MISS_FREE_REPLY,
    );
    assert.equal(narrated(await narrateTurn(store, narrator, committed, AS_WRITTEN)).narration, MISS_FREE_NARRATION);
    assert.deepEqual(retries, [undefined, ['unresolved-outcome']]);
  } finally {
    close();
  }
});
