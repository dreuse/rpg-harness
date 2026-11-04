import type { CampaignId } from './campaign.ts';

export type EntityId = string;
export type RelationshipId = string;

export const ENTITY_KINDS = ['npc', 'location', 'faction', 'item', 'character'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const VISIBILITY_LEVELS = ['public', 'player', 'gm', 'actor-scoped'] as const;
export type Visibility = (typeof VISIBILITY_LEVELS)[number];

export type CampaignEntity = {
  readonly id: EntityId;
  readonly campaignId: CampaignId;
  readonly kind: EntityKind;
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
};

export type Relationship = {
  readonly id: RelationshipId;
  readonly campaignId: CampaignId;
  readonly kind: string;
  readonly sourceId: EntityId;
  readonly targetId: EntityId;
  readonly data: Readonly<Record<string, unknown>>;
};

export interface EntityStore {
  saveEntity(entity: CampaignEntity): void;
  getEntity(campaignId: CampaignId, id: EntityId): CampaignEntity | undefined;
  listEntities(campaignId: CampaignId, kind?: EntityKind): readonly CampaignEntity[];
  saveRelationship(relationship: Relationship): void;
  listRelationships(campaignId: CampaignId, entityId?: EntityId): readonly Relationship[];
}

export class DanglingReferenceError extends Error {
  readonly reference: string;
  constructor(reference: string) {
    super(`${reference} does not exist`);
    this.reference = reference;
  }
}
