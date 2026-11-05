import type { EventId } from './campaign.ts';
import type { EntityId } from './entity.ts';

export const CLAIM_KINDS = [
  'alive',
  'relationship',
  'item',
  'place',
  'promise',
  'secret',
  'name',
  'description',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const SINGLETON_CLAIM_KINDS: readonly ClaimKind[] = ['alive', 'place', 'name', 'description'];

export const ALIVE_VALUES = ['alive', 'dead'] as const;
export const ITEM_VALUES = ['held', 'not-held'] as const;
export const PROMISE_VALUES = ['open', 'kept', 'broken'] as const;

export type StoryMemoryGroup = 'person' | 'place' | 'thread';

export type StoryMemoryEntry = {
  readonly entityId: EntityId;
  readonly entityName: string;
  readonly kind: ClaimKind;
  readonly key: string;
  readonly value: string;
  readonly sourceEventId: EventId;
  readonly corrected: boolean;
};

export type StoryMemory = Readonly<Record<StoryMemoryGroup, readonly StoryMemoryEntry[]>>;
