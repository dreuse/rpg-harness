import type { CampaignEvent, CampaignStore, CommittedTurn, EventId } from '../../domain/src/campaign.ts';
import { commit, loadState, type PlayerAction, requireValid, storedTurn, validate } from './turn.ts';

export const QUEST_STATUSES = ['pending', 'active', 'completed', 'failed'] as const;
export const TERMINAL_QUEST_STATUSES = ['completed', 'failed'] as const;

export type QuestId = string;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
export type TerminalQuestStatus = (typeof TERMINAL_QUEST_STATUSES)[number];
export type QuestObjective = { readonly id: string; readonly summary: string };
export type QuestPrerequisite =
  | { readonly kind: 'event'; readonly eventType: string; readonly eventId?: EventId | undefined }
  | { readonly kind: 'quest'; readonly questId: QuestId; readonly status: TerminalQuestStatus };
export type QuestDefinition = {
  readonly questId: QuestId;
  readonly title: string;
  readonly objectives: readonly QuestObjective[];
  readonly prerequisites: readonly QuestPrerequisite[];
};
export type Quest = {
  readonly id: QuestId;
  readonly title: string;
  readonly status: QuestStatus;
  readonly objectives: readonly (QuestObjective & { readonly done: boolean })[];
  readonly prerequisites: readonly QuestPrerequisite[];
  readonly outcome: string | undefined;
};

export type QuestTarget = PlayerAction & { readonly questId: QuestId };
export type ObjectiveCompletion = QuestTarget & { readonly objectiveId: string };
export type QuestCompletion = QuestTarget & { readonly outcome: string };
export type QuestFailure = QuestTarget & { readonly reason: string };

const DEFINED = 'QuestDefined';
const ACTIVATED = 'QuestActivated';
const OBJECTIVE_COMPLETED = 'QuestObjectiveCompleted';
const COMPLETED = 'QuestCompleted';
const FAILED = 'QuestFailed';
const PENDING: QuestStatus = 'pending';
const ACTIVE: QuestStatus = 'active';
const EVENT = 'event';
const QUEST = 'quest';

type Payload = Readonly<Record<string, unknown>>;
type Quests = ReadonlyMap<QuestId, Quest>;

const isFilled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const fold = (quests: Map<QuestId, Quest>, { type, payload }: CampaignEvent) => {
  const data = payload as Payload;
  const id = String(data.questId);
  if (type === DEFINED) {
    const objectives = (data.objectives as QuestObjective[]).map((objective) => ({ ...objective, done: false }));
    const prerequisites = data.prerequisites as QuestPrerequisite[];
    quests.set(id, { id, title: String(data.title), status: PENDING, objectives, prerequisites, outcome: undefined });
  }
  const quest = quests.get(id);
  if (quest === undefined) return quests;
  if (type === ACTIVATED) quests.set(id, { ...quest, status: ACTIVE });
  if (type === OBJECTIVE_COMPLETED) {
    const objectives = quest.objectives.map((o) => (o.id === data.objectiveId ? { ...o, done: true } : o));
    quests.set(id, { ...quest, objectives });
  }
  if (type === COMPLETED) quests.set(id, { ...quest, status: 'completed', outcome: String(data.outcome) });
  if (type === FAILED) quests.set(id, { ...quest, status: 'failed', outcome: String(data.reason) });
  return quests;
};

const projectQuests = (events: readonly CampaignEvent[]): Quests => events.reduce(fold, new Map<QuestId, Quest>());

export const questLog = (events: readonly CampaignEvent[]): readonly Quest[] => [...projectQuests(events).values()];

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
  const quests = projectQuests(events);
  const quest = quests.get(questId);
  return quest === undefined ? [] : unmetOf(events, quests, quest);
};

const run = (
  store: CampaignStore,
  action: PlayerAction,
  steps: (events: readonly CampaignEvent[], quests: Quests) => readonly (readonly [string, Record<string, unknown>])[],
): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = storedTurn(state, action.actionId);
  if (stored !== undefined) return stored;
  validate(state, action);
  return commit(store, action, steps(state.events, projectQuests(state.events)));
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
  run(store, definition, (_, quests) => {
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
    return [[DEFINED, { questId, title, objectives, prerequisites }]];
  });

export const activateQuest = (store: CampaignStore, target: QuestTarget): CommittedTurn =>
  run(store, target, (events, quests) => {
    const quest = questIn(quests, target, PENDING);
    const unmet = unmetOf(events, quests, quest);
    requireValid(
      target.actionId,
      unmet.length === 0,
      `quest ${quest.id} has unmet prerequisites ${JSON.stringify(unmet)}`,
    );
    return [[ACTIVATED, { questId: quest.id }]];
  });

export const completeObjective = (store: CampaignStore, completion: ObjectiveCompletion): CommittedTurn =>
  run(store, completion, (_, quests) => {
    const { actionId, objectiveId } = completion;
    const quest = questIn(quests, completion, ACTIVE);
    const objective = quest.objectives.find(({ id }) => id === objectiveId);
    requireValid(actionId, objective !== undefined, `objective ${objectiveId} is not part of quest ${quest.id}`);
    requireValid(actionId, objective?.done === false, `objective ${objectiveId} is already complete`);
    return [[OBJECTIVE_COMPLETED, { questId: quest.id, objectiveId }]];
  });

export const completeQuest = (store: CampaignStore, completion: QuestCompletion): CommittedTurn =>
  run(store, completion, (_, quests) => {
    const { actionId, outcome } = completion;
    const quest = questIn(quests, completion, ACTIVE);
    requireValid(
      actionId,
      quest.objectives.every(({ done }) => done),
      `quest ${quest.id} has open objectives`,
    );
    requireValid(actionId, isFilled(outcome), 'outcome is blank');
    return [[COMPLETED, { questId: quest.id, outcome }]];
  });

export const failQuest = (store: CampaignStore, failure: QuestFailure): CommittedTurn =>
  run(store, failure, (_, quests) => {
    const { actionId, reason } = failure;
    const quest = questIn(quests, failure, ACTIVE);
    requireValid(actionId, isFilled(reason), 'reason is blank');
    return [[FAILED, { questId: quest.id, reason }]];
  });
