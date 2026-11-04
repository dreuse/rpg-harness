import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  concludeStoryline,
  DEFAULT_PACING,
  type PacingState,
  type PendingEvent,
  selectSurfaced,
  startScene,
} from './pacing.ts';

const DICE_KEY = /roll|dice|die|rng|seed|modifier|dc/i;
const MANY_EVENTS = 12;
const STORYLINE_A = 'storyline-heist';
const STORYLINE_B = 'storyline-coup';

const event = (id: string, overrides: Partial<PendingEvent> = {}): PendingEvent => ({
  id,
  bucket: 'emerging',
  storylineId: null,
  solicited: false,
  ...overrides,
});

const state = (overrides: Partial<PacingState> = {}): PacingState => ({
  intent: 'balanced',
  tension: 'calm',
  attention: DEFAULT_PACING.attentionPerScene.balanced,
  interruptions: DEFAULT_PACING.interruptionsPerScene.balanced,
  storylines: [],
  ...overrides,
});

const keysOf = (value: unknown): string[] =>
  value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
    : [];

test('represents scene tension, pacing intent and attention budget without manipulating dice', () => {
  const input = state();
  const pending = [event('event-1'), event('event-2', { bucket: 'critical' }), event('event-3', { bucket: 'major' })];
  Object.freeze(input);
  pending.forEach(Object.freeze);

  const first = selectSurfaced(input, pending);
  const second = selectSurfaced(input, pending);
  assert.deepEqual(first, second);
  assert.deepEqual(startScene(first.state), startScene(second.state));

  assert.equal(first.state.intent, 'balanced');
  assert.equal(first.state.tension, DEFAULT_PACING.criticalTension);
  assert.equal(typeof first.state.attention, 'number');
  assert.deepEqual(
    [...keysOf(first), ...keysOf(startScene(first.state)), ...keysOf(DEFAULT_PACING)].filter((key) =>
      DICE_KEY.test(key),
    ),
    [],
  );
});

test('quiet scenes remain possible even with outstanding world activity', () => {
  const pending = Array.from({ length: MANY_EVENTS }, (_, index) =>
    event(`event-${index}`, { bucket: index % 2 === 0 ? 'background' : 'major', storylineId: `storyline-${index}` }),
  );
  const relaxed = startScene(state({ intent: 'relaxed' }));

  const result = selectSurfaced(relaxed, pending);

  assert.deepEqual(result.surfaced, []);
  assert.deepEqual(result.pending, pending);
  assert.equal(result.state.tension, 'calm');
});

test('critical events always surface, even with no attention or interruptions left', () => {
  const exhausted = state({ intent: 'relaxed', attention: 0, interruptions: 0 });
  const critical = event('event-collapse', { bucket: 'critical' });

  const result = selectSurfaced(exhausted, [event('event-rumor'), critical]);

  assert.deepEqual(result.surfaced, [critical]);
  assert.deepEqual(result.pending, [event('event-rumor')]);
  assert.equal(result.state.attention, 0);
  assert.equal(result.state.tension, DEFAULT_PACING.criticalTension);
});

test('an exhausted attention budget keeps events pending instead of dropping them', () => {
  const solicited = [event('event-a', { solicited: true }), event('event-b', { solicited: true })];
  const result = selectSurfaced(state({ attention: DEFAULT_PACING.bucketCost.emerging }), solicited);

  assert.deepEqual(result.surfaced, [solicited[0]]);
  assert.deepEqual(result.pending, [solicited[1]]);
  assert.equal(result.state.attention, 0);
  assert.deepEqual(selectSurfaced(result.state, result.pending).surfaced, []);
});

test('background events never consume attention unless surfaced', () => {
  const background = event('event-harvest', { bucket: 'background' });
  const blocked = selectSurfaced(state({ interruptions: 0 }), [background]);
  assert.equal(blocked.state.attention, DEFAULT_PACING.attentionPerScene.balanced);
  assert.deepEqual(blocked.pending, [background]);

  const shown = selectSurfaced(state(), [background]);
  assert.deepEqual(shown.surfaced, [background]);
  assert.equal(shown.state.attention, DEFAULT_PACING.attentionPerScene.balanced - DEFAULT_PACING.bucketCost.background);
});

test('tension recovers after a high-tension scene with no unsolicited interruptions', () => {
  const recovering = startScene(state({ tension: 'peak' }));
  assert.equal(recovering.tension, 'high');
  assert.equal(recovering.interruptions, 0);
  assert.equal(recovering.attention, DEFAULT_PACING.attentionPerScene.balanced);

  const unsolicited = event('event-ambush-rumor');
  assert.deepEqual(selectSurfaced(recovering, [unsolicited]).surfaced, []);
  const asked = event('event-asked', { solicited: true });
  assert.deepEqual(selectSurfaced(recovering, [asked]).surfaced, [asked]);

  const calmer = startScene(startScene(recovering));
  assert.equal(calmer.tension, 'calm');
  assert.equal(calmer.interruptions, DEFAULT_PACING.interruptionsPerScene.balanced);
  assert.equal(startScene(calmer).tension, 'calm');
});

test('at most one new major optional storyline is introduced at a time', () => {
  const pending = [
    event('event-heist', { bucket: 'major', storylineId: STORYLINE_A, solicited: true }),
    event('event-coup', { bucket: 'major', storylineId: STORYLINE_B, solicited: true }),
  ];
  const roomy = state({ intent: 'intense', attention: MANY_EVENTS, interruptions: MANY_EVENTS });

  const result = selectSurfaced(roomy, pending);
  assert.deepEqual(result.surfaced, [pending[0]]);
  assert.deepEqual(result.state.storylines, [STORYLINE_A]);

  const followUp = event('event-heist-2', { bucket: 'major', storylineId: STORYLINE_A, solicited: true });
  assert.deepEqual(selectSurfaced(result.state, [followUp]).surfaced, [followUp]);

  const freed = concludeStoryline(result.state, STORYLINE_A);
  assert.deepEqual(selectSurfaced(freed, result.pending).surfaced, [pending[1]]);
  assert.deepEqual(selectSurfaced(roomy, pending, { ...DEFAULT_PACING, maxActiveStorylines: 2 }).surfaced, pending);
});

test('repeated unsolicited interruptions are limited per scene', () => {
  const pending = [event('event-1'), event('event-2'), event('event-3')];
  const result = selectSurfaced(state(), pending);

  assert.equal(result.surfaced.length, DEFAULT_PACING.interruptionsPerScene.balanced);
  assert.equal(result.state.interruptions, 0);
  assert.deepEqual(selectSurfaced(result.state, result.pending).surfaced, []);
  assert.equal(startScene(result.state).interruptions, DEFAULT_PACING.interruptionsPerScene.balanced);
});

test('higher priority buckets surface first while keeping input order within a bucket', () => {
  const pending = [
    event('event-bg', { bucket: 'background', solicited: true }),
    event('event-em', { solicited: true }),
    event('event-major', { bucket: 'major', storylineId: STORYLINE_A, solicited: true }),
  ];
  const result = selectSurfaced(state({ attention: DEFAULT_PACING.bucketCost.major }), pending);

  assert.deepEqual(result.surfaced, [pending[2]]);
  assert.deepEqual(result.pending, [pending[0], pending[1]]);
});
