import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampaignBoundaryError, type CampaignEvent } from '../../domain/src/campaign.ts';
import {
  condense,
  SUMMARY_WRITTEN,
  type Summary,
  searchEvents,
  searchSummaries,
  searchVisibleEvents,
  summariesOf,
  summarize,
  UnknownEvidenceError,
} from './history.ts';
import { canonicalFacts, type Fact, GM_VIEWER, PLAYER_VIEWER, type Viewer } from './knowledge.ts';

const CAMPAIGN_ID = 'campaign-1';
const OTHER_CAMPAIGN_ID = 'campaign-2';
const MISSING_EVENT_ID = 'event-missing';
const SMITH_VIEWER: Viewer = { scope: 'actor', actorId: 'npc-smith' };

const event = (id: string, type: string, payload: Record<string, unknown>): CampaignEvent => ({
  id,
  campaignId: CAMPAIGN_ID,
  turnId: `turn-${id}`,
  causationId: null,
  type,
  payload,
});

const EVENTS: readonly CampaignEvent[] = [
  event('event-1', 'npc.spoke', { speakerId: 'npc-innkeeper', line: 'The Bridge collapsed at dawn' }),
  event('event-2', 'item.found', { itemId: 'item-ledger', note: 'A torn ledger page' }),
  event('event-3', 'npc.spoke', { speakerId: 'npc-mayor', line: 'The cult pays the bridge toll' }),
];
const CANON: Fact = {
  id: 'fact-bridge',
  campaignId: CAMPAIGN_ID,
  subjectId: null,
  statement: 'The bridge collapsed at dawn',
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: 'event-1',
};

const draft = (id: string, sourceEventIds: readonly string[], overrides: Partial<Summary> = {}): Summary => ({
  id,
  campaignId: CAMPAIGN_ID,
  text: `summary ${id}`,
  sourceEventIds,
  visibility: 'public',
  actorId: null,
  ...overrides,
});

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

test('D07: provide full-text event search, summaries and provenance-preserving condensation', () => {
  assert.deepEqual(
    searchEvents(EVENTS, 'BRIDGE dawn', GM_VIEWER).map((found) => found.id),
    ['event-1'],
  );
  assert.deepEqual(
    searchEvents(EVENTS, 'bridge', GM_VIEWER).map((found) => found.id),
    ['event-1', 'event-3'],
  );
  assert.deepEqual(
    searchEvents(EVENTS, 'npc.spoke', GM_VIEWER).map((found) => found.id),
    ['event-1', 'event-3'],
  );
  assert.deepEqual(searchEvents(EVENTS, '   ', GM_VIEWER), []);

  const collapse = summarize(EVENTS, draft('summary-collapse', ['event-1', 'event-1']));
  const ledger = summarize(EVENTS, draft('summary-ledger', ['event-2'], { text: 'The party found a torn ledger' }));
  assert.deepEqual(collapse.sourceEventIds, ['event-1']);

  const chapter = condense(EVENTS, { id: 'summary-chapter', text: 'Chapter one: the bridge and the ledger' }, [
    ledger,
    collapse,
  ]);
  assert.deepEqual(chapter.sourceEventIds, ['event-1', 'event-2']);
  assert.equal(chapter.visibility, 'public');

  const secret = summarize(
    EVENTS,
    draft('summary-cult', ['event-3'], { text: 'The cult pays the toll', visibility: 'gm' }),
  );
  const smithMemory = summarize(
    EVENTS,
    draft('summary-smith', ['event-2'], {
      text: 'Smith remembers the ledger',
      visibility: 'actor-scoped',
      actorId: 'npc-smith',
    }),
  );
  const summaries = [chapter, secret, smithMemory];
  assert.deepEqual(
    searchSummaries(summaries, 'ledger', PLAYER_VIEWER).map((found) => found.id),
    ['summary-chapter'],
  );
  assert.deepEqual(
    searchSummaries(summaries, 'ledger', SMITH_VIEWER).map((found) => found.id),
    ['summary-chapter', 'summary-smith'],
  );
  assert.deepEqual(
    searchSummaries(summaries, 'toll', GM_VIEWER).map((found) => found.id),
    ['summary-cult'],
  );
});

test('D07: search never leaks hidden events or summaries to player-visible queries', () => {
  assert.deepEqual(searchEvents(EVENTS, 'cult', PLAYER_VIEWER), []);
  assert.deepEqual(searchEvents(EVENTS, 'cult', SMITH_VIEWER), []);
  const secret = summarize(
    EVENTS,
    draft('summary-cult', ['event-3'], { text: 'The cult pays the toll', visibility: 'gm' }),
  );
  assert.deepEqual(searchSummaries([secret], 'cult', PLAYER_VIEWER), []);
});

test('D07: summaries cannot alter canonical fact records or claim non-existent evidence', () => {
  const events = deepFreeze(EVENTS.map((entry) => structuredClone(entry)));
  const facts = deepFreeze([structuredClone(CANON)]);
  const before = structuredClone({ events, facts });

  const summary = summarize(events, draft('summary-collapse', ['event-1'], { text: 'The bridge never collapsed' }));
  const condensed = condense(events, { id: 'summary-all', text: 'Nothing happened' }, [summary]);
  assert.deepEqual({ events, facts }, before);
  assert.deepEqual(canonicalFacts(facts, GM_VIEWER), [CANON]);
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.sourceEventIds));
  assert.ok(Object.isFrozen(condensed));
  assert.throws(() => {
    (summary.sourceEventIds as string[]).push(MISSING_EVENT_ID);
  }, TypeError);

  assert.throws(
    () => summarize(events, draft('summary-fake', ['event-1', MISSING_EVENT_ID])),
    (error: unknown) => {
      assert.ok(error instanceof UnknownEvidenceError);
      assert.deepEqual(error.eventIds, [MISSING_EVENT_ID]);
      return true;
    },
  );
  assert.throws(() => summarize(events, draft('summary-empty', [])), UnknownEvidenceError);
  const forged: Summary = { ...summary, sourceEventIds: [MISSING_EVENT_ID] };
  assert.throws(() => condense(events, { id: 'summary-forged', text: 'forged' }, [forged]), UnknownEvidenceError);
  assert.throws(() => condense(events, { id: 'summary-none', text: 'nothing' }, []), UnknownEvidenceError);
  assert.throws(
    () => summarize(events, draft('summary-foreign', ['event-1'], { campaignId: OTHER_CAMPAIGN_ID })),
    CampaignBoundaryError,
  );

  const secret = summarize(events, draft('summary-cult', ['event-3'], { visibility: 'gm' }));
  assert.throws(() => condense(events, { id: 'summary-mixed', text: 'mixed' }, [summary, secret]), RangeError);
});

test('rpg-42a.36 written summaries are read back from events and visible events are searchable by scope', () => {
  const scene = summarize(EVENTS, draft('summary-scene', ['event-1']));
  const written = event('event-summary', SUMMARY_WRITTEN, { level: 'scene', scopeId: 'scene-1', summary: scene });
  assert.deepEqual(summariesOf([...EVENTS, written]), [{ level: 'scene', scopeId: 'scene-1', summary: scene }]);

  const scoped = EVENTS.map((entry, index) => ({
    ...entry,
    visibility: index === 2 ? ('gm' as const) : ('player' as const),
    actorId: null,
  }));
  assert.deepEqual(
    searchVisibleEvents(scoped, 'bridge', PLAYER_VIEWER).map(({ id }) => id),
    ['event-1'],
  );
  assert.deepEqual(
    searchVisibleEvents(scoped, 'bridge', GM_VIEWER).map(({ id }) => id),
    ['event-1', 'event-3'],
  );
});
