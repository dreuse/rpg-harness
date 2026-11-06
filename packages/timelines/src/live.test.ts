import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTION_VALIDATED,
  CAMPAIGN_CONFIGURED,
  CHECK_RESOLVED,
  type DomainEvent,
  MAIN_BRANCH,
  PLAYER_ACTION_SUBMITTED,
} from '../../domain/src/campaign.ts';
import type { Visibility } from '../../domain/src/entity.ts';
import { GM_USAGE_RECORDED } from '../../domain/src/gm.ts';
import { createLiveAccumulator, LIVE_PROJECTION_VERSION, liveProjection, RECENT_TURN_WINDOW } from './live.ts';
import { audienceOf, EMPTY_LIVE_FOLDS, visibleFoldsOf, worldOf } from './live-folds.ts';

const CAMPAIGN = 'campaign-1';
const TURN = 'turn-1';
const VOICE_SAVED = 'VoiceSettingsSaved';
const SESSION = 'session-1';
const USAGE = { model: 'haiku', inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 };
const FIRST = 1;
const LAST_REVISION = 9999;
const WINDOWS = 3;
const HALVES = 2;

const eventOf = (index: number, type: string, payload: Record<string, unknown> = {}, turnId: string | null = TURN) =>
  ({
    id: `event-${index}`,
    campaignId: CAMPAIGN,
    branchId: MAIN_BRANCH,
    turnId,
    actorId: null,
    revision: index,
    causationId: null,
    type,
    payload,
  }) satisfies DomainEvent;

const chatter = (from: number, turns: number) =>
  Array.from({ length: turns * HALVES }, (_, offset) =>
    eventOf(
      from + offset,
      offset % HALVES === 0 ? PLAYER_ACTION_SUBMITTED : ACTION_VALIDATED,
      {},
      `chatter-${Math.floor(offset / HALVES)}`,
    ),
  );

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const fold = (events: readonly DomainEvent[], from = liveProjection.initial) =>
  events.reduce(liveProjection.apply, from);

test('live projection keeps state-bearing events forever and only a window of high-volume ones', () => {
  const config = eventOf(FIRST, CAMPAIGN_CONFIGURED, { config: { genre: 'noir' } });
  const state = fold([
    config,
    ...chatter(FIRST + 1, RECENT_TURN_WINDOW * WINDOWS),
    eventOf(LAST_REVISION, CHECK_RESOLVED),
  ]);
  assert.equal(state.count, RECENT_TURN_WINDOW * WINDOWS * HALVES + HALVES);
  assert.equal(state.events[0]?.type, CAMPAIGN_CONFIGURED);
  assert.equal(state.events.length, (RECENT_TURN_WINDOW - FIRST) * HALVES + HALVES);
  assert.equal(state.events.at(-1)?.type, CHECK_RESOLVED);
  assert.deepEqual(Object.keys(state.events[0] ?? {}).sort(), [
    'campaignId',
    'causationId',
    'id',
    'payload',
    'turnId',
    'type',
  ]);
});

test('live projection keeps the newest change per type and sums GM usage per session', () => {
  const state = fold([
    eventOf(1, VOICE_SAVED, { settings: 'old' }, null),
    eventOf(2, VOICE_SAVED, { settings: 'new' }, null),
    eventOf(3, GM_USAGE_RECORDED, { sessionId: SESSION, usage: USAGE }, null),
    eventOf(4, GM_USAGE_RECORDED, { sessionId: SESSION, usage: USAGE }, null),
  ]);
  assert.deepEqual(state.events, []);
  assert.deepEqual(Object.values(state.changes), [{ type: VOICE_SAVED, payload: { settings: 'new' } }]);
  assert.equal(state.gmUsage.campaign.turns, HALVES);
  assert.equal(state.gmUsage.sessions[SESSION]?.inputTokens, USAGE.inputTokens * HALVES);
});

test('resuming from a stored snapshot state gives the same state as one full fold', () => {
  const events = [eventOf(FIRST, CAMPAIGN_CONFIGURED, { config: {} }), ...chatter(HALVES, RECENT_TURN_WINDOW * HALVES)];
  const half = events.length / HALVES;
  const stored = JSON.parse(JSON.stringify(fold(events.slice(0, half))));
  assert.deepEqual(plain(fold(events.slice(half), stored)), plain(fold(events)));
  assert.equal(LIVE_PROJECTION_VERSION, liveProjection.version);
});

test('the accumulator matches apply and never changes a state it already published', () => {
  const events = [
    eventOf(FIRST, CAMPAIGN_CONFIGURED, { config: {} }),
    ...chatter(HALVES, RECENT_TURN_WINDOW * WINDOWS),
    eventOf(LAST_REVISION, VOICE_SAVED, { settings: 'saved' }, null),
  ];
  const accumulator = createLiveAccumulator(liveProjection.initial);
  for (const event of events.slice(0, FIRST + RECENT_TURN_WINDOW)) accumulator.push(event);
  const published = accumulator.state();
  const publishedLength = published.events.length;
  for (const event of events.slice(FIRST + RECENT_TURN_WINDOW)) accumulator.push(event);
  assert.equal(published.events.length, publishedLength);
  assert.deepEqual(accumulator.state(), fold(events));
});

const quest = (questId: string, title: string) => ({
  questId,
  title,
  objectives: [{ id: 'first', summary: 'Begin' }],
  prerequisites: [],
});
const HERO = 'hero';
const RIVAL = 'rival';
const ENCOUNTER = 'duel';
const NO_ACTOR = null;
const MIXED: readonly (readonly [string, Record<string, unknown>, Visibility, string | null])[] = [
  ['QuestDefined', quest('ferry', 'Find the ferryman'), 'player', NO_ACTOR],
  ['QuestDefined', quest('plot', 'Secret plot'), 'gm', NO_ACTOR],
  ['QuestDefined', quest('scheme', 'Quiet scheme'), 'actor-scoped', RIVAL],
  ['QuestActivated', { questId: 'ferry' }, 'player', NO_ACTOR],
  ['QuestActivated', { questId: 'scheme' }, 'actor-scoped', RIVAL],
  ['QuestObjectiveCompleted', { questId: 'ferry', objectiveId: 'first' }, 'public', NO_ACTOR],
  ['QuestFailed', { questId: 'plot', reason: 'lost' }, 'gm', NO_ACTOR],
  ['EncounterStarted', { encounterId: ENCOUNTER, participants: [HERO, RIVAL], sheets: [] }, 'public', NO_ACTOR],
  ['EncounterTurnAdvanced', { encounterId: ENCOUNTER, round: 1, actorId: RIVAL }, 'public', NO_ACTOR],
  ['EncounterResolved', { encounterId: ENCOUNTER, outcome: 'yield' }, 'gm', NO_ACTOR],
  ['ClockDefined', { clockId: 'alarm', label: 'Alarm', segments: 3 }, 'gm', NO_ACTOR],
  ['ClockTicked', { clockId: 'alarm', current: 2 }, 'gm', NO_ACTOR],
  [
    'DelayedEffectScheduled',
    { effectId: 'bell', due: { kind: 'time', at: 5 }, effect: { summary: 'Ring' } },
    'gm',
    NO_ACTOR,
  ],
  ['GameTimeAdvanced', { now: 6 }, 'gm', NO_ACTOR],
  ['DelayedEffectFired', { effectId: 'bell' }, 'gm', NO_ACTOR],
];
const SCOPES = [
  { scope: 'gm' },
  { scope: 'player' },
  { scope: 'actor', actorId: RIVAL },
  { scope: 'actor', actorId: HERO },
] as const;
const readableBy = (scope: (typeof SCOPES)[number], visibility: Visibility, actorId: string | null) => {
  if (scope.scope === 'gm') return true;
  if (scope.scope === 'player') return visibility === 'public' || visibility === 'player';
  return visibility === 'public' || (visibility === 'actor-scoped' && actorId === scope.actorId);
};
const mixedEvents = () =>
  MIXED.map(([type, payload, visibility, actorId], index) => ({
    event: { ...eventOf(index + FIRST, type, payload), turnId: TURN, actorId },
    visibility,
  }));

test('projected quest, encounter and clock folds equal a full fold over the visible events', () => {
  const accumulator = createLiveAccumulator(liveProjection.initial);
  for (const { event, visibility } of mixedEvents()) accumulator.push(event, visibility);
  const { folds } = accumulator.state();
  for (const scope of SCOPES) {
    const visible = mixedEvents().filter(({ event, visibility }) => readableBy(scope, visibility, event.actorId));
    assert.deepEqual(plain(audienceOf(folds, scope)), plain(visibleFoldsOf(visible.map(({ event }) => event))));
  }
  assert.deepEqual(plain(folds.world), plain(worldOf(mixedEvents().map(({ event }) => event))));
  assert.equal(folds.world.now, 6);
  assert.equal(folds.world.effects[0]?.fired, true);
  assert.deepEqual(
    audienceOf(folds, { scope: 'actor', actorId: 'stranger' }),
    audienceOf(folds, { scope: 'actor', actorId: HERO }),
  );
});

test('resuming folds from a stored snapshot state equals one full run, and published folds never change', () => {
  const events = mixedEvents();
  const full = createLiveAccumulator(liveProjection.initial);
  for (const { event, visibility } of events) full.push(event, visibility);
  const half = Math.floor(events.length / HALVES);
  const first = createLiveAccumulator(liveProjection.initial);
  for (const { event, visibility } of events.slice(0, half)) first.push(event, visibility);
  const published = first.state();
  const frozen = JSON.stringify(published.folds);
  const resumed = createLiveAccumulator(JSON.parse(JSON.stringify(published)));
  for (const { event, visibility } of events.slice(half)) {
    first.push(event, visibility);
    resumed.push(event, visibility);
  }
  assert.equal(JSON.stringify(published.folds), frozen);
  assert.deepEqual(plain(resumed.state().folds), plain(full.state().folds));
  assert.deepEqual(plain(first.state().folds), plain(full.state().folds));
});

test('only turn events feed the folds and a new live projection version skips old snapshots', () => {
  const accumulator = createLiveAccumulator(liveProjection.initial);
  accumulator.push(eventOf(FIRST, 'QuestDefined', quest('stray', 'Stray'), null), 'public');
  assert.deepEqual(accumulator.state().folds, EMPTY_LIVE_FOLDS);
  assert.ok(LIVE_PROJECTION_VERSION > 1);
});
