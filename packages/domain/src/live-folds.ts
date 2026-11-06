import type { CharacterId, EventId } from './campaign.ts';
import type { RulePackLink } from './character.ts';
import type {
  EffectiveMechanic,
  ResolutionError,
  RollEvent,
  RuleDsl,
  RuleEvent,
  TraitChange,
  TraitSheet,
} from './rule-shapes.ts';

export const QUEST_STATUSES = ['pending', 'active', 'completed', 'failed'] as const;
export const TERMINAL_QUEST_STATUSES = ['completed', 'failed'] as const;

export type QuestId = string;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
export type TerminalQuestStatus = (typeof TERMINAL_QUEST_STATUSES)[number];
export type QuestObjective = { readonly id: string; readonly summary: string };
export type QuestPrerequisite =
  | { readonly kind: 'event'; readonly eventType: string; readonly eventId?: EventId | undefined }
  | { readonly kind: 'quest'; readonly questId: QuestId; readonly status: TerminalQuestStatus };
export type Quest = {
  readonly id: QuestId;
  readonly title: string;
  readonly status: QuestStatus;
  readonly objectives: readonly (QuestObjective & { readonly done: boolean })[];
  readonly prerequisites: readonly QuestPrerequisite[];
  readonly outcome: string | undefined;
};

export type EncounterId = string;
export type EncounterStatus = 'active' | 'resolved';
export type EncounterResolution =
  | { readonly ok: true; readonly changes: TraitChange[]; readonly events: RuleEvent[]; readonly rolls: RollEvent[] }
  | { readonly ok: false; readonly error: ResolutionError; readonly rolls: RollEvent[] };
export type EncounterAction = {
  readonly eventId: EventId;
  readonly actorId: CharacterId;
  readonly round: number;
  readonly ruleId: string;
  readonly dslVersion: RuleDsl['dslVersion'];
  readonly modifiers: Readonly<Record<string, number>>;
  readonly resolution: EncounterResolution;
};
export type EncounterRules = { readonly rulePack: RulePackLink; readonly mechanics: readonly EffectiveMechanic[] };
export type Encounter = {
  readonly id: EncounterId;
  readonly participants: readonly CharacterId[];
  readonly status: EncounterStatus;
  readonly round: number;
  readonly actorId: CharacterId;
  readonly outcome: string | undefined;
  readonly actions: readonly EncounterAction[];
  readonly rules: EncounterRules | undefined;
  readonly sheets: Readonly<Record<CharacterId, TraitSheet>>;
};

export type ClockId = string;
export type EffectId = string;
export type EffectDue =
  | { readonly kind: 'time'; readonly at: number }
  | { readonly kind: 'clock'; readonly clockId: ClockId };
export type EffectPayload = Readonly<Record<string, unknown>> & { readonly summary: string };
export type ClockDefinition = { readonly clockId: ClockId; readonly label: string; readonly segments: number };
export type Clock = ClockDefinition & { readonly current: number };
export type DelayedEffect = {
  readonly effectId: EffectId;
  readonly due: EffectDue;
  readonly effect: EffectPayload;
  readonly fired: boolean;
};
export type WorldTime = {
  readonly now: number;
  readonly clocks: readonly Clock[];
  readonly effects: readonly DelayedEffect[];
};

export type VisibleFolds = { readonly quests: readonly Quest[]; readonly encounter?: Encounter };
export type LiveFolds = {
  readonly world: WorldTime;
  readonly gm: VisibleFolds;
  readonly player: VisibleFolds;
  readonly public: VisibleFolds;
  readonly actors: Readonly<Record<string, VisibleFolds>>;
};
export type AudienceScope =
  | { readonly scope: 'gm' }
  | { readonly scope: 'player' }
  | { readonly scope: 'actor'; readonly actorId: string };
