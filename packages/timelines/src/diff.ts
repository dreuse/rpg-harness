import { CampaignBoundaryError, type DomainEvent } from '../../domain/src/campaign.ts';
import { type EntityId, VISIBILITY_LEVELS, type Visibility } from '../../domain/src/entity.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import { type Branch, branchHistory, type ForkPoint } from './branches.ts';
import type { Projection, Timeline } from './replay.ts';

export const DIFF_CATEGORIES = ['facts', 'relationships', 'quests', 'resources', 'inventory'] as const;
export type DiffCategory = (typeof DIFF_CATEGORIES)[number];

export type DiffEntry = {
  readonly key: string;
  readonly value: unknown;
  readonly visibility: Visibility;
  readonly actorId: EntityId | null;
};

export type DiffState = { readonly [category in DiffCategory]: readonly DiffEntry[] };

export type EntryChange = { readonly key: string; readonly before: DiffEntry; readonly after: DiffEntry };

export type CategoryDiff = {
  readonly added: readonly DiffEntry[];
  readonly removed: readonly DiffEntry[];
  readonly changed: readonly EntryChange[];
};

export type BranchDiff = { readonly [category in DiffCategory]: CategoryDiff };

export type Viewer =
  | { readonly scope: 'gm' }
  | { readonly scope: 'player' }
  | { readonly scope: 'actor'; readonly actorId: EntityId };

export type HistoryPoint = Timeline & { readonly eventCount?: number };

export class EventCountError extends Error {
  readonly eventCount: number;
  constructor(eventCount: number) {
    super(`event count ${eventCount} is not on the branch history`);
    this.eventCount = eventCount;
  }
}

export class DuplicateDiffKeyError extends Error {
  readonly category: DiffCategory;
  constructor(category: DiffCategory) {
    super(`state holds a duplicate key in ${category}`);
    this.category = category;
  }
}

const NO_EVENTS = 0;
const NOT_FOUND = -1;
const BEFORE = -1;
const AFTER = 1;
const SAME = 0;
const EMPTY_ID = '';
const PUBLIC: Visibility = 'public';
const ACTOR_SCOPED: Visibility = 'actor-scoped';
const PLAYER_READABLE: readonly Visibility[] = [PUBLIC, 'player'];

const readable = ({ visibility, actorId }: DiffEntry, viewer: Viewer): boolean => {
  switch (viewer.scope) {
    case 'gm':
      return VISIBILITY_LEVELS.includes(visibility);
    case 'player':
      return PLAYER_READABLE.includes(visibility);
    case 'actor':
      return (
        typeof viewer.actorId === 'string' &&
        viewer.actorId !== EMPTY_ID &&
        (visibility === PUBLIC || (visibility === ACTOR_SCOPED && actorId === viewer.actorId))
      );
    default:
      return false;
  }
};

const byText =
  <T>(text: (item: T) => string) =>
  (left: T, right: T) => {
    const [a, b] = [text(left), text(right)];
    if (a === b) return SAME;
    return a < b ? BEFORE : AFTER;
  };

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.entries(item).sort(byText(([key]) => key))) : item,
  );

const visible = (entries: readonly DiffEntry[], category: DiffCategory, viewer: Viewer) => {
  const byKey = new Map<string, DiffEntry>();
  for (const entry of entries) {
    if (byKey.has(entry.key)) throw new DuplicateDiffKeyError(category);
    byKey.set(entry.key, entry);
  }
  return new Map([...byKey].filter(([, entry]) => readable(entry, viewer)));
};

const missingFrom = (entries: ReadonlyMap<string, DiffEntry>, other: ReadonlyMap<string, DiffEntry>) =>
  [...entries.values()].filter(({ key }) => !other.has(key)).sort(byText(({ key }) => key));

const diffCategory = (before: ReadonlyMap<string, DiffEntry>, after: ReadonlyMap<string, DiffEntry>): CategoryDiff => ({
  added: missingFrom(after, before),
  removed: missingFrom(before, after),
  changed: [...after.values()]
    .flatMap((entry) => {
      const previous = before.get(entry.key);
      if (previous === undefined || canonical(previous) === canonical(entry)) return [];
      return [{ key: entry.key, before: previous, after: entry }];
    })
    .sort(byText(({ key }) => key)),
});

export const diffStates = (before: DiffState, after: DiffState, viewer: Viewer): BranchDiff =>
  Object.fromEntries(
    DIFF_CATEGORIES.map((category) => [
      category,
      diffCategory(visible(before[category], category, viewer), visible(after[category], category, viewer)),
    ]),
  ) as BranchDiff;

const stateAt = (
  projection: Projection<DiffState>,
  branches: readonly Branch[],
  log: readonly DomainEvent[],
  { eventCount, ...timeline }: HistoryPoint,
) => {
  const history = branchHistory(branches, log, timeline);
  const count = eventCount ?? history.length;
  if (!Number.isInteger(count) || count < NO_EVENTS || count > history.length) throw new EventCountError(count);
  return history.slice(NO_EVENTS, count).reduce(projection.apply, projection.initial);
};

const sameCampaign = (before: Timeline, after: Timeline) => {
  if (before.campaignId !== after.campaignId)
    throw new CampaignBoundaryError(before.campaignId, `campaign ${after.campaignId}`);
};

export const diffBranches = (
  projection: Projection<DiffState>,
  branches: readonly Branch[],
  log: readonly DomainEvent[],
  before: HistoryPoint,
  after: HistoryPoint,
  viewer: Viewer,
): BranchDiff => {
  sameCampaign(before, after);
  return diffStates(stateAt(projection, branches, log, before), stateAt(projection, branches, log, after), viewer);
};

export const divergence = (
  branches: readonly Branch[],
  log: readonly DomainEvent[],
  before: Timeline,
  after: Timeline,
): ForkPoint => {
  sameCampaign(before, after);
  const left = branchHistory(branches, log, before);
  const right = branchHistory(branches, log, after);
  const firstDifference = left.findIndex((event, index) => event.id !== right[index]?.id);
  const eventCount = firstDifference === NOT_FOUND ? left.length : firstDifference;
  return { eventCount, lastEventId: left[eventCount - 1]?.id ?? null };
};
