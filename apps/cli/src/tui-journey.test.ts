import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Key } from 'node:readline';
import { type TestContext, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_ADVENTURE_NAME } from '../../../packages/client-protocol/src/guided-start.ts';
import { createEngineGateway, FAKE_GM_REPLY } from './engine-gateway.ts';

const SIZES = [
  [80, 24],
  [120, 40],
] as const;
const FIXED_RANDOM = 0.5;
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const ACTION = 'I try to climb the wall';
const CHARACTER = 'A scout named Wren with might 6, agility 5, wits 7 and presence 4.';
const EDIT = '/edit might 8';
const GUIDE = '2';
const CONTINUE = '';
const FIRST = '1';
const D20_LITE = '1';
const DICE_ANIMATION = '1';
const START = 'y';
const NEW = 'n';
const QUIT = 'q';
const MECHANICS_PANE = '4';
const SHEET_PANE = '2';
const TYPE_KEY = 'i';
const FIRST_RUN = [NEW, GUIDE, CONTINUE, FIRST, D20_LITE, CHARACTER, DICE_ANIMATION, CONTINUE, START, FIRST];
const REOPEN = [FIRST];

const key = (sequence: string, name = sequence): Key => ({ sequence, name });
const RETURN = key('\r', 'return');

const each = async function* (items: readonly string[]) {
  yield* items;
};

const visible = (text: string) => stripVTControlCharacters(text).split('\n');

const play = async (
  dataDir: string,
  columns: number,
  rows: number,
  lines: readonly string[],
  keys: readonly Key[][],
) => {
  let output = '';
  const screens: string[][] = [];
  const latest = () => visible(output.slice(output.lastIndexOf(CLEAR_SCREEN) + CLEAR_SCREEN.length));
  const pressed = async function* () {
    for (const group of keys) {
      yield* group;
      screens.push(latest());
    }
    yield key(QUIT);
  };
  await createEngineGateway(dataDir).home({
    capabilities: { width: columns, height: rows, colors: 'none', unicode: true, interactive: true },
    keys: pressed(),
    lines: each(lines),
    write: (text) => {
      output += text;
    },
  });
  const transcript = output.slice(0, output.indexOf(CLEAR_SCREEN));
  return { transcript: visible(transcript), screens };
};

const journey = async (t: TestContext, columns: number, rows: number) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-tui-journey-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const typed = [key(TYPE_KEY), ...[...ACTION].map((char) => key(char)), RETURN];
  const edit = [key(TYPE_KEY), ...[...EDIT].map((char) => key(char)), RETURN];
  const first = await play(dataDir, columns, rows, FIRST_RUN, [typed, [key(MECHANICS_PANE)], [key(SHEET_PANE)], edit]);
  const reopen = await play(dataDir, columns, rows, REOPEN, [[], [key(SHEET_PANE)]]);
  return { first, reopen };
};

test('rpg-42a.17 TUI journey: first run, guided start, roll, sheet edit, quit, reopen and continue', async (t) => {
  t.mock.method(Math, 'random', () => FIXED_RANDOM);
  for (const [columns, rows] of SIZES) {
    const { first, reopen } = await journey(t, columns, rows);
    const [played, mechanics, sheet, editedLive] = first.screens;
    const [continued, edited] = reopen.screens;
    for (const screen of [...first.screens, ...reopen.screens]) {
      assert.equal(screen.length, rows);
      assert.ok(screen.every((row) => row.length <= columns));
    }
    assert.match(first.transcript[0] ?? '', /^No adventures yet/);
    assert.ok(first.transcript.some((row) => row.startsWith('Created campaign')));
    assert.match(played?.join('\n') ?? '', new RegExp(ACTION));
    assert.match(played?.join('\n') ?? '', new RegExp(FAKE_GM_REPLY));
    assert.match(mechanics?.join('\n') ?? '', /d20 -> \d+/);
    assert.match(sheet?.join('\n') ?? '', /Wren/);
    assert.match(editedLive?.join('\n') ?? '', /Might: 8/);
    assert.match(reopen.transcript.join('\n'), new RegExp(`1\\. ${DEFAULT_ADVENTURE_NAME}`));
    assert.match(continued?.join('\n') ?? '', new RegExp(ACTION));
    assert.match(edited?.join('\n') ?? '', /8/);
    assert.doesNotMatch([...(continued ?? []), ...(edited ?? [])].join('\n'), /d20 -> /);
    t.assert.snapshot({ first, reopen });
  }
});
