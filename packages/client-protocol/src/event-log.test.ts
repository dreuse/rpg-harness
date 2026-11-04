import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createEventLog } from './event-log.ts';
import { type ClientEvent, EVENT_COMMITTED, PROTOCOL_VERSION, toClientEvent } from './protocol.ts';
import { type MechanicResult, VISUALIZATION_EVENT } from './visualization.ts';

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

const revisions = (events: readonly ClientEvent[]) =>
  events.flatMap((event) => (event.type === EVENT_COMMITTED ? [event.revision] : []));
const SHOWN = { enabled: true };
const roll = (resultId: string, visibility: MechanicResult['visibility']): MechanicResult => ({
  resultId,
  mechanic: 'd20',
  visibility,
  reveals: [{ kind: 'die', sides: 20, face: 7 }],
  total: 7,
});
const visualized = (events: readonly ClientEvent[]) =>
  events.flatMap((event) => (event.type === VISUALIZATION_EVENT ? [event.resultId] : []));
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
    received.map((event) => (event.type === EVENT_COMMITTED ? event.event.id : undefined)),
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

test('delivers versioned visualizations only to viewer scopes that may see the result', () => {
  const log = createEventLog(TIMELINE);
  log.publish(clientEvent(1));
  const player: ClientEvent[] = [];
  const unscoped: ClientEvent[] = [];
  const gm: ClientEvent[] = [];
  log.subscribe(0, (event) => player.push(event), 'player');
  log.subscribe(0, (event) => unscoped.push(event));
  log.subscribe(0, (event) => gm.push(event), 'gm');
  log.visualize(roll('open', 'public'), SHOWN);
  log.visualize(roll('secret', 'gm'), SHOWN);
  log.visualize(roll('muted', 'public'), { enabled: false });
  assert.deepEqual(visualized(player), ['open']);
  assert.deepEqual(visualized(unscoped), ['open']);
  assert.deepEqual(visualized(gm), ['open', 'secret']);
  assert.ok([...player, ...gm].every((event) => event.version === PROTOCOL_VERSION));
});

test('visualizations leave the revision sequence and replay untouched', () => {
  const log = createEventLog(TIMELINE);
  log.publish(clientEvent(1));
  log.visualize(roll('open', 'public'), SHOWN);
  assert.ok(log.publish(clientEvent(2)).ok);
  const late: ClientEvent[] = [];
  log.subscribe(0, (event) => late.push(event));
  assert.deepEqual(revisions(late), [1, 2]);
  assert.deepEqual(visualized(late), []);
});
