import type { EntityId, Visibility } from './entity.ts';
import type { GmUsageLedger } from './gm.ts';
import type { LiveFolds } from './live-folds.ts';

export type CampaignId = string;
export type CharacterId = string;
export type SceneId = string;
export type TurnId = string;
export type EventId = string;
export type BranchId = string;

export const MAIN_BRANCH: BranchId = 'main';
export const CAMPAIGN_CREATED = 'CampaignCreated';
export const CAMPAIGN_RENAMED = 'CampaignRenamed';
export const CAMPAIGN_LANGUAGE_CHANGED = 'CampaignLanguageChanged';
export const SCENE_OPENED = 'SceneOpened';
export const CHARACTER_CREATED = 'CharacterCreated';
export const CAMPAIGN_CONFIGURED = 'CampaignConfigured';
export const CAMPAIGN_PITCHED = 'CampaignPitched';
export const RULES_DOCUMENT_ADDED = 'RulesDocumentAdded';
export const PLAYER_ACTION_SUBMITTED = 'PlayerActionSubmitted';
export const ACTION_VALIDATED = 'ActionValidated';
export const CHECK_RESOLVED = 'CheckResolved';
export const CHECK_SKIPPED = 'CheckSkipped';
export const NO_CHECK_REASONS = ['no-rulebook', 'dice-off', 'unsupported-rulebook', 'missing-scores'] as const;
export type NoCheckReason = (typeof NO_CHECK_REASONS)[number];
export const CHECK_OFFERED = 'CheckOffered';
export const GM_ROLLED = 'GmRolled';
export const DAMAGE_APPLIED = 'DamageApplied';
export const ROLL_REPORTED = 'RollReported';
export const CONDITION_APPLIED = 'ConditionApplied';
export const CONDITION_REMOVED = 'ConditionRemoved';
export const EVENT_BUCKETS = ['background', 'emerging', 'major', 'critical'] as const;
export type EventBucket = (typeof EVENT_BUCKETS)[number];

export type Campaign = { readonly id: CampaignId; readonly name: string };

export type Character = { readonly id: CharacterId; readonly campaignId: CampaignId; readonly name: string };

export type Scene = {
  readonly id: SceneId;
  readonly campaignId: CampaignId;
  readonly title: string;
  readonly locationKind?: string;
  readonly moodTags?: readonly string[];
};

export const OPENING_ACTION_ID = 'opening';

export const TURN_KINDS = ['player', 'system'] as const;
export type TurnKind = (typeof TURN_KINDS)[number];
export const PLAYER_TURN: TurnKind = 'player';
export const SYSTEM_TURN: TurnKind = 'system';

export type TurnDelivery = {
  readonly emotion?: string;
  readonly intensity?: number;
  readonly pace?: number;
};

export type TurnSegment = {
  readonly speakerId?: string;
  readonly text: string;
  readonly delivery?: TurnDelivery;
};

export type Turn = {
  readonly id: TurnId;
  readonly campaignId: CampaignId;
  readonly sceneId: SceneId;
  readonly actionId: string;
  readonly actorId: CharacterId;
  readonly input: string;
  readonly narration: string;
  readonly segments?: readonly TurnSegment[];
  readonly kind?: TurnKind;
};

export type CampaignEvent = {
  readonly id: EventId;
  readonly campaignId: CampaignId;
  readonly turnId: TurnId;
  readonly causationId: EventId | null;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type DomainEvent = Omit<CampaignEvent, 'turnId'> & {
  readonly branchId: BranchId;
  readonly turnId: TurnId | null;
  readonly actorId: EntityId | null;
  readonly revision: number;
};

export const TURN_VISIBILITIES = ['public', 'player', 'gm'] as const satisfies readonly Visibility[];
export type TurnVisibility = (typeof TURN_VISIBILITIES)[number];

export type TurnCommit = {
  readonly expectedRevision: number;
  readonly turn: Turn;
  readonly characters: readonly Character[];
  readonly scenes: readonly Scene[];
  readonly events: readonly CampaignEvent[];
  readonly visibility?: Readonly<Record<EventId, TurnVisibility>>;
};

export type CommittedTurn = { readonly turn: Turn; readonly events: readonly CampaignEvent[] };

export type CampaignChange = {
  readonly id: EventId;
  readonly campaignId: CampaignId;
  readonly branchId: BranchId;
  readonly actionId: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type CampaignRename = {
  readonly expectedRevision: number;
  readonly campaign: Campaign;
  readonly event: CampaignChange;
};

export type CampaignChangeRecord = {
  readonly expectedRevision: number;
  readonly event: CampaignChange;
};

export type CampaignState = {
  readonly campaign: Campaign;
  readonly revision: number;
  readonly characters: readonly Character[];
  readonly currentScene: Scene | undefined;
  readonly turns: readonly Turn[];
  readonly events: readonly CampaignEvent[];
  readonly changes: readonly Pick<CampaignEvent, 'type' | 'payload'>[];
  readonly gmUsage: GmUsageLedger;
  readonly folds: LiveFolds;
};

export interface CampaignStore {
  createCampaign(campaign: Campaign, event: CampaignChange): void;
  renameCampaign(rename: CampaignRename): void;
  recordChange(change: CampaignChangeRecord): void;
  commitTurn(commit: TurnCommit): CommittedTurn;
  recordNarration(campaignId: CampaignId, turnId: TurnId, narration: string, segments?: readonly TurnSegment[]): void;
  recordUsage(event: CampaignChange): void;
  load(id: CampaignId): CampaignState | undefined;
  findTurn(campaignId: CampaignId, actionId: string): CommittedTurn | undefined;
}

export class CampaignNotFoundError extends Error {
  readonly id: CampaignId;
  constructor(id: CampaignId) {
    super(`no campaign with id ${id}`);
    this.id = id;
  }
}

export class CampaignBoundaryError extends Error {
  readonly campaignId: CampaignId;
  readonly reference: string;
  constructor(campaignId: CampaignId, reference: string) {
    super(`${reference} is outside campaign ${campaignId}`);
    this.campaignId = campaignId;
    this.reference = reference;
  }
}

export class StaleRevisionError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`expected revision ${expected} but campaign is at revision ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}
