import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignEvent, type CampaignStore, SYSTEM_TURN } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { resolveEncounter, startEncounter } from './encounter.ts';
import {
  activateQuest,
  completeObjective,
  completeQuest,
  defineQuest,
  failQuest,
  type QuestDefinition,
  unmetPrerequisites,
} from './quest.ts';
import { InvalidActionError, type PlayerAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const ENCOUNTER_RESOLVED = 'EncounterResolved';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
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
const FERRY: QuestDefinition = {
  questId: 'find-ferry',
  title: 'Find the ferryman',
  objectives: [
    { id: 'ask', summary: 'Ask the dockhands' },
    { id: 'pay', summary: 'Pay the toll' },
  ],
  prerequisites: [],
};
const CROSSING: QuestDefinition = {
  questId: 'cross-river',
  title: 'Cross the river',
  objectives: [],
  prerequisites: [
    { kind: 'quest', questId: FERRY.questId, status: 'completed' },
    { kind: 'event', eventType: ENCOUNTER_RESOLVED },
  ],
};
const BRIBE: QuestDefinition = { questId: 'bribe', title: 'Bribe the guard', objectives: [], prerequisites: [] };

const openStore = () => {
  const connection = openDatabase(IN_MEMORY);
  return { store: createCampaignStore(connection.database), close: () => connection.close() };
};

const setup = (store: CampaignStore) => {
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [MARA], scenes: [SCENE], events: [] });
};

const events = (store: CampaignStore): readonly CampaignEvent[] => store.load(CAMPAIGN.id)?.events ?? [];
const revision = (store: CampaignStore) => store.load(CAMPAIGN.id)?.revision ?? 0;

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: revision(store),
  sceneId: SCENE.id,
  actorId: MARA.id,
  input: `${actionId}.`,
  intent: `Mara does ${actionId}.`,
});

const questLog = (store: CampaignStore) => store.load(CAMPAIGN.id)?.folds.gm.quests ?? [];
const quest = (store: CampaignStore, questId: string) => questLog(store).find((q) => q.id === questId);

test('track active/completed/failed quests and prerequisites linked to events', () => {
  const { store, close } = openStore();
  try {
    setup(store);
    const defined = defineQuest(store, { ...actionFor(store, 'define-ferry'), ...FERRY });
    assert.equal(defined.turn.kind, SYSTEM_TURN);
    assert.deepEqual(
      defined.events.map(({ type }) => type),
      ['PlayerActionSubmitted', 'ActionValidated', 'QuestDefined'],
    );
    defineQuest(store, { ...actionFor(store, 'define-crossing'), ...CROSSING });
    defineQuest(store, { ...actionFor(store, 'define-bribe'), ...BRIBE });
    assert.deepEqual(
      questLog(store).map(({ id, status }) => [id, status]),
      [
        [FERRY.questId, 'pending'],
        [CROSSING.questId, 'pending'],
        [BRIBE.questId, 'pending'],
      ],
    );
    assert.deepEqual(unmetPrerequisites(store, CAMPAIGN.id, CROSSING.questId), CROSSING.prerequisites);

    activateQuest(store, { ...actionFor(store, 'start-bribe'), questId: BRIBE.questId });
    failQuest(store, { ...actionFor(store, 'fail-bribe'), questId: BRIBE.questId, reason: 'The guard refused.' });
    assert.equal(quest(store, BRIBE.questId)?.status, 'failed');
    assert.equal(quest(store, BRIBE.questId)?.outcome, 'The guard refused.');

    activateQuest(store, { ...actionFor(store, 'start-ferry'), questId: FERRY.questId });
    assert.equal(quest(store, FERRY.questId)?.status, 'active');
    for (const { id } of FERRY.objectives)
      completeObjective(store, { ...actionFor(store, `do-${id}`), questId: FERRY.questId, objectiveId: id });
    assert.deepEqual(
      quest(store, FERRY.questId)?.objectives.map(({ id, done }) => [id, done]),
      [
        ['ask', true],
        ['pay', true],
      ],
    );
    completeQuest(store, { ...actionFor(store, 'finish-ferry'), questId: FERRY.questId, outcome: 'Ferry found.' });
    assert.equal(quest(store, FERRY.questId)?.status, 'completed');
    assert.deepEqual(unmetPrerequisites(store, CAMPAIGN.id, CROSSING.questId), [CROSSING.prerequisites[1]]);

    startEncounter(store, { ...actionFor(store, 'fight'), participants: [MARA.id] });
    const resolved = resolveEncounter(store, { ...actionFor(store, 'win'), outcome: 'Pirates flee.' });
    assert.deepEqual(unmetPrerequisites(store, CAMPAIGN.id, CROSSING.questId), []);
    assert.equal(
      events(store).some(({ type }) => type === ENCOUNTER_RESOLVED),
      false,
    );
    activateQuest(store, { ...actionFor(store, 'start-crossing'), questId: CROSSING.questId });
    assert.equal(quest(store, CROSSING.questId)?.status, 'active');

    const resolvedId = resolved.events.find(({ type }) => type === ENCOUNTER_RESOLVED)?.id;
    const linked = { kind: 'event', eventType: ENCOUNTER_RESOLVED, eventId: resolvedId } as const;
    const stale = { kind: 'event', eventType: ENCOUNTER_RESOLVED, eventId: 'other-event' } as const;
    defineQuest(store, {
      ...actionFor(store, 'define-aftermath'),
      questId: 'aftermath',
      title: 'Count the cost',
      objectives: [],
      prerequisites: [linked, stale],
    });
    assert.deepEqual(unmetPrerequisites(store, CAMPAIGN.id, 'aftermath'), [stale]);
  } finally {
    close();
  }
});

test('quest cannot complete twice or activate unmet prerequisites silently', () => {
  const { store, close } = openStore();
  try {
    setup(store);
    const rejected = (actionId: string, run: (action: PlayerAction) => unknown) => {
      const before = revision(store);
      assert.throws(() => run(actionFor(store, actionId)), InvalidActionError, actionId);
      assert.equal(revision(store), before, actionId);
    };
    defineQuest(store, { ...actionFor(store, 'define-ferry'), ...FERRY });
    defineQuest(store, { ...actionFor(store, 'define-crossing'), ...CROSSING });

    rejected('unmet', (a) => activateQuest(store, { ...a, questId: CROSSING.questId }));
    rejected('unknown', (a) => activateQuest(store, { ...a, questId: 'missing' }));
    rejected('duplicate', (a) => defineQuest(store, { ...a, ...FERRY }));
    rejected('blank-title', (a) => defineQuest(store, { ...a, ...BRIBE, title: ' ' }));
    rejected('repeat-objective', (a) =>
      defineQuest(store, { ...a, ...BRIBE, objectives: [FERRY.objectives[0], FERRY.objectives[0]] as never }),
    );
    rejected('dangling', (a) =>
      defineQuest(store, {
        ...a,
        ...BRIBE,
        prerequisites: [{ kind: 'quest', questId: 'missing', status: 'completed' }],
      }),
    );
    rejected('self', (a) =>
      defineQuest(store, {
        ...a,
        ...BRIBE,
        prerequisites: [{ kind: 'quest', questId: BRIBE.questId, status: 'completed' }],
      }),
    );
    rejected('bad-kind', (a) => defineQuest(store, { ...a, ...BRIBE, prerequisites: [{ kind: 'dice' }] as never }));
    rejected('blank-event', (a) =>
      defineQuest(store, { ...a, ...BRIBE, prerequisites: [{ kind: 'event', eventType: '' }] }),
    );
    rejected('inactive-objective', (a) =>
      completeObjective(store, { ...a, questId: FERRY.questId, objectiveId: 'ask' }),
    );
    rejected('inactive-complete', (a) => completeQuest(store, { ...a, questId: FERRY.questId, outcome: 'Done.' }));
    rejected('inactive-fail', (a) => failQuest(store, { ...a, questId: FERRY.questId, reason: 'Lost.' }));

    activateQuest(store, { ...actionFor(store, 'start-ferry'), questId: FERRY.questId });
    rejected('activate-again', (a) => activateQuest(store, { ...a, questId: FERRY.questId }));
    rejected('open-objectives', (a) => completeQuest(store, { ...a, questId: FERRY.questId, outcome: 'Done.' }));
    rejected('unknown-objective', (a) => completeObjective(store, { ...a, questId: FERRY.questId, objectiveId: 'x' }));
    completeObjective(store, { ...actionFor(store, 'ask'), questId: FERRY.questId, objectiveId: 'ask' });
    rejected('objective-twice', (a) => completeObjective(store, { ...a, questId: FERRY.questId, objectiveId: 'ask' }));
    completeObjective(store, { ...actionFor(store, 'pay'), questId: FERRY.questId, objectiveId: 'pay' });
    rejected('blank-outcome', (a) => completeQuest(store, { ...a, questId: FERRY.questId, outcome: ' ' }));
    const finish = actionFor(store, 'finish');
    const done = completeQuest(store, { ...finish, questId: FERRY.questId, outcome: 'Done.' });
    assert.deepEqual(completeQuest(store, { ...finish, questId: FERRY.questId, outcome: 'Done.' }), done);
    rejected('complete-twice', (a) => completeQuest(store, { ...a, questId: FERRY.questId, outcome: 'Again.' }));
    rejected('fail-completed', (a) => failQuest(store, { ...a, questId: FERRY.questId, reason: 'Lost.' }));
    rejected('reactivate', (a) => activateQuest(store, { ...a, questId: FERRY.questId }));
    rejected('still-unmet', (a) => activateQuest(store, { ...a, questId: CROSSING.questId }));
    assert.equal(quest(store, FERRY.questId)?.outcome, 'Done.');
  } finally {
    close();
  }
});
