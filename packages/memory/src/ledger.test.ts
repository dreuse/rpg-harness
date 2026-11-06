import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GM_VIEWER, PLAYER_VIEWER } from './knowledge.ts';
import type { Directory } from './ledger.ts';
import {
  buildLedger,
  CLAIM_CORRECTED,
  CLAIM_RECORDED,
  currentEntries,
  ledgerAllowance,
  ledgerLines,
  storyMemoryOf,
  visibleLedger,
} from './ledger.ts';
import { estimateTokens } from './retrieval.ts';

const MAREN = 'maren';
const HARBOR = 'harbor';
const WARDEN = 'warden';
const DIRECTORY: Directory = new Map([
  [MAREN, { name: 'Maren', kind: 'npc' }],
  [HARBOR, { name: 'Harbor', kind: 'location' }],
  [WARDEN, { name: 'Warden', kind: 'npc' }],
]);

const claim = (id: string, entityId: string, kind: string, value: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: CLAIM_RECORDED,
  payload: { entityId, kind, key: kind, value, visibility: 'public', actorId: null, ...extra },
});

test('rpg-42a.42 a later claim supersedes the earlier one and keeps it as history', () => {
  const ledger = buildLedger([claim('e1', MAREN, 'alive', 'alive'), claim('e2', MAREN, 'alive', 'dead')]);
  assert.equal(ledger.length, 2);
  assert.deepEqual(
    ledger.map(({ eventId, value, supersededBy }) => [eventId, value, supersededBy]),
    [
      ['e1', 'alive', 'e2'],
      ['e2', 'dead', null],
    ],
  );
  assert.deepEqual(
    currentEntries(ledger).map(({ value }) => value),
    ['dead'],
  );
});

test('rpg-42a.42 only claim events change the ledger and bad payloads are skipped', () => {
  const ledger = buildLedger([
    { id: 'x', type: 'FactRecorded', payload: {} },
    claim('e1', MAREN, 'teleports', 'yes'),
    claim('e2', MAREN, 'alive', ''),
    { id: 'e3', type: CLAIM_RECORDED, payload: { entityId: MAREN } },
    claim('e4', MAREN, 'item', 'held', { key: 'silver dagger' }),
  ]);
  assert.deepEqual(
    ledger.map(({ eventId }) => eventId),
    ['e4'],
  );
});

test('rpg-42a.42 slots are per entity, kind and key; singleton kinds ignore the key', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'item', 'held', { key: 'dagger' }),
    claim('e2', MAREN, 'item', 'held', { key: 'lantern' }),
    claim('e3', MAREN, 'item', 'not-held', { key: 'dagger' }),
    claim('e4', MAREN, 'name', 'Maren', { key: 'ignored' }),
    claim('e5', MAREN, 'name', 'Mara'),
  ]);
  assert.deepEqual(
    currentEntries(ledger).map(({ eventId }) => eventId),
    ['e2', 'e3', 'e5'],
  );
});

test('rpg-42a.42 a correction is a claim that is marked as corrected', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'alive', 'dead'),
    { ...claim('e2', MAREN, 'alive', 'alive'), type: CLAIM_CORRECTED },
  ]);
  assert.deepEqual(
    currentEntries(ledger).map(({ value, corrected }) => [value, corrected]),
    [['alive', true]],
  );
});

test('rpg-42a.42 lines hold every current fact of the chosen entities and nothing about others', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'alive', 'dead'),
    claim('e2', HARBOR, 'description', 'foggy'),
    claim('e3', WARDEN, 'alive', 'alive'),
  ]);
  const lines = ledgerLines({
    ledger,
    entityIds: [MAREN, HARBOR],
    directory: DIRECTORY,
    viewer: PLAYER_VIEWER,
    allowance: 1000,
  });
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.includes('Maren') && line.includes('dead')));
  assert.ok(lines.some((line) => line.includes('Harbor') && line.includes('foggy')));
  assert.ok(!lines.some((line) => line.includes('Warden')));
});

test('rpg-42a.42 under pressure history is condensed but a current fact is never dropped', () => {
  const events = [
    ...Array.from({ length: 50 }, (_, index) => claim(`old${index}`, MAREN, 'description', `old look ${index}`)),
    claim('now', MAREN, 'description', 'scarred'),
  ];
  const ledger = buildLedger(events);
  const tight = ledgerLines({ ledger, entityIds: [MAREN], directory: DIRECTORY, viewer: PLAYER_VIEWER, allowance: 1 });
  assert.ok(tight.some((line) => line.includes('scarred')));
  assert.ok(tight.every((line) => !line.includes('old look')));
  const roomy = ledgerLines({
    ledger,
    entityIds: [MAREN],
    directory: DIRECTORY,
    viewer: PLAYER_VIEWER,
    allowance: 10_000,
  });
  assert.ok(roomy.some((line) => line.includes('old look 49')));
  const small = ledgerLines({ ledger, entityIds: [MAREN], directory: DIRECTORY, viewer: PLAYER_VIEWER, allowance: 60 });
  assert.ok(small.some((line) => line.includes('scarred')));
  assert.ok(small.some((line) => line.includes('earlier claims superseded')));
  assert.ok(small.every((line) => !line.includes('old look 0')));
  assert.ok(small.some((line) => line.includes('old look 49')));
  const spent = small.filter((line) => !line.includes('scarred')).reduce((sum, line) => sum + estimateTokens(line), 0);
  assert.ok(spent <= 60);
});

test('rpg-42a.121 ledger lines run oldest first, so the current fact comes last', () => {
  const ledger = buildLedger([
    claim('a', MAREN, 'description', 'old look'),
    claim('b', MAREN, 'description', 'middle look'),
    claim('c', MAREN, 'description', 'scarred'),
  ]);
  const lines = ledgerLines({
    ledger,
    entityIds: [MAREN],
    directory: DIRECTORY,
    viewer: PLAYER_VIEWER,
    allowance: 1000,
  });
  assert.deepEqual(
    lines.map((line) => ['old look', 'middle look', 'scarred'].findIndex((text) => line.includes(text))),
    [0, 1, 2],
  );
});

test('rpg-42a.42 secrets reach the GM view only', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'secret', 'serves the cult', { key: 'loyalty', visibility: 'gm' }),
    claim('e2', MAREN, 'alive', 'alive'),
  ]);
  const input = { ledger, entityIds: [MAREN], directory: DIRECTORY, allowance: 1000 };
  assert.equal(
    ledgerLines({ ...input, viewer: PLAYER_VIEWER }).some((line) => line.includes('cult')),
    false,
  );
  assert.equal(
    ledgerLines({ ...input, viewer: GM_VIEWER }).some((line) => line.includes('cult')),
    true,
  );
});

test('rpg-42a.42 the ledger gets a bounded share of the budget', () => {
  assert.ok(ledgerAllowance(6000) > 0 && ledgerAllowance(6000) < 6000);
});

test('rpg-42a.42 story memory groups visible current facts by person, place and thread', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'alive', 'alive'),
    claim('e2', HARBOR, 'description', 'foggy'),
    claim('e3', MAREN, 'promise', 'open', { key: 'repay the debt' }),
    claim('e4', MAREN, 'secret', 'serves the cult', { visibility: 'gm' }),
    claim('e5', MAREN, 'alive', 'dead'),
  ]);
  const memory = storyMemoryOf(ledger, DIRECTORY, PLAYER_VIEWER);
  assert.deepEqual(
    memory.person.map(({ kind, value }) => [kind, value]),
    [['alive', 'dead']],
  );
  assert.deepEqual(
    memory.place.map(({ entityName, value }) => [entityName, value]),
    [['Harbor', 'foggy']],
  );
  assert.deepEqual(
    memory.thread.map(({ key, value }) => [key, value]),
    [['repay the debt', 'open']],
  );
  assert.equal(JSON.stringify(memory).includes('cult'), false);
});

test('rpg-42a.42 a GM-only name never reaches the player lines or story memory', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'alive', 'alive'),
    claim('e2', MAREN, 'name', 'Malgrith the Lich', { visibility: 'gm' }),
  ]);
  const lines = ledgerLines({
    ledger,
    entityIds: [MAREN],
    directory: DIRECTORY,
    viewer: PLAYER_VIEWER,
    allowance: 1000,
  });
  assert.deepEqual(lines, ['Maren alive: alive']);
  assert.equal(JSON.stringify(storyMemoryOf(ledger, DIRECTORY, PLAYER_VIEWER)).includes('Malgrith'), false);
  assert.ok(
    ledgerLines({ ledger, entityIds: [MAREN], directory: DIRECTORY, viewer: GM_VIEWER, allowance: 1000 })[0]?.includes(
      'Malgrith',
    ),
  );
});

test('rpg-42a.42 a public fact superseded only by a GM-only fact stays current for the player', () => {
  const ledger = buildLedger([
    claim('e1', MAREN, 'alive', 'alive'),
    claim('e2', MAREN, 'alive', 'dead', { visibility: 'gm' }),
  ]);
  const lines = ledgerLines({
    ledger,
    entityIds: [MAREN],
    directory: DIRECTORY,
    viewer: PLAYER_VIEWER,
    allowance: 1000,
  });
  assert.deepEqual(lines, ['Maren alive: alive']);
  const memory = storyMemoryOf(ledger, DIRECTORY, PLAYER_VIEWER);
  assert.deepEqual(
    memory.person.map(({ value, sourceEventId }) => [value, sourceEventId]),
    [['alive', 'e1']],
  );
  assert.deepEqual(
    visibleLedger(ledger, PLAYER_VIEWER).map(({ eventId, supersededBy }) => [eventId, supersededBy]),
    [['e1', null]],
  );
  assert.deepEqual(
    visibleLedger(ledger, GM_VIEWER).map(({ eventId, supersededBy }) => [eventId, supersededBy]),
    [
      ['e1', 'e2'],
      ['e2', null],
    ],
  );
});
