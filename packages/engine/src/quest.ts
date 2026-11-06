import type { CampaignEvent, CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import {
  QUEST_ACTIVATED,
  QUEST_COMPLETED,
  QUEST_DEFINED,
  QUEST_FAILED,
  QUEST_OBJECTIVE_COMPLETED,
  QUEST_STATUSES,
  type Quest,
  type QuestId,
  type QuestObjective,
  type QuestPrerequisite,
  type QuestStatus,
  TERMINAL_QUEST_STATUSES,
  type TerminalQuestStatus,
  visibleFoldsOf,
} from '../../timelines/src/live-folds.ts';
import { commitSystem, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export type { Quest, QuestId, QuestObjective, QuestPrerequisite, QuestStatus, TerminalQuestStatus };
export { QUEST_STATUSES, TERMINAL_QUEST_STATUSES };
export type QuestDefinition = {
  readonly questId: QuestId;
  readonly title: string;
  readonly objectives: readonly QuestObjective[];
  readonly prerequisites: readonly QuestPrerequisite[];
};

export type QuestTarget = PlayerAction & { readonly questId: QuestId };
export type ObjectiveCompletion = QuestTarget & { readonly objectiveId: string };
export type QuestCompletion = QuestTarget & { readonly outcome: string };
export type QuestFailure = QuestTarget & { readonly reason: string };

const PENDING: QuestStatus = 'pending';
const ACTIVE: QuestStatus = 'active';
const EVENT = 'event';
const QUEST = 'quest';

type Quests = ReadonlyMap<QuestId, Quest>;

const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const questMapOf = (quests: readonly Quest[]): Quests => new Map(quests.map((quest) => [quest.id, quest]));

export const questLog = (events: readonly CampaignEvent[]): readonly Quest[] => visibleFoldsOf(events).quests;

const isMet = (events: readonly CampaignEvent[], quests: Quests, prerequisite: QuestPrerequisite) =>
  prerequisite.kind === EVENT
    ? events.some(
        ({ id, type }) =>
          type === prerequisite.eventType && (prerequisite.eventId === undefined || id === prerequisite.eventId),
      )
    : quests.get(prerequisite.questId)?.status === prerequisite.status;

const unmetOf = (events: readonly CampaignEvent[], quests: Quests, quest: Quest) =>
  quest.prerequisites.filter((prerequisite) => !isMet(events, quests, prerequisite));

export const unmetPrerequisites = (
  events: readonly CampaignEvent[],
  questId: QuestId,
): readonly QuestPrerequisite[] => {
  const quests = questMapOf(questLog(events));
  const quest = quests.get(questId);
  return quest === undefined ? [] : unmetOf(events, quests, quest);
};

const run = (
  store: CampaignStore,
  action: PlayerAction,
  [type, fields]: readonly [string, Readonly<Record<string, unknown>>],
  steps: (events: readonly CampaignEvent[], quests: Quests) => readonly (readonly [string, Record<string, unknown>])[],
): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = replayOf(store, state, action, recorded(type, fields));
  if (stored !== undefined) return stored;
  validate(state, action);
  return commitSystem(store, action, steps(state.events, questMapOf(state.folds.gm.quests)));
};

const questIn = (quests: Quests, { actionId, questId }: QuestTarget, status: QuestStatus): Quest => {
  const quest = quests.get(questId);
  requireValid(actionId, quest !== undefined, `quest ${questId} is not defined`);
  requireValid(actionId, quest?.status === status, `quest ${questId} is ${quest?.status}, not ${status}`);
  return quest as Quest;
};

const toPrerequisite = (
  actionId: string,
  questId: QuestId,
  quests: Quests,
  p: QuestPrerequisite,
): QuestPrerequisite => {
  if (p.kind === EVENT) {
    requireValid(actionId, isFilled(p.eventType), 'event prerequisite needs an event type');
    requireValid(actionId, p.eventId === undefined || isFilled(p.eventId), 'event prerequisite id is blank');
    return p.eventId === undefined
      ? { kind: EVENT, eventType: p.eventType }
      : { kind: EVENT, eventType: p.eventType, eventId: p.eventId };
  }
  requireValid(actionId, p.kind === QUEST, 'prerequisite kind is unknown');
  requireValid(actionId, p.questId !== questId && quests.has(p.questId), `prerequisite quest ${p.questId} is unknown`);
  requireValid(actionId, TERMINAL_QUEST_STATUSES.includes(p.status), 'prerequisite status is not terminal');
  return { kind: QUEST, questId: p.questId, status: p.status };
};

export const defineQuest = (store: CampaignStore, definition: PlayerAction & QuestDefinition): CommittedTurn =>
  run(store, definition, [QUEST_DEFINED, { questId: definition.questId, title: definition.title }], (_, quests) => {
    const { actionId, questId, title } = definition;
    requireValid(actionId, isFilled(questId), 'quest id is blank');
    requireValid(actionId, !quests.has(questId), `quest ${questId} is already defined`);
    requireValid(actionId, isFilled(title), 'quest title is blank');
    const objectives = definition.objectives.map(({ id, summary }) => {
      requireValid(actionId, isFilled(id) && isFilled(summary), 'objective id or summary is blank');
      return { id, summary };
    });
    requireValid(actionId, new Set(objectives.map(({ id }) => id)).size === objectives.length, 'objectives repeat');
    const prerequisites = definition.prerequisites.map((p) => toPrerequisite(actionId, questId, quests, p));
    return [[QUEST_DEFINED, { questId, title, objectives, prerequisites }]];
  });

export const activateQuest = (store: CampaignStore, target: QuestTarget): CommittedTurn =>
  run(store, target, [QUEST_ACTIVATED, { questId: target.questId }], (events, quests) => {
    const quest = questIn(quests, target, PENDING);
    const unmet = unmetOf(events, quests, quest);
    requireValid(
      target.actionId,
      unmet.length === 0,
      `quest ${quest.id} has unmet prerequisites ${JSON.stringify(unmet)}`,
    );
    return [[QUEST_ACTIVATED, { questId: quest.id }]];
  });

export const completeObjective = (store: CampaignStore, completion: ObjectiveCompletion): CommittedTurn =>
  run(
    store,
    completion,
    [QUEST_OBJECTIVE_COMPLETED, { questId: completion.questId, objectiveId: completion.objectiveId }],
    (_, quests) => {
      const { actionId, objectiveId } = completion;
      const quest = questIn(quests, completion, ACTIVE);
      const objective = quest.objectives.find(({ id }) => id === objectiveId);
      requireValid(actionId, objective !== undefined, `objective ${objectiveId} is not part of quest ${quest.id}`);
      requireValid(actionId, objective?.done === false, `objective ${objectiveId} is already complete`);
      return [[QUEST_OBJECTIVE_COMPLETED, { questId: quest.id, objectiveId }]];
    },
  );

export const completeQuest = (store: CampaignStore, completion: QuestCompletion): CommittedTurn =>
  run(
    store,
    completion,
    [QUEST_COMPLETED, { questId: completion.questId, outcome: completion.outcome }],
    (_, quests) => {
      const { actionId, outcome } = completion;
      const quest = questIn(quests, completion, ACTIVE);
      requireValid(
        actionId,
        quest.objectives.every(({ done }) => done),
        `quest ${quest.id} has open objectives`,
      );
      requireValid(actionId, isFilled(outcome), 'outcome is blank');
      return [[QUEST_COMPLETED, { questId: quest.id, outcome }]];
    },
  );

export const failQuest = (store: CampaignStore, failure: QuestFailure): CommittedTurn =>
  run(store, failure, [QUEST_FAILED, { questId: failure.questId, reason: failure.reason }], (_, quests) => {
    const { actionId, reason } = failure;
    const quest = questIn(quests, failure, ACTIVE);
    requireValid(actionId, isFilled(reason), 'reason is blank');
    return [[QUEST_FAILED, { questId: quest.id, reason }]];
  });
