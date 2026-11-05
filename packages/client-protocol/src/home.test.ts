import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasSearch, homeCards, relativeTime, SEARCH_AFTER } from './home.ts';
import type { CampaignSummary } from './protocol.ts';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const summary = (name: string, overrides: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: `id-${name}`,
  name,
  health: 'ok',
  lastPlayedAt: null,
  sceneTitle: null,
  characters: [],
  ruleset: null,
  genre: null,
  lastNarration: null,
  turnCount: 0,
  ...overrides,
});

const EMBER = summary('Ember', {
  lastPlayedAt: new Date(NOW - 2 * DAY_MS).toISOString(),
  sceneTitle: 'Docks',
  characters: [{ id: 'ash', name: 'Ash' }],
  ruleset: { id: 'narrative', edition: 'original', revision: 'r1', provenance: 'explicit' },
  genre: { id: 'fantasy', version: '1.0.0', provenance: 'derived' },
  lastNarration: 'The tide turns.',
});

test('rpg-42a.13 home cards sort by last played and show where the player stopped', () => {
  const frost = summary('Frost', { lastPlayedAt: new Date(NOW - HOUR_MS).toISOString() });
  const never = summary('Aldo');
  const cards = homeCards([never, EMBER, frost]);
  assert.deepEqual(
    cards.map(({ name }) => name),
    ['Frost', 'Ember', 'Aldo'],
  );
  assert.deepEqual(cards[1], {
    name: 'Ember',
    health: 'ok',
    playable: true,
    characters: 'Ash',
    rules: 'narrative original, fantasy',
    scene: 'Docks',
    narration: 'The tide turns.',
    lastPlayedAt: EMBER.lastPlayedAt,
  });
  assert.equal(cards[2]?.rules, undefined);
});

test('rpg-42a.13 unhealthy campaigns stay listed but cannot be continued', () => {
  const cards = homeCards([
    summary('Junk', { id: null, health: 'unreadable' }),
    summary('Old', { health: 'needs-migration' }),
  ]);
  assert.deepEqual(
    cards.map(({ name, health, playable }) => [name, health, playable]),
    [
      ['Junk', 'unreadable', false],
      ['Old', 'needs-migration', false],
    ],
  );
});

test('rpg-42a.13 search appears only after more than a handful of campaigns and matches any shown detail', () => {
  const many = Array.from({ length: SEARCH_AFTER }, (_, index) => summary(`Tale ${index}`));
  assert.equal(hasSearch(many), false);
  assert.equal(hasSearch([...many, EMBER]), true);
  assert.deepEqual(
    homeCards([...many, EMBER], ' ash ').map(({ name }) => name),
    ['Ember'],
  );
  assert.deepEqual(
    homeCards([...many, EMBER], 'FANTASY').map(({ name }) => name),
    ['Ember'],
  );
  assert.equal(homeCards([...many, EMBER], '').length, SEARCH_AFTER + 1);
});

test('rpg-42a.13 relative time reads in the player locale and skips unknown times', () => {
  assert.equal(relativeTime(EMBER.lastPlayedAt, NOW, 'en'), '2 days ago');
  assert.equal(relativeTime(new Date(NOW - HOUR_MS).toISOString(), NOW, 'en'), '1 hour ago');
  assert.equal(relativeTime(new Date(NOW).toISOString(), NOW, 'en'), 'now');
  assert.equal(relativeTime(EMBER.lastPlayedAt, NOW, 'es'), 'anteayer');
  assert.equal(relativeTime(null, NOW, 'en'), undefined);
  assert.equal(relativeTime('not a date', NOW, 'en'), undefined);
});
