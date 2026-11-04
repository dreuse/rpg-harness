import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createEventLog } from './event-log.ts';
import { type ClientEvent, toClientEvent } from './protocol.ts';

const CAMPAIGN_ID = 'campaign-1';
const TIMELINE = { campaignId: CAMPAIGN_ID, branchId: MAIN_BRANCH };

const clientEvent = (revision: number, overrides: { id?: string; campaignId?: string; branchId?: string } = {}) =>
  toClientEvent({
    id: `event-${revision}`,
    campaignId: CAMPAIGN_ID,
    branchId: MAIN_BRANCH,
    turnId: null,
    actorId: null,
    causationId: null,
    type: 'SceneOpened',
    payload: {},
    revision,
    ...overrides,
  });

const revisions = (events: readonly ClientEvent[]) => events.map(({ revision }) => revision);
const code = (result: ReturnType<ReturnType<typeof createEventLog>['publish']>) =>
  result.ok ? undefined : result.error.code;

test('replays from a revision, fans out to every subscriber and drops duplicate events', () => {
  const log = createEventLog(TIMELINE);
  log.publish(clientEvent(1));
  log.publish(clientEvent(2));
  const first: ClientEvent[] = [];
  const second: ClientEvent[] = [];
  log.subscribe(1, (event) => first.push(event));
  const stop = log.subscribe(0, (event) => second.push(event));
  log.publish(clientEvent(2));
  log.publish(clientEvent(3));
  stop();
  log.publish(clientEvent(4));
  assert.deepEqual(revisions(first), [2, 3, 4]);
  assert.deepEqual(revisions(second), [1, 2, 3]);
});

test('accepts several events committed at the same revision', () => {
  const log = createEventLog(TIMELINE);
  const received: ClientEvent[] = [];
  log.subscribe(0, (event) => received.push(event));
  assert.ok(log.publish(clientEvent(1)).ok);
  assert.ok(log.publish(clientEvent(1, { id: 'event-1b' })).ok);
  assert.deepEqual(
    received.map(({ event }) => event.id),
    ['event-1', 'event-1b'],
  );
});

test('rejects revision gaps, stale revisions and events from another campaign or branch', () => {
  const log = createEventLog(TIMELINE);
  const received: ClientEvent[] = [];
  log.subscribe(0, (event) => received.push(event));
  assert.ok(log.publish(clientEvent(1)).ok);
  assert.ok(log.publish(clientEvent(2)).ok);
  assert.equal(code(log.publish(clientEvent(4))), 'Rejected');
  assert.equal(code(log.publish(clientEvent(1, { id: 'late' }))), 'Rejected');
  assert.equal(code(log.publish(clientEvent(3, { campaignId: 'campaign-2' }))), 'Rejected');
  assert.equal(code(log.publish(clientEvent(3, { branchId: 'what-if' }))), 'Rejected');
  assert.ok(log.publish(clientEvent(3)).ok);
  assert.deepEqual(revisions(received), [1, 2, 3]);
});

test('a throwing listener does not starve the other listeners', () => {
  const log = createEventLog(TIMELINE);
  log.publish(clientEvent(1));
  const received: ClientEvent[] = [];
  const fail = () => {
    throw new Error('renderer crashed');
  };
  log.subscribe(0, fail);
  log.subscribe(0, (event) => received.push(event));
  assert.ok(log.publish(clientEvent(2)).ok);
  assert.deepEqual(revisions(received), [1, 2]);
});
