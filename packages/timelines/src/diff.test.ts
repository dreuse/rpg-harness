import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BranchId, CampaignBoundaryError, type DomainEvent, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import { type Branch, forkBranch } from './branches.ts';
import {
  type BranchDiff,
  DIFF_CATEGORIES,
  type DiffCategory,
  type DiffEntry,
  type DiffState,
  DuplicateDiffKeyError,
  diffBranches,
  divergence,
  EventCountError,
  type Viewer,
} from './diff.ts';
import type { Projection, Timeline } from './replay.ts';

const CAMPAIGN = 'campaign-diff';
const OTHER_CAMPAIGN = 'campaign-other';
const EMPTY_ACTOR = '';
const RECORDED = 'StateRecorded';
const CLEARED = 'StateCleared';
const WHAT_IF = 'what-if';
const PROJECTION_VERSION = 1;
const PUBLIC: Visibility = 'public';
const PLAYER: Visibility = 'player';
const GM: Visibility = 'gm';
const ACTOR_SCOPED: Visibility = 'actor-scoped';
const SPY = 'npc-spy';
const SCOUT = 'npc-scout';
const GM_VIEWER: Viewer = { scope: 'gm' };
const PLAYER_VIEWER: Viewer = { scope: 'player' };
const SPY_VIEWER: Viewer = { scope: 'actor', actorId: SPY };
const SCOUT_VIEWER: Viewer = { scope: 'actor', actorId: SCOUT };
const main: Timeline = { campaignId: CAMPAIGN, branchId: MAIN_BRANCH };

const entry = (
  key: string,
  value: unknown,
  visibility: Visibility = PUBLIC,
  actorId: string | null = null,
): DiffEntry => ({
  key,
  value,
  visibility,
  actorId,
});

type Change = { readonly category: DiffCategory; readonly entry?: DiffEntry; readonly key?: string };

const events = (branchId: BranchId, firstRevision: number, changes: readonly Change[]): DomainEvent[] =>
  changes.map((change, index) => ({
    id: `${branchId}-event-${firstRevision + index}`,
    campaignId: CAMPAIGN,
    branchId,
    turnId: null,
    actorId: null,
    causationId: null,
    revision: firstRevision + index,
    type: change.entry === undefined ? CLEARED : RECORDED,
    payload: change,
  }));

const emptyState = (): DiffState =>
  Object.fromEntries(DIFF_CATEGORIES.map((category) => [category, []])) as unknown as DiffState;

const recorded = (prepend: boolean): Projection<DiffState> => ({
  version: PROJECTION_VERSION,
  initial: emptyState(),
  apply: (state, { type, payload }) => {
    const change = payload as Change;
    const key = change.entry?.key ?? change.key;
    const kept = state[change.category].filter((item) => item.key !== key);
    const next = type === RECORDED && change.entry !== undefined ? [change.entry] : [];
    return { ...state, [change.category]: prepend ? [...next, ...kept] : [...kept, ...next] };
  },
});

const appended = recorded(false);

const emptyDiff = (): BranchDiff =>
  Object.fromEntries(
    DIFF_CATEGORIES.map((category) => [category, { added: [], removed: [], changed: [] }]),
  ) as unknown as BranchDiff;

const OATH = entry('fact-oath', { statement: 'The duke swore an oath', layer: 'canon' });
const FEUD = entry('rel-feud', { sourceId: 'npc-duke', targetId: 'npc-baron', kind: 'rival' });
const ALLY = entry('rel-ally', { sourceId: 'npc-duke', targetId: 'npc-abbess', kind: 'ally' });
const RESCUE = entry('quest-rescue', { status: 'active' });
const FAVOR = entry('resource-favor', { amount: 3 });
const LANTERN = entry('item-lantern', { holderId: 'pc-mira', quantity: 1 });
const ROPE = entry('item-rope', { holderId: 'pc-mira', quantity: 1 });

const sharedLog = () =>
  events(MAIN_BRANCH, 1, [
    { category: 'facts', entry: OATH },
    { category: 'relationships', entry: FEUD },
    { category: 'quests', entry: RESCUE },
    { category: 'resources', entry: FAVOR },
    { category: 'inventory', entry: LANTERN },
  ]);

test('compare facts, relationships, quests, resources and inventory between two branches', () => {
  const shared = sharedLog();
  const branches = forkBranch(
    [],
    shared,
    main,
    { eventCount: shared.length, lastEventId: shared.at(-1)?.id ?? null },
    WHAT_IF,
  );
  const fork = branches[0] as Branch;
  const brokenOath = entry('fact-oath', { statement: 'The duke swore an oath', layer: 'invalidated' });
  const rescued = entry('quest-rescue', { status: 'complete' });
  const spentFavor = entry('resource-favor', { amount: 1 });
  const log = [
    ...shared,
    ...events(fork.branchId, shared.length + 1, [
      { category: 'facts', entry: brokenOath },
      { category: 'relationships', key: FEUD.key },
      { category: 'relationships', entry: ALLY },
      { category: 'quests', entry: rescued },
      { category: 'resources', entry: spentFavor },
      { category: 'inventory', key: LANTERN.key },
      { category: 'inventory', entry: ROPE },
    ]),
  ];

  const diff = diffBranches(appended, branches, log, main, fork, GM_VIEWER);

  assert.deepEqual(diff, {
    facts: { added: [], removed: [], changed: [{ key: OATH.key, before: OATH, after: brokenOath }] },
    relationships: { added: [ALLY], removed: [FEUD], changed: [] },
    quests: { added: [], removed: [], changed: [{ key: RESCUE.key, before: RESCUE, after: rescued }] },
    resources: { added: [], removed: [], changed: [{ key: FAVOR.key, before: FAVOR, after: spentFavor }] },
    inventory: { added: [ROPE], removed: [LANTERN], changed: [] },
  });
  assert.deepEqual(diffBranches(appended, branches, log, fork, fork, GM_VIEWER), emptyDiff());
});

test('historical diff is deterministic and excludes secrets from player view', () => {
  const shared = sharedLog();
  const before = { ...main, eventCount: shared.length };
  const secrets = events(MAIN_BRANCH, shared.length + 1, [
    { category: 'facts', entry: entry('fact-traitor', { statement: 'The abbess is a spy', layer: 'canon' }, GM) },
    { category: 'resources', entry: entry('resource-cover', { amount: 2 }, ACTOR_SCOPED, SPY) },
    { category: 'facts', entry: entry('fact-oath', OATH.value, GM) },
    { category: 'inventory', entry: entry('item-letter', { holderId: SPY }, ACTOR_SCOPED, SPY) },
  ]);
  const log = [...shared, ...secrets];

  assert.deepEqual(diffBranches(appended, [], log, before, main, PLAYER_VIEWER), {
    ...emptyDiff(),
    facts: { added: [], removed: [OATH], changed: [] },
  });
  assert.deepEqual(diffBranches(appended, [], log, before, main, SCOUT_VIEWER), {
    ...emptyDiff(),
    facts: { added: [], removed: [OATH], changed: [] },
  });

  const secretOnly = [
    ...shared,
    ...events(MAIN_BRANCH, shared.length + 1, [
      { category: 'facts', entry: entry('fact-traitor', { statement: 'The abbess is a spy', layer: 'canon' }, GM) },
      { category: 'resources', entry: entry('resource-cover', { amount: 2 }, ACTOR_SCOPED, SPY) },
    ]),
  ];
  assert.deepEqual(diffBranches(appended, [], secretOnly, before, main, PLAYER_VIEWER), emptyDiff());
  assert.deepEqual(diffBranches(appended, [], secretOnly, before, main, SPY_VIEWER), {
    ...emptyDiff(),
    resources: { added: [entry('resource-cover', { amount: 2 }, ACTOR_SCOPED, SPY)], removed: [], changed: [] },
  });

  const gmDiff = diffBranches(appended, [], log, before, main, GM_VIEWER);
  assert.deepEqual(gmDiff, {
    ...emptyDiff(),
    facts: {
      added: [entry('fact-traitor', { statement: 'The abbess is a spy', layer: 'canon' }, GM)],
      removed: [],
      changed: [{ key: OATH.key, before: OATH, after: entry('fact-oath', OATH.value, GM) }],
    },
    resources: { added: [entry('resource-cover', { amount: 2 }, ACTOR_SCOPED, SPY)], removed: [], changed: [] },
    inventory: { added: [entry('item-letter', { holderId: SPY }, ACTOR_SCOPED, SPY)], removed: [], changed: [] },
  });

  assert.deepEqual(diffBranches(recorded(true), [], log, before, main, GM_VIEWER), gmDiff);
  assert.equal(
    JSON.stringify(diffBranches(appended, [], log, before, main, GM_VIEWER)),
    JSON.stringify(diffBranches(recorded(true), [], log, before, main, GM_VIEWER)),
  );
  const reshuffledValue = entry('fact-oath', { layer: 'canon', statement: 'The duke swore an oath' });
  const reshuffled = [
    ...shared,
    ...events(MAIN_BRANCH, shared.length + 1, [{ category: 'facts', entry: reshuffledValue }]),
  ];
  assert.deepEqual(diffBranches(appended, [], reshuffled, before, main, GM_VIEWER), emptyDiff());

  assert.throws(
    () => diffBranches(appended, [], log, { ...main, eventCount: log.length + 1 }, main, GM_VIEWER),
    EventCountError,
  );
  assert.throws(() => diffBranches(appended, [], log, { ...main, eventCount: -1 }, main, GM_VIEWER), EventCountError);
});

test('player view reveals an entry only once it becomes readable, without hidden ordering', () => {
  const hidden = entry('quest-heist', { status: 'planned' }, GM);
  const revealed = entry('quest-heist', { status: 'planned' }, PLAYER);
  const log = events(MAIN_BRANCH, 1, [
    { category: 'quests', entry: hidden },
    { category: 'quests', entry: RESCUE },
    { category: 'quests', entry: revealed },
  ]);

  assert.deepEqual(
    diffBranches(appended, [], log, { ...main, eventCount: 1 }, { ...main, eventCount: 2 }, PLAYER_VIEWER),
    {
      ...emptyDiff(),
      quests: { added: [RESCUE], removed: [], changed: [] },
    },
  );
  assert.deepEqual(diffBranches(appended, [], log, { ...main, eventCount: 2 }, main, PLAYER_VIEWER), {
    ...emptyDiff(),
    quests: { added: [revealed], removed: [], changed: [] },
  });
});

test('duplicate keys in one category are rejected instead of silently picking one', () => {
  const duplicated: Projection<DiffState> = {
    ...appended,
    apply: (state) => ({ ...state, quests: [RESCUE, RESCUE] }),
  };
  const log = events(MAIN_BRANCH, 1, [{ category: 'quests', entry: RESCUE }]);

  assert.throws(
    () => diffBranches(duplicated, [], log, { ...main, eventCount: 0 }, main, PLAYER_VIEWER),
    DuplicateDiffKeyError,
  );
});

test('divergence finds the common fork point of two branches', () => {
  const shared = sharedLog();
  const forkAt = 3;
  const left = forkBranch(
    [],
    shared,
    main,
    { eventCount: forkAt, lastEventId: shared[forkAt - 1]?.id ?? null },
    WHAT_IF,
  );
  const branch = left[0] as Branch;
  const log = [...events(branch.branchId, forkAt + 1, [{ category: 'quests', entry: RESCUE }]), ...shared];
  const forkPoint = { eventCount: forkAt, lastEventId: shared[forkAt - 1]?.id };

  assert.deepEqual(divergence(left, log, main, branch), forkPoint);
  assert.deepEqual(divergence(left, log, branch, main), forkPoint);
  assert.deepEqual(divergence(left, log, main, main), { eventCount: shared.length, lastEventId: shared.at(-1)?.id });
});

test('diff and divergence reject timelines from different campaigns', () => {
  const inCampaign = (campaignId: string, changes: readonly Change[]) =>
    events(MAIN_BRANCH, 1, changes).map((event) => ({ ...event, id: `${campaignId}-${event.id}`, campaignId }));
  const log = [
    ...inCampaign(CAMPAIGN, [{ category: 'facts', entry: entry('fact-a1', { statement: 'a1' }) }]),
    ...inCampaign(OTHER_CAMPAIGN, [
      { category: 'facts', entry: entry('fact-b1', { statement: 'b1' }, GM) },
      { category: 'facts', entry: entry('fact-b2', { statement: 'b2' }) },
    ]),
  ];
  const other: Timeline = { campaignId: OTHER_CAMPAIGN, branchId: MAIN_BRANCH };

  assert.throws(() => diffBranches(appended, [], log, main, other, PLAYER_VIEWER), CampaignBoundaryError);
  assert.throws(() => diffBranches(appended, [], log, other, main, GM_VIEWER), CampaignBoundaryError);
  assert.throws(() => divergence([], log, main, other), CampaignBoundaryError);
});

test('an actor viewer without an actor id sees nothing', () => {
  const log = events(MAIN_BRANCH, 1, [
    { category: 'quests', entry: RESCUE },
    { category: 'resources', entry: entry('resource-cover', { amount: 2 }, ACTOR_SCOPED, EMPTY_ACTOR) },
  ]);
  const before = { ...main, eventCount: 0 };

  assert.deepEqual(
    diffBranches(appended, [], log, before, main, { scope: 'actor', actorId: EMPTY_ACTOR }),
    emptyDiff(),
  );
  assert.deepEqual(diffBranches(appended, [], log, before, main, SPY_VIEWER), {
    ...emptyDiff(),
    quests: { added: [RESCUE], removed: [], changed: [] },
  });
});
