import type { EntityId } from './entity.ts';

export type CampaignId = string;
export type CharacterId = string;
export type SceneId = string;
export type TurnId = string;
export type EventId = string;
export type BranchId = string;

export const MAIN_BRANCH: BranchId = 'main';
export const CAMPAIGN_CREATED = 'CampaignCreated';
export const CAMPAIGN_RENAMED = 'CampaignRenamed';
export const SCENE_OPENED = 'SceneOpened';
export const CAMPAIGN_CONFIGURED = 'CampaignConfigured';
export const EVENT_BUCKETS = ['background', 'emerging', 'major', 'critical'] as const;
export type EventBucket = (typeof EVENT_BUCKETS)[number];

export type Campaign = { readonly id: CampaignId; readonly name: string };

export type Character = { readonly id: CharacterId; readonly campaignId: CampaignId; readonly name: string };

export type Scene = { readonly id: SceneId; readonly campaignId: CampaignId; readonly title: string };

export type Turn = {
  readonly id: TurnId;
  readonly campaignId: CampaignId;
  readonly sceneId: SceneId;
  readonly actionId: string;
  readonly actorId: CharacterId;
  readonly input: string;
  readonly narration: string;
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

export type TurnCommit = {
  readonly expectedRevision: number;
  readonly turn: Turn;
  readonly characters: readonly Character[];
  readonly scenes: readonly Scene[];
  readonly events: readonly CampaignEvent[];
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

export type CampaignState = {
  readonly campaign: Campaign;
  readonly revision: number;
  readonly characters: readonly Character[];
  readonly currentScene: Scene | undefined;
  readonly turns: readonly Turn[];
  readonly events: readonly CampaignEvent[];
};

export interface CampaignStore {
  createCampaign(campaign: Campaign, event: CampaignChange): void;
  renameCampaign(rename: CampaignRename): void;
  commitTurn(commit: TurnCommit): CommittedTurn;
  recordNarration(campaignId: CampaignId, turnId: TurnId, narration: string): void;
  load(id: CampaignId): CampaignState | undefined;
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
