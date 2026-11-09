import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignSummary } from '../../../packages/client-protocol/src/protocol.ts';
import { PLAIN_TERMINAL, type Terminal } from './tui.ts';
import { type HomePorts, runHome } from './tui-home.ts';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const MANY = 6;

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
  lastPlayedAt: new Date(NOW - HOUR_MS).toISOString(),
  sceneTitle: 'Docks',
  characters: [{ id: 'ash', name: 'Ash' }],
  genre: { id: 'fantasy', version: '1.0.0', provenance: 'derived' },
  lastNarration: 'The tide turns.',
});

const homeWith = (active: CampaignSummary[], archived: CampaignSummary[] = []) => {
  const calls: string[] = [];
  const move = (from: CampaignSummary[], to: CampaignSummary[], name: string) => {
    const index = from.findIndex((campaign) => campaign.name === name);
    to.push(...from.splice(index, 1));
  };
  const ports: HomePorts = {
    list: () => active,
    archived: () => archived,
    archive: (name) => {
      calls.push(`archive ${name}`);
      move(active, archived, name);
    },
    rename: (name, newName) => {
      calls.push(`rename ${name} ${newName}`);
      const index = active.findIndex((candidate) => candidate.name === name);
      if (index >= 0) active[index] = summary(newName);
    },
    unarchive: (name) => {
      calls.push(`unarchive ${name}`);
      move(archived, active, name);
    },
    remove: (name, confirm, fromArchive) => {
      calls.push(`remove ${name} ${confirm}${fromArchive ? ' archived' : ''}`);
      const from = fromArchive ? archived : active;
      from.splice(
        from.findIndex((campaign) => campaign.name === name),
        1,
      );
    },
    play: async (name, terminal) => {
      calls.push(`play ${name}`);
      for await (const line of terminal.lines) calls.push(`turn ${line}`);
    },
    start: async function* (lines) {
      calls.push('start');
      for await (const line of lines) {
        yield `started ${line}`;
        return;
      }
    },
  };
  return { calls, ports };
};

const runWith = async (ports: HomePorts, input: readonly string[]) => {
  let output = '';
  const terminal: Terminal = {
    capabilities: PLAIN_TERMINAL,
    lines: (async function* () {
      yield* input;
    })(),
    write: (text) => {
      output += text;
    },
  };
  await runHome(ports, terminal, NOW);
  return output;
};

test('rpg-42a.13 the TUI home offers the guided start in one line when there are no adventures', async () => {
  const { calls, ports } = homeWith([]);
  const output = await runWith(ports, ['n', 'Ember', 'q']);
  assert.match(output, /^No adventures yet\. Type n to start one, or q to quit\.$/m);
  assert.match(output, /started Ember/);
  assert.deepEqual(calls, ['start']);
});

test('rpg-42a.13 the TUI home lists where each adventure stopped and continues the chosen one', async () => {
  const { calls, ports } = homeWith([summary('Aldo'), EMBER]);
  const output = await runWith(ports, ['1', 'look around']);
  assert.match(output, /^ {2}1\. Ember - Ash - fantasy - Docks - 1 hour ago$/m);
  assert.match(output, /^ {5}The tide turns\.$/m);
  assert.match(output, /^ {2}2\. Aldo$/m);
  assert.doesNotMatch(output, /search/);
  assert.deepEqual(calls, ['play Ember', 'turn look around']);
});

test('rpg-42a.13 the TUI home shows the problem and a backup hint for unhealthy saves', async () => {
  const { calls, ports } = homeWith([summary('Junk', { id: null, health: 'unreadable' })]);
  const output = await runWith(ports, ['1', 'q']);
  assert.match(output, /1\. Junk - this save cannot be read\. Restore it from a backup with rpg restore <file>\./);
  assert.match(output, /Junk cannot be opened\./);
  assert.deepEqual(calls, []);
});

test('rpg-42a.13 the TUI home archives after confirmation and undoes it', async () => {
  const { calls, ports } = homeWith([EMBER]);
  const output = await runWith(ports, ['a1', 'n', 'a1', 'y', 'u', 'q']);
  assert.match(output, /Archive Ember\? Type y to archive it\./);
  assert.match(output, /Kept Ember\./);
  assert.match(output, /Archived Ember\. Type u to undo\./);
  assert.match(output, /Restored Ember\./);
  assert.deepEqual(calls, ['archive Ember', 'unarchive Ember']);
});

test('rpg-42a.13 the TUI home deletes only after the player types the name', async () => {
  const { calls, ports } = homeWith([EMBER]);
  const output = await runWith(ports, ['d1', 'yes', 'd1', 'Ember', 'q']);
  assert.match(output, /Deleting Ember removes it for good\. Type Ember to delete it\./);
  assert.match(output, /Deleted Ember\./);
  assert.deepEqual(calls, ['remove Ember Ember']);
});

test('rpg-42a.13 the TUI home lists archived adventures apart and restores them', async () => {
  const { calls, ports } = homeWith([EMBER], [summary('Frost')]);
  const output = await runWith(ports, ['x', '1', 'q']);
  assert.match(output, /^Archived adventures$/m);
  assert.match(output, /^ {2}1\. Frost$/m);
  assert.deepEqual(calls, ['unarchive Frost']);
});

test('rpg-asjw.30 the TUI home points to the archived view when only archived adventures remain', async () => {
  const { ports } = homeWith([], [summary('Frost')]);
  const output = await runWith(ports, ['q']);
  assert.match(output, /No active adventures\. Type x for archived ones, n to start one, or q to quit\./);
});

test('rpg-asjw.30 the archived view says so once the last archived adventure is restored', async () => {
  const { ports } = homeWith([EMBER], [summary('Frost')]);
  const output = await runWith(ports, ['x', '1', 'q']);
  assert.match(output, /^Archived adventures\nNo archived adventures\./m);
});

test('rpg-42a.13 the TUI home deletes the archived copy, not the active adventure with the same name', async () => {
  const { calls, ports } = homeWith([EMBER], [summary('Ember')]);
  await runWith(ports, ['x', 'd1', 'Ember', 'q']);
  assert.deepEqual(calls, ['remove Ember Ember archived']);
  assert.equal(ports.list().length, 1);
});

test('rpg-42a.13 the TUI home searches only when there are many adventures', async () => {
  const many = Array.from({ length: MANY - 1 }, (_, index) => summary(`Tale ${index}`));
  const { calls, ports } = homeWith([...many, EMBER]);
  const output = await runWith(ports, ['/ash', '1']);
  assert.match(output, /\/text to search/);
  assert.match(output, /^Matching "ash"$/m);
  assert.deepEqual(calls, ['play Ember']);
});

test('rpg-42a.66 the TUI home renames an adventure from the next line', async () => {
  const { calls, ports } = homeWith([summary('Ember')]);
  const output = await runWith(ports, ['r1', 'Cinders', 'r1', '', 'q']);
  assert.match(output, /New name for Ember\?/);
  assert.match(output, /Renamed Ember to Cinders\./);
  assert.match(output, /1\. Cinders/);
  assert.match(output, /Kept Cinders\./);
  assert.deepEqual(calls, ['rename Ember Cinders']);
});
