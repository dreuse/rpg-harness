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
import { GM_USAGE_RECORDED } from '../../domain/src/gm.ts';
import { createLiveAccumulator, LIVE_PROJECTION_VERSION, liveProjection, RECENT_TURN_WINDOW } from './live.ts';

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
  assert.deepEqual(fold(events.slice(half), stored), fold(events));
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
