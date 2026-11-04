import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENT_BUCKETS } from '../../domain/src/campaign.ts';
import { classifyEvent, type EventRelevance, type PlayerContext } from './relevance.ts';

const player: PlayerContext = {
  playerId: 'hero',
  locationId: 'harbor',
  knownEntityIds: ['guild'],
  storylineIds: ['smuggling'],
};

const event = (overrides: Partial<EventRelevance> = {}): EventRelevance => ({
  eventId: 'e1',
  involvedEntityIds: [],
  locationId: null,
  storylineId: null,
  directEffect: false,
  ...overrides,
});

describe('classifyEvent', () => {
  it('classify canonical events as background, emerging, major or critical based on player context', () => {
    assert.equal(classifyEvent(event({ involvedEntityIds: ['stranger'] }), player), 'background');
    assert.equal(classifyEvent(event({ involvedEntityIds: ['guild'] }), player), 'emerging');
    assert.equal(classifyEvent(event({ storylineId: 'smuggling' }), player), 'major');
    assert.equal(classifyEvent(event({ locationId: 'harbor' }), player), 'major');
    assert.equal(classifyEvent(event({ involvedEntityIds: ['hero'] }), player), 'major');
    assert.equal(classifyEvent(event({ directEffect: true }), player), 'critical');
  });

  it('caps non-direct events at the pacing target', () => {
    assert.equal(classifyEvent(event({ storylineId: 'smuggling' }), player, 'emerging'), 'emerging');
    assert.equal(classifyEvent(event({ involvedEntityIds: ['guild'] }), player, 'major'), 'emerging');
  });

  it('critical direct effects cannot be suppressed just to hit a pacing target', () => {
    for (const target of EVENT_BUCKETS)
      assert.equal(
        classifyEvent(event({ directEffect: true, involvedEntityIds: ['hero'] }), player, target),
        'critical',
      );
  });

  it('fails closed to critical on malformed input', () => {
    const malformed: unknown[] = [
      null,
      {},
      { ...event(), involvedEntityIds: 'hero' },
      { ...event(), directEffect: 'no' },
    ];
    for (const raw of malformed) assert.equal(classifyEvent(raw as EventRelevance, player, 'background'), 'critical');
    assert.equal(classifyEvent(event(), { ...player, knownEntityIds: null } as never, 'background'), 'critical');
    assert.equal(classifyEvent(event({ directEffect: true }), player, 'bogus' as never), 'critical');
    assert.equal(classifyEvent(event({ storylineId: 'smuggling' }), player, 'bogus' as never), 'major');
  });
});
