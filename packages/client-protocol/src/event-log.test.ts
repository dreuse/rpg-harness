import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createEventLog } from './event-log.ts';
import { type ClientEvent, toClientEvent } from './protocol.ts';

const clientEvent = (revision: number): ClientEvent =>
  toClientEvent({
    id: `event-${revision}`,
    campaignId: 'campaign-1',
    branchId: MAIN_BRANCH,
    turnId: null,
    actorId: null,
    causationId: null,
    type: 'SceneOpened',
    payload: {},
    revision,
  });

const revisions = (events: readonly ClientEvent[]) => events.map(({ revision }) => revision);

test('replays from a revision, fans out to every subscriber and drops duplicate revisions', () => {
  const log = createEventLog();
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
