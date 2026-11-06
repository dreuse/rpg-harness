import type { CampaignEvent, CharacterId } from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import type {
  AudienceScope,
  EffectDue,
  EffectPayload,
  Encounter,
  EncounterResolution,
  EncounterRules,
  EncounterStatus,
  LiveFolds,
  Quest,
  QuestObjective,
  QuestPrerequisite,
  VisibleFolds,
  WorldTime,
} from '../../domain/src/live-folds.ts';
import type { RuleDsl, Trait, TraitChange, TraitSheet, TraitValue } from '../../domain/src/rule-shapes.ts';

export type {
  AudienceScope,
  Clock,
  ClockDefinition,
  ClockId,
  DelayedEffect,
  EffectDue,
  EffectId,
  EffectPayload,
  Encounter,
  EncounterAction,
  EncounterId,
  EncounterResolution,
  EncounterRules,
  EncounterStatus,
  LiveFolds,
  Quest,
  QuestId,
  QuestObjective,
  QuestPrerequisite,
  QuestStatus,
  VisibleFolds,
  WorldTime,
} from '../../domain/src/live-folds.ts';
export {
  QUEST_STATUSES,
  TERMINAL_QUEST_STATUSES,
  type TerminalQuestStatus,
} from '../../domain/src/live-folds.ts';

export const QUEST_DEFINED = 'QuestDefined';
export const QUEST_ACTIVATED = 'QuestActivated';
export const QUEST_OBJECTIVE_COMPLETED = 'QuestObjectiveCompleted';
export const QUEST_COMPLETED = 'QuestCompleted';
export const QUEST_FAILED = 'QuestFailed';
export const ENCOUNTER_STARTED = 'EncounterStarted';
export const ENCOUNTER_ACTION_RESOLVED = 'EncounterActionResolved';
export const ENCOUNTER_TURN_ADVANCED = 'EncounterTurnAdvanced';
export const ENCOUNTER_RESOLVED = 'EncounterResolved';
export const CLOCK_DEFINED = 'ClockDefined';
export const EFFECT_SCHEDULED = 'DelayedEffectScheduled';
export const TIME_ADVANCED = 'GameTimeAdvanced';
export const CLOCK_TICKED = 'ClockTicked';
export const EFFECT_FIRED = 'DelayedEffectFired';
const ACTIVE_ENCOUNTER: EncounterStatus = 'active';
const FIRST_ROUND = 1;
const FIRST_SEAT = 0;
const START_TIME = 0;
const START_CLOCK = 0;
const PUBLIC: Visibility = 'public';
const PLAYER: Visibility = 'player';
const ACTOR_SCOPED: Visibility = 'actor-scoped';

const VISIBLE_FOLD_TYPES: ReadonlySet<string> = new Set([
  QUEST_DEFINED,
  QUEST_ACTIVATED,
  QUEST_OBJECTIVE_COMPLETED,
  QUEST_COMPLETED,
  QUEST_FAILED,
  ENCOUNTER_STARTED,
  ENCOUNTER_ACTION_RESOLVED,
  ENCOUNTER_TURN_ADVANCED,
  ENCOUNTER_RESOLVED,
]);
const WORLD_FOLD_TYPES: ReadonlySet<string> = new Set([
  CLOCK_DEFINED,
  EFFECT_SCHEDULED,
  TIME_ADVANCED,
  CLOCK_TICKED,
  EFFECT_FIRED,
]);

type Payload = Readonly<Record<string, unknown>>;

export const EMPTY_VISIBLE_FOLDS: VisibleFolds = { quests: [] };
export const EMPTY_WORLD_TIME: WorldTime = { now: START_TIME, clocks: [], effects: [] };
export const EMPTY_LIVE_FOLDS: LiveFolds = {
  world: EMPTY_WORLD_TIME,
  gm: EMPTY_VISIBLE_FOLDS,
  player: EMPTY_VISIBLE_FOLDS,
  public: EMPTY_VISIBLE_FOLDS,
  actors: {},
};

const upserted = <T>(items: readonly T[], item: T, same: (candidate: T) => boolean): readonly T[] =>
  items.some(same) ? items.map((candidate) => (same(candidate) ? item : candidate)) : [...items, item];

const questAfter = (quest: Quest, type: string, data: Payload): Quest => {
  if (type === QUEST_ACTIVATED) return { ...quest, status: 'active' };
  if (type === QUEST_OBJECTIVE_COMPLETED) {
    const objectives = quest.objectives.map((o) => (o.id === data.objectiveId ? { ...o, done: true } : o));
    return { ...quest, objectives };
  }
  if (type === QUEST_COMPLETED) return { ...quest, status: 'completed', outcome: String(data.outcome) };
  if (type === QUEST_FAILED) return { ...quest, status: 'failed', outcome: String(data.reason) };
  return quest;
};

export const foldQuests = (quests: readonly Quest[], { type, payload }: CampaignEvent): readonly Quest[] => {
  const data = payload as Payload;
  const id = String(data.questId);
  if (type === QUEST_DEFINED) {
    const objectives = (data.objectives as QuestObjective[]).map((objective) => ({ ...objective, done: false }));
    const prerequisites = data.prerequisites as QuestPrerequisite[];
    const defined: Quest = {
      id,
      title: String(data.title),
      status: 'pending',
      objectives,
      prerequisites,
      outcome: undefined,
    };
    return upserted(quests, defined, (quest) => quest.id === id);
  }
  const quest = quests.find((candidate) => candidate.id === id);
  if (quest === undefined) return quests;
  return upserted(quests, questAfter(quest, type, data), (candidate) => candidate.id === id);
};

const blankSheet = (characterId: CharacterId): TraitSheet => ({ characterId, traits: [] });

const sheetsOf = (participants: readonly CharacterId[], sheets: readonly TraitSheet[]) =>
  Object.fromEntries(
    participants.map((id) => [id, sheets.find(({ characterId }) => characterId === id) ?? blankSheet(id)]),
  );

const changed = (trait: Trait, to: TraitValue): Trait => {
  if (trait.kind === 'resource') return { ...trait, current: Number(to) };
  if (trait.kind === 'trait') return { ...trait, value: to };
  return trait;
};

const applyChanges = (sheet: TraitSheet, changes: readonly TraitChange[]): TraitSheet => {
  const latest = new Map(changes.map(({ id, to }) => [id, to]));
  return {
    ...sheet,
    traits: sheet.traits.map((trait) => {
      const to = latest.get(trait.id);
      return to === undefined ? trait : changed(trait, to);
    }),
  };
};

export const foldEncounter = (
  encounter: Encounter | undefined,
  { id, type, payload }: CampaignEvent,
): Encounter | undefined => {
  const data = payload as Payload;
  if (type === ENCOUNTER_STARTED) {
    const participants = data.participants as CharacterId[];
    return {
      id: String(data.encounterId),
      participants,
      status: ACTIVE_ENCOUNTER,
      round: FIRST_ROUND,
      actorId: participants[FIRST_SEAT] as CharacterId,
      outcome: undefined,
      actions: [],
      rules: data.rules as EncounterRules | undefined,
      sheets: sheetsOf(participants, (data.sheets ?? []) as TraitSheet[]),
    };
  }
  if (encounter === undefined || data.encounterId !== encounter.id) return encounter;
  if (type === ENCOUNTER_ACTION_RESOLVED) {
    const action = {
      eventId: id,
      actorId: String(data.actorId),
      round: Number(data.round),
      ruleId: String(data.ruleId),
      dslVersion: data.dslVersion as RuleDsl['dslVersion'],
      modifiers: data.modifiers as Readonly<Record<string, number>>,
      resolution: data.resolution as EncounterResolution,
    };
    const { resolution, actorId } = action;
    const sheets = resolution.ok
      ? { ...encounter.sheets, [actorId]: applyChanges(encounter.sheets[actorId] as TraitSheet, resolution.changes) }
      : encounter.sheets;
    return { ...encounter, actions: [...encounter.actions, action], sheets };
  }
  if (type === ENCOUNTER_TURN_ADVANCED) {
    return { ...encounter, round: Number(data.round), actorId: String(data.actorId) };
  }
  if (type === ENCOUNTER_RESOLVED) return { ...encounter, status: 'resolved', outcome: String(data.outcome) };
  return encounter;
};

export const foldVisible = (folds: VisibleFolds, event: CampaignEvent): VisibleFolds => {
  if (!VISIBLE_FOLD_TYPES.has(event.type)) return folds;
  const quests = foldQuests(folds.quests, event);
  const encounter = foldEncounter(folds.encounter, event);
  return encounter === undefined ? { quests } : { quests, encounter };
};

export const visibleFoldsOf = (events: readonly CampaignEvent[]): VisibleFolds =>
  events.reduce(foldVisible, EMPTY_VISIBLE_FOLDS);

export const foldWorld = (world: WorldTime, { type, payload }: CampaignEvent): WorldTime => {
  if (!WORLD_FOLD_TYPES.has(type)) return world;
  const data = payload as Payload;
  if (type === CLOCK_DEFINED) {
    const clockId = String(data.clockId);
    const defined = { clockId, label: String(data.label), segments: Number(data.segments), current: START_CLOCK };
    return { ...world, clocks: upserted(world.clocks, defined, (clock) => clock.clockId === clockId) };
  }
  if (type === EFFECT_SCHEDULED) {
    const effectId = String(data.effectId);
    const scheduled = { effectId, due: data.due as EffectDue, effect: data.effect as EffectPayload, fired: false };
    return { ...world, effects: upserted(world.effects, scheduled, (effect) => effect.effectId === effectId) };
  }
  if (type === TIME_ADVANCED) return { ...world, now: Number(data.now) };
  if (type === CLOCK_TICKED) {
    const clock = world.clocks.find(({ clockId }) => clockId === String(data.clockId));
    if (clock === undefined) return world;
    const ticked = { ...clock, current: Number(data.current) };
    return { ...world, clocks: upserted(world.clocks, ticked, ({ clockId }) => clockId === clock.clockId) };
  }
  const effect = world.effects.find(({ effectId }) => effectId === String(data.effectId));
  if (effect === undefined) return world;
  const fired = { ...effect, fired: true };
  return { ...world, effects: upserted(world.effects, fired, ({ effectId }) => effectId === effect.effectId) };
};

export const worldOf = (events: readonly CampaignEvent[]): WorldTime => events.reduce(foldWorld, EMPTY_WORLD_TIME);

const foldActors = (actors: LiveFolds['actors'], event: CampaignEvent) =>
  Object.fromEntries(Object.entries(actors).map(([actorId, folds]) => [actorId, foldVisible(folds, event)]));

export const foldLive = (
  folds: LiveFolds,
  event: CampaignEvent,
  visibility: Visibility,
  actorId: string | null,
): LiveFolds => {
  const world = foldWorld(folds.world, event);
  const gm = foldVisible(folds.gm, event);
  if (gm === folds.gm && world === folds.world) return folds;
  const base = { ...folds, world, gm };
  if (visibility === PUBLIC) {
    return {
      ...base,
      player: foldVisible(folds.player, event),
      public: foldVisible(folds.public, event),
      actors: foldActors(folds.actors, event),
    };
  }
  if (visibility === PLAYER) return { ...base, player: foldVisible(folds.player, event) };
  if (visibility === ACTOR_SCOPED && typeof actorId === 'string' && actorId !== '') {
    const own = Object.hasOwn(folds.actors, actorId) ? (folds.actors[actorId] as VisibleFolds) : folds.public;
    return { ...base, actors: { ...folds.actors, [actorId]: foldVisible(own, event) } };
  }
  return base;
};

export const audienceOf = ({ gm, player, public: shared, actors }: LiveFolds, viewer: AudienceScope): VisibleFolds => {
  if (viewer.scope === 'gm') return gm;
  if (viewer.scope === 'player') return player;
  if (viewer.actorId === '') return EMPTY_VISIBLE_FOLDS;
  return Object.hasOwn(actors, viewer.actorId) ? (actors[viewer.actorId] as VisibleFolds) : shared;
};
