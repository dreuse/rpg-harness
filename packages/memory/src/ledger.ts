import type { CampaignEvent, EventId } from '../../domain/src/campaign.ts';
import { type EntityId, type EntityKind, VISIBILITY_LEVELS, type Visibility } from '../../domain/src/entity.ts';
import {
  CLAIM_KINDS,
  type ClaimKind,
  SINGLETON_CLAIM_KINDS,
  type StoryMemory,
  type StoryMemoryEntry,
  type StoryMemoryGroup,
} from '../../domain/src/story-memory.ts';
import { type Scoped, type Viewer, visibleTo } from './knowledge.ts';
import { estimateTokens } from './retrieval.ts';

export const CLAIM_RECORDED = 'ClaimRecorded';
export const CLAIM_CORRECTED = 'ClaimCorrected';

export type LedgerEntry = Scoped & {
  readonly eventId: EventId;
  readonly entityId: EntityId;
  readonly kind: ClaimKind;
  readonly key: string;
  readonly value: string;
  readonly corrected: boolean;
  readonly supersededBy: EventId | null;
};

export type Ledger = readonly LedgerEntry[];
export type LedgerEvent = Pick<CampaignEvent, 'id' | 'type' | 'payload'>;
export type DirectoryEntry = { readonly name: string; readonly kind: EntityKind };
export type Directory = ReadonlyMap<EntityId, DirectoryEntry>;

export const LEDGER_BUDGET_SHARE = 0.4;
const GM: Visibility = 'gm';
const NONE = 0;
const SLOT_SEPARATOR = '\u0000';
const UNKNOWN_ENTITY = 'unknown';
const THREAD_KIND: ClaimKind = 'promise';
const PLACE_ENTITY: EntityKind = 'location';
const PLAYER_VIEW_KINDS: readonly ClaimKind[] = CLAIM_KINDS.filter((kind) => kind !== 'secret');

export const ledgerAllowance = (budget: number): number => Math.floor(budget * LEDGER_BUDGET_SHARE);

export const claimKey = (kind: ClaimKind, key: string | undefined): string =>
  SINGLETON_CLAIM_KINDS.includes(kind) ? kind : (key ?? '').trim();

type Claim = Omit<LedgerEntry, 'supersededBy'>;

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isKind = (value: unknown): value is ClaimKind => CLAIM_KINDS.some((kind) => kind === value);
const isVisibility = (value: unknown): value is Visibility => VISIBILITY_LEVELS.some((level) => level === value);

const parse = ({ id, type, payload }: LedgerEvent): Claim | undefined => {
  const { entityId, kind, key, value, visibility, actorId } = payload;
  if (type !== CLAIM_RECORDED && type !== CLAIM_CORRECTED) return undefined;
  if (!isText(entityId) || !isKind(kind) || !isText(value)) return undefined;
  const slotKey = claimKey(kind, typeof key === 'string' ? key : undefined);
  if (slotKey === '') return undefined;
  return {
    eventId: id,
    entityId,
    kind,
    key: slotKey,
    value: value.trim(),
    visibility: isVisibility(visibility) ? visibility : GM,
    actorId: isText(actorId) ? actorId : null,
    corrected: type === CLAIM_CORRECTED,
  };
};

const slotOf = ({ entityId, kind, key }: Pick<LedgerEntry, 'entityId' | 'kind' | 'key'>) =>
  [entityId, kind, key].join(SLOT_SEPARATOR);

const supersede = (claims: readonly Claim[]): Ledger => {
  const entries = claims.map((claim): LedgerEntry & { supersededBy: EventId | null } => ({
    ...claim,
    supersededBy: null,
  }));
  const current = new Map<string, number>();
  entries.forEach((entry, index) => {
    const slot = slotOf(entry);
    const previous = current.get(slot);
    if (previous !== undefined && entries[previous]) entries[previous].supersededBy = entry.eventId;
    current.set(slot, index);
  });
  return entries;
};

export const buildLedger = (events: readonly LedgerEvent[]): Ledger =>
  supersede(events.map(parse).filter((claim): claim is Claim => claim !== undefined));

export const visibleLedger = (ledger: Ledger, viewer: Viewer): Ledger => supersede(visibleTo(ledger, viewer));

export const currentEntries = (ledger: Ledger): Ledger => ledger.filter(({ supersededBy }) => supersededBy === null);

export const nameOf = (ledger: Ledger, directory: Directory, entityId: EntityId): string =>
  currentEntries(ledger).find((entry) => entry.entityId === entityId && entry.kind === 'name')?.value ??
  directory.get(entityId)?.name ??
  UNKNOWN_ENTITY;

const labelOf = ({ kind, key }: LedgerEntry) => (SINGLETON_CLAIM_KINDS.includes(kind) ? kind : `${kind} ${key}`);

export const factLine = (entry: LedgerEntry, name: string) => `${name} ${labelOf(entry)}: ${entry.value}`;
const historyLine = (entry: LedgerEntry, name: string) => `${name} ${labelOf(entry)}: was ${entry.value}`;
const condensedLine = (name: string, count: number) => `${name}: ${count} earlier claims superseded`;

export type LedgerLinesInput = {
  readonly ledger: Ledger;
  readonly entityIds: readonly EntityId[];
  readonly directory: Directory;
  readonly viewer: Viewer;
  readonly allowance: number;
};

export const ledgerLines = ({ ledger, entityIds, directory, viewer, allowance }: LedgerLinesInput): string[] => {
  const chosen = new Set(entityIds);
  const seen = visibleLedger(ledger, viewer);
  const mine = seen.filter(({ entityId }) => chosen.has(entityId));
  const lines = currentEntries(mine).map((entry) => factLine(entry, nameOf(seen, directory, entry.entityId)));
  let room = allowance - lines.reduce((sum, line) => sum + estimateTokens(line), NONE);
  const superseded = mine.filter(({ supersededBy }) => supersededBy !== null).reverse();
  const reserve = [...new Set(superseded.map(({ entityId }) => entityId))].reduce(
    (sum, entityId) => sum + estimateTokens(condensedLine(nameOf(seen, directory, entityId), superseded.length)),
    NONE,
  );
  let historyRoom = room - reserve;
  const history: string[] = [];
  const dropped = new Map<EntityId, number>();
  for (const entry of superseded) {
    const line = historyLine(entry, nameOf(seen, directory, entry.entityId));
    const cost = estimateTokens(line);
    if (cost <= historyRoom) {
      history.push(line);
      historyRoom -= cost;
      room -= cost;
    } else dropped.set(entry.entityId, (dropped.get(entry.entityId) ?? NONE) + 1);
  }
  const condensed: string[] = [];
  for (const [entityId, count] of dropped) {
    const line = condensedLine(nameOf(seen, directory, entityId), count);
    const cost = estimateTokens(line);
    if (cost <= room) {
      condensed.push(line);
      room -= cost;
    }
  }
  return [...lines, ...history.reverse(), ...condensed];
};

const groupOf = (entry: LedgerEntry, directory: Directory): StoryMemoryGroup => {
  if (entry.kind === THREAD_KIND) return 'thread';
  return directory.get(entry.entityId)?.kind === PLACE_ENTITY ? 'place' : 'person';
};

export const storyMemoryOf = (ledger: Ledger, directory: Directory, viewer: Viewer): StoryMemory => {
  const seen = visibleLedger(ledger, viewer);
  const shown = currentEntries(seen).filter(({ kind }) => PLAYER_VIEW_KINDS.includes(kind));
  const grouped: Record<StoryMemoryGroup, StoryMemoryEntry[]> = { person: [], place: [], thread: [] };
  for (const entry of shown) {
    grouped[groupOf(entry, directory)].push({
      entityId: entry.entityId,
      entityName: nameOf(seen, directory, entry.entityId),
      kind: entry.kind,
      key: entry.key,
      value: entry.value,
      sourceEventId: entry.eventId,
      corrected: entry.corrected,
    });
  }
  return grouped;
};
