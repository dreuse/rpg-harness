import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CAMPAIGN_CREATED,
  type CampaignState,
  type CampaignStore,
  type DomainEvent,
  MAIN_BRANCH,
} from '../../../packages/domain/src/campaign.ts';
import type { RulePackLink } from '../../../packages/domain/src/character.ts';
import { type Narrator, playGameplayTurn } from '../../../packages/engine/src/gameplay.ts';
import { loadState, openScene, type PlayerAction, performAction } from '../../../packages/engine/src/turn.ts';
import { type Fact, GM_VIEWER, PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { estimateTokens } from '../../../packages/memory/src/retrieval.ts';
import { assembleGmContext, type GmContext } from '../../../packages/narrative/src/context.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEventStore, type EventStore } from '../../../packages/persistence/src/event-store.ts';
import { createSequentialIds } from '../../../packages/testkit/src/fixtures.ts';
import {
  type Branch,
  branchHistory,
  forkFromCheckpoint,
  replayBranch,
} from '../../../packages/timelines/src/branches.ts';
import { type CampaignTimelineState, campaignProjection } from '../../../packages/timelines/src/campaign.ts';
import { type CheckpointPointer, createCheckpoint } from '../../../packages/timelines/src/checkpoints.ts';
import { replay, type Timeline } from '../../../packages/timelines/src/replay.ts';

const TEMP_PREFIX = 'rpg-q05-';
const DATABASE_FILE = 'campaigns.sqlite';
const CAMPAIGN_ID = 'long-run';
const CAMPAIGN_NAME = 'The Long Road';
const ACTOR_NAME = 'Wanderer';
const SCENE_TITLE = 'An endless road';
const OPENING_NARRATION = 'The road stretches on.';
const SESSIONS = 3;
const TURNS_PER_SESSION = 100;
const TOTAL_TURNS = SESSIONS * TURNS_PER_SESSION;
const ACTION_ID_WIDTH = String(TOTAL_TURNS).length;
const BUDGET = 400;
const BRANCH_EVENTS = 5;
const BRANCH_EVENT = 'BranchNoteRecorded';
const REVISION_STEP = 1;
const FIRST_SESSION = 0;
const OPENING_TURNS = 1;
const NO_REVISION = 0;
const PENDING_NARRATION = '';
const ROAD_FACT = 'fact-road';
const SUBMITTED = 'PlayerActionSubmitted';
const RULE_ID = 'task.resolve';
const RULE_SECTION = 'core-1';
const RULEPACK: RulePackLink = { id: 'generic-pack', edition: 'core', revision: '1' };
const NARRATION_CONTEXT = { facts: [], equipment: {}, viewer: PLAYER_VIEWER };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

type Recorded = { readonly prompt: string; readonly context: GmContext; readonly historyEvents: number };

const createRecordingModel = () => {
  const calls: Recorded[] = [];
  return {
    calls,
    complete: (context: GmContext, historyEvents: number) => {
      const prompt = JSON.stringify({ rules: context.rules, entries: context.entries, dialogue: context.dialogue });
      calls.push({ prompt, context, historyEvents });
      return `The road answers turn ${calls.length}.`;
    },
  };
};

type Model = ReturnType<typeof createRecordingModel>;

const canonFact = (sceneId: string): Fact => ({
  id: ROAD_FACT,
  campaignId: CAMPAIGN_ID,
  subjectId: sceneId,
  statement: 'The road never ends.',
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
});

const contextOf = (state: CampaignState): GmContext => {
  const scene = state.currentScene;
  assert.ok(scene);
  return assembleGmContext(
    {
      snapshot: {
        scene,
        sceneEntityIds: [],
        pinnedFactIds: [],
        entities: [],
        relationships: [],
        threads: [],
        facts: [canonFact(scene.id)],
        events: state.events,
      },
      rulepack: RULEPACK,
      rules: [{ id: RULE_ID, summary: 'Resolve a task.', section: RULE_SECTION, visibility: 'public', actorId: null }],
      budget: BUDGET,
    },
    GM_VIEWER,
  );
};

const narratorFor = (store: CampaignStore, model: Model): Narrator => ({
  narrate: ({ turn }) => {
    const state = loadState(store, turn.campaignId);
    return { narration: model.complete(contextOf(state), state.events.length), claims: [] };
  },
});

const withDatabaseFile = (run: (path: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    run(join(directory, DATABASE_FILE));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const inSession = <T>(path: string, run: (store: CampaignStore, events: EventStore) => T): T => {
  const connection = openDatabase(path);
  try {
    return run(createCampaignStore(connection.database), createEventStore(connection.database));
  } finally {
    connection.close();
  }
};

const MAIN: Timeline = { campaignId: CAMPAIGN_ID, branchId: MAIN_BRANCH };

const logOf = (events: EventStore, branches: readonly Branch[] = []) =>
  [MAIN, ...branches].flatMap(({ branchId }) => events.list(CAMPAIGN_ID, branchId));

const actionOf = (state: CampaignState, turn: number): PlayerAction => {
  const actionId = `turn-${String(turn).padStart(ACTION_ID_WIDTH, '0')}`;
  const actorId = state.characters[0]?.id;
  const sceneId = state.currentScene?.id;
  assert.ok(actorId && sceneId);
  return {
    campaignId: CAMPAIGN_ID,
    actionId,
    expectedRevision: state.revision,
    sceneId,
    actorId,
    input: `I walk on, step ${actionId}.`,
    intent: 'travel',
  };
};

const projected = (state: CampaignState) => ({
  revision: state.revision,
  currentScene: state.currentScene,
  turnIds: state.turns.map(({ id }) => id),
});

const fromProjection = ({ revision, currentScene, turnIds }: CampaignTimelineState) => ({
  revision,
  currentScene,
  turnIds,
});

const playLongCampaign = (path: string) => {
  const model = createRecordingModel();
  const nextCheckpoint = createSequentialIds('checkpoint');
  let checkpoints: readonly CheckpointPointer[] = [];
  let resumed: CampaignState | undefined;
  inSession(path, (store) => {
    store.createCampaign(
      { id: CAMPAIGN_ID, name: CAMPAIGN_NAME },
      {
        id: 'created',
        campaignId: CAMPAIGN_ID,
        branchId: MAIN_BRANCH,
        actionId: 'create',
        type: CAMPAIGN_CREATED,
        payload: { name: CAMPAIGN_NAME },
      },
    );
    openScene(store, {
      campaignId: CAMPAIGN_ID,
      actorName: ACTOR_NAME,
      sceneTitle: SCENE_TITLE,
      narration: OPENING_NARRATION,
    });
  });
  for (let session = FIRST_SESSION; session < SESSIONS; session++) {
    resumed = inSession(path, (store, events) => {
      const reopened = loadState(store, CAMPAIGN_ID);
      if (resumed !== undefined) assert.deepEqual(reopened, resumed);
      assert.deepEqual(fromProjection(replay(campaignProjection, MAIN, logOf(events))), projected(reopened));
      const narrator = narratorFor(store, model);
      for (let turn = 0; turn < TURNS_PER_SESSION; turn++) {
        const action = actionOf(loadState(store, CAMPAIGN_ID), session * TURNS_PER_SESSION + turn);
        const outcome = playGameplayTurn(store, narrator, performAction, action, NARRATION_CONTEXT);
        assert.ok('narration' in outcome);
      }
      checkpoints = createCheckpoint(checkpoints, campaignProjection, MAIN, logOf(events), nextCheckpoint());
      return loadState(store, CAMPAIGN_ID);
    });
  }
  assert.ok(resumed);
  return { model, checkpoints, final: resumed };
};

const appendBranchEvents = (path: string, branches: readonly Branch[], branch: Branch) =>
  inSession(path, (_store, events) => {
    for (let index = 0; index < BRANCH_EVENTS; index++) {
      const head = branchHistory(branches, logOf(events, branches), branch).at(-1);
      assert.ok(head);
      events.append(
        {
          id: `${branch.branchId}-${index}`,
          campaignId: CAMPAIGN_ID,
          branchId: branch.branchId,
          turnId: null,
          actorId: null,
          causationId: head.id,
          revision: head.revision + REVISION_STEP,
          type: BRANCH_EVENT,
          payload: { index },
        },
        head.revision,
      );
    }
  });

test('stress-test hundreds of turns, branches, retrieval budgets and recovery', () =>
  withDatabaseFile((path) => {
    const { model, checkpoints, final } = playLongCampaign(path);
    assert.equal(model.calls.length, TOTAL_TURNS);
    assert.equal(
      final.turns.filter(({ narration }) => narration !== PENDING_NARRATION).length,
      TOTAL_TURNS + OPENING_TURNS,
    );
    for (const { context } of model.calls) {
      assert.ok(context.usedTokens <= BUDGET);
      assert.equal(context.requiredExceedsBudget, false);
      assert.ok(context.entries.some(({ id }) => id === ROAD_FACT));
    }
    assert.ok(model.calls.at(-1)?.context.truncated.some(({ kind }) => kind === 'history'));

    const replayed = inSession(path, (store) => {
      const last = final.turns.at(-1);
      assert.ok(last);
      const retry = { ...actionOf(final, TOTAL_TURNS - 1), expectedRevision: final.revision - REVISION_STEP };
      const outcome = playGameplayTurn(store, narratorFor(store, model), performAction, retry, NARRATION_CONTEXT);
      assert.ok('narration' in outcome);
      assert.equal(outcome.narration, last.narration);
      return loadState(store, CAMPAIGN_ID);
    });
    assert.deepEqual(replayed, final);
    assert.equal(model.calls.length, TOTAL_TURNS);

    const mainLog = inSession(path, (_store, events) => logOf(events));
    let branches: readonly Branch[] = [];
    for (const { id } of checkpoints) {
      branches = forkFromCheckpoint(branches, checkpoints, mainLog, MAIN, id, `retry-${id}`);
      appendBranchEvents(path, branches, branches.at(-1) as Branch);
    }
    const projections = (log: readonly DomainEvent[]) =>
      [MAIN, ...branches].map((timeline) => replayBranch(campaignProjection, branches, log, timeline));
    const live = inSession(path, (_store, events) => projections(logOf(events, branches)));
    const persistedBranches = JSON.parse(JSON.stringify(branches));
    const restored = inSession(path, (_store, events) => projections(logOf(events, persistedBranches)));
    assert.deepEqual(restored, live);
    const [mainState, ...branchStates] = live;
    assert.ok(mainState);
    assert.deepEqual(fromProjection(mainState), projected(final));
    branches.forEach((branch, index) => {
      const state = branchStates[index];
      const pointer = checkpoints[index];
      assert.ok(state && pointer);
      assert.equal(state.revision, (mainLog[pointer.eventCount - 1]?.revision ?? NO_REVISION) + BRANCH_EVENTS);
      assert.equal(state.turnIds.length, (index + 1) * TURNS_PER_SESSION + OPENING_TURNS);
      const history = inSession(path, (_store, events) => branchHistory(branches, logOf(events, branches), branch));
      assert.deepEqual(history.slice(0, pointer.eventCount), mainLog.slice(0, pointer.eventCount));
      assert.equal(history.length, pointer.eventCount + BRANCH_EVENTS);
    });
  }));

test('performance does not require full history injection into every model prompt', () =>
  withDatabaseFile((path) => {
    const { model, final } = playLongCampaign(path);
    const sizes = model.calls.map(({ prompt }) => estimateTokens(prompt));
    const firstSessionPeak = Math.max(...sizes.slice(0, TURNS_PER_SESSION));
    assert.ok(Math.max(...sizes) <= firstSessionPeak);

    const last = model.calls.at(-1);
    const atFirstSessionEnd = model.calls[TURNS_PER_SESSION - 1];
    assert.ok(last && atFirstSessionEnd);
    assert.equal(last.historyEvents, final.events.length);
    assert.ok(last.historyEvents > (SESSIONS - 1) * atFirstSessionEnd.historyEvents);
    const cited = (prompt: string) => new Set(prompt.match(UUID) ?? []).size;
    assert.ok(cited(last.prompt) <= cited(atFirstSessionEnd.prompt));
    const oldest = final.events.find(({ type }) => type === SUBMITTED);
    assert.ok(oldest);
    assert.equal(last.prompt.includes(oldest.id), false);
  }));
