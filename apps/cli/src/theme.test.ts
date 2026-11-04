import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { colorDepthOf, frame, paint, supportsUnicode } from './theme.ts';

const ESCAPE = String.fromCharCode(27);
const TTY = { isTTY: true };
const PIPE = {};
const UTF8 = { LANG: 'en_US.UTF-8' };
const WIDTH = 20;

test('rpg-42a.11 colorDepthOf detects truecolor, 256, 16 and no color', () => {
  assert.equal(colorDepthOf({ TERM: 'xterm', COLORTERM: 'truecolor' }, TTY), 'truecolor');
  assert.equal(colorDepthOf({ TERM: 'xterm-256color' }, TTY), '256');
  assert.equal(colorDepthOf({ TERM: 'xterm' }, TTY), '16');
  assert.equal(colorDepthOf({ TERM: 'dumb' }, TTY), 'none');
  assert.equal(colorDepthOf({ TERM: 'xterm-256color', NO_COLOR: '1' }, TTY), 'none');
  assert.equal(colorDepthOf({ TERM: 'xterm-256color' }, PIPE), 'none');
  assert.equal(colorDepthOf({ TERM: 'xterm', FORCE_COLOR: '2' }, PIPE), '256');
  assert.equal(colorDepthOf({ TERM: 'xterm', FORCE_COLOR: '0' }, TTY), 'none');
});

test('rpg-42a.11 supportsUnicode needs a UTF-8 locale and a capable terminal', () => {
  assert.equal(supportsUnicode({ ...UTF8, TERM: 'xterm' }), true);
  assert.equal(supportsUnicode({ LC_ALL: 'C.utf8', LANG: 'C' }), true);
  assert.equal(supportsUnicode({ LANG: 'C' }), false);
  assert.equal(supportsUnicode({}), false);
  assert.equal(supportsUnicode({ ...UTF8, TERM: 'dumb' }), false);
});

test('rpg-42a.11 paint emits role codes for each color depth and nothing without color', () => {
  assert.equal(paint('none', 'accent', 'x'), 'x');
  assert.equal(paint('16', 'accent', 'x'), `${ESCAPE}[36mx${ESCAPE}[39m`);
  assert.equal(paint('256', 'accent', 'x'), `${ESCAPE}[38;5;67mx${ESCAPE}[39m`);
  assert.match(paint('truecolor', 'accent', 'x'), new RegExp(`^${ESCAPE}\\[38;2;\\d+;\\d+;\\d+mx${ESCAPE}\\[39m$`));
  assert.equal(paint('16', 'title', 'x'), `${ESCAPE}[1mx${ESCAPE}[22m`);
  assert.equal(paint('256', 'muted', 'x'), `${ESCAPE}[2mx${ESCAPE}[22m`);
});

test('rpg-42a.11 frame draws a titled pane with box drawing or ASCII and marks focus', () => {
  const unicode = { colors: 'none', unicode: true } as const;
  const ascii = { colors: 'none', unicode: false } as const;
  assert.deepEqual(frame(unicode, 'Sheet', ['Grit: 3'], WIDTH, false), [
    '╭─ Sheet ──────────╮',
    '│ Grit: 3          │',
    '╰──────────────────╯',
  ]);
  assert.deepEqual(frame(unicode, 'Sheet', ['Grit: 3'], WIDTH, true), [
    '┏━ Sheet ━━━━━━━━━━┓',
    '┃ Grit: 3          ┃',
    '┗━━━━━━━━━━━━━━━━━━┛',
  ]);
  assert.deepEqual(frame(ascii, 'Sheet', ['Grit: 3'], WIDTH, true), [
    '+= Sheet ==========+',
    '| Grit: 3          |',
    '+==================+',
  ]);
  assert.deepEqual(frame(ascii, 'Sheet', [], WIDTH, false)[0], '+- Sheet ----------+');
  const colored = frame({ colors: '256', unicode: true }, 'A very long pane title', ['x'], WIDTH, true);
  assert.ok(colored.every((row) => row.includes(ESCAPE)));
  assert.ok(colored.every((row) => stripVTControlCharacters(row).length === WIDTH));
});
