import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Key } from 'node:readline';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import {
  type CampaignSnapshot,
  type ClientEvent,
  type ClientSession,
  PROTOCOL_VERSION,
  toClientEvent,
} from '../../../packages/client-protocol/src/protocol.ts';
import { matchSlash } from '../../../packages/client-protocol/src/slash-commands.ts';
import { toVisualizationEvent, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import { MAIN_BRANCH } from '../../../packages/domain/src/campaign.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createClientSessions, scopedEventsOf } from './client-session.ts';
import { ProviderError } from './gm-api.ts';
import { hermeticGmEnv } from './gm-test-env.ts';
import { EXIT_OK } from './main.ts';
import {
  type Capabilities,
  capabilitiesOf,
  INITIAL_STATE,
  motionOf,
  nextState,
  nextStateIn,
  panesFor,
  renderLinear,
  renderScreen,
  rollFrames,
  runTui,
  type Terminal,
  type TuiData,
  type TuiState,
} from './tui.ts';
import { createTuiAudio } from './tui-audio.ts';

const ESCAPE = String.fromCharCode(27);
const ASCII_ONLY = /^[\x20-\x7e]*$/;
const WIDE = 80;
const NARROW = 20;
const HEIGHT = 24;
const LARGE_WIDTH = 200;
const LARGE_HEIGHT = 60;
const COLOR: Capabilities = { width: WIDE, height: HEIGHT, colors: 'truecolor', unicode: true, interactive: true };
const PLAIN: Capabilities = { width: NARROW, height: HEIGHT, colors: 'none', unicode: false, interactive: false };
const TRUECOLOR_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' };
const terminalOf = (columns: number, rows: number) => ({ isTTY: true, columns, rows });
const PLAIN_WIDE: Capabilities = { ...PLAIN, width: WIDE };
const CAMPAIGN = 'Ember';
const ACTION = 'I wave.';
const BIN = join(import.meta.dirname, 'bin.ts');
const TUI_AUDIO = join(import.meta.dirname, 'tui-audio.ts');
const AUDIO_STACK_LOADED = 'audio stack loaded';
const BLOCK_AUDIO_STACK = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (resolved.url.includes('/packages/voice/')) throw new Error('${AUDIO_STACK_LOADED}');
    return resolved;
  },
});
`)}`;

const snapshot: CampaignSnapshot = {
  version: PROTOCOL_VERSION,
  campaignId: 'c1',
  revision: 2,
  campaign: { id: 'c1', name: CAMPAIGN },
  characters: [{ id: 'h1', campaignId: 'c1', name: 'Wanderer' }],
  currentScene: { id: 's1', campaignId: 'c1', title: 'The Crossroads Inn' },
  turns: [
    {
      id: 't1',
      campaignId: 'c1',
      sceneId: 's1',
      actionId: 'a1',
      actorId: 'h1',
      input: 'I greet the stranger by the warm fire.',
      narration: 'The stranger nods slowly.',
    },
  ],
};

const mechanic = toVisualizationEvent(
  {
    resultId: 'r1',
    mechanic: 'attack',
    visibility: 'public',
    reveals: [
      { kind: 'die', sides: 20, face: 14 },
      { kind: 'token', label: 'Ace' },
    ],
    modifier: 2,
    total: 16,
    outcome: 'hit',
  },
  'player',
  { enabled: true },
);

const data: TuiData = {
  snapshot,
  sheet: [{ kind: 'field', id: 'grit', label: 'Grit', value: 3 }],
  events: [
    toClientEvent({
      id: 'e1',
      campaignId: 'c1',
      branchId: MAIN_BRANCH,
      revision: 2,
      turnId: 't1',
      actorId: 'h1',
      causationId: null,
      type: 'StrangerGreeted',
      payload: {},
    }),
  ],
  mechanics: mechanic === undefined ? [] : [mechanic],
};

const key = (sequence: string, name = sequence): Key => ({ sequence, name });
const TAB = key('\t', 'tab');
const RETURN = key('\r', 'return');
const press = (keys: readonly Key[], state: TuiState = INITIAL_STATE) => keys.reduce(nextState, state);
const typed = (text: string) => [...text].map((char) => key(char));
const screen = (state: TuiState, capabilities = COLOR) => renderScreen(state, data, capabilities).join('\n');

const each = async function* <T>(items: readonly T[]) {
  yield* items;
};

const servedSession = (session: ClientSession): ClientSession => ({
  ...session,
  requestView: ({ campaignId, viewId }) => ({ ok: true, value: { campaignId, viewId, components: data.sheet } }),
  subscribeEvents: (command, listener) => {
    const unsubscribe = session.subscribeEvents(command, listener);
    if (mechanic !== undefined) listener(mechanic);
    return unsubscribe;
  },
});

const engineSession = () => {
  const { database } = openDatabase(':memory:');
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  const campaign = engine.createCampaign(CAMPAIGN);
  openScene(store, { campaignId: campaign.id, actorName: 'Wanderer', sceneTitle: 'The Inn', narration: 'Rain.' });
  const session = createClientSessions(engine, campaign.id, scopedEventsOf(database))(PLAYER_VIEWER);
  return { engine, campaignId: campaign.id, session };
};

test('UI06: provide accessible terminal conversation, sheet, log and mechanical indicators', async () => {
  assert.match(screen(INITIAL_STATE), /\[1 Conversation\]/);
  assert.match(screen(INITIAL_STATE), /Wanderer: I greet the stranger/);
  assert.match(screen(INITIAL_STATE), /The stranger nods slowly\./);
  assert.match(screen(press([TAB])), /\[2 Sheet\][\s\S]*Grit: 3/);
  assert.match(screen(press([key('3')])), /\[3 Event log\][\s\S]*#2 StrangerGreeted/);
  assert.match(screen(press([key('4')])), /attack: d20 -> 14, Ace; modifier \+2; total 16; outcome hit/);
  assert.equal(press([TAB, { ...TAB, shift: true }]).pane, INITIAL_STATE.pane);
  assert.match(screen(press([key('?')])), /q - Quit/);
  assert.equal(press([key('q')]).quit, true);
  assert.equal(press([key('i'), ...typed('I q?'), key('\x7f', 'backspace'), RETURN]).submitted, 'I q');
  assert.equal(press([key('i'), ...typed('I wave'), key('\x1b', 'escape')]).draft, undefined);
  assert.match(screen(press([key('i'), ...typed(ACTION)])), /> I wave\./);
  assert.match(renderLinear(data, COLOR).join('\n'), /Conversation:[\s\S]*Sheet:[\s\S]*Event log:[\s\S]*Mechanics:/);

  const { engine, campaignId, session } = engineSession();
  const output: string[] = [];
  await runTui(session, campaignId, {
    capabilities: COLOR,
    keys: each([key('i'), ...typed(ACTION), RETURN, key('1'), key('q')]),
    lines: each([]),
    write: (text) => output.push(text),
  });
  assert.equal(engine.getState(campaignId).turns.at(-1)?.input, ACTION);
  assert.match(output.at(-1) ?? '', /Wanderer: I wave\./);
  for (const frame of output) assert.ok((frame.match(/\n/g) ?? []).length <= HEIGHT - 1, 'a frame scrolls the screen');
});

test('UI06: text-only and limited terminal environments still work without graphics', async () => {
  const tty = terminalOf(WIDE, HEIGHT);
  assert.deepEqual(capabilitiesOf({ TERM: 'dumb' }, tty, tty), {
    width: WIDE,
    height: HEIGHT,
    colors: 'none',
    unicode: false,
    interactive: false,
  });
  assert.deepEqual(capabilitiesOf({ TERM: 'xterm', NO_COLOR: '1' }, tty, tty), {
    width: WIDE,
    height: HEIGHT,
    colors: 'none',
    unicode: false,
    interactive: true,
  });
  assert.equal(capabilitiesOf({ TERM: 'xterm' }, {}, tty).interactive, false);
  assert.equal(capabilitiesOf({ TERM: 'xterm' }, tty, {}).colors, 'none');
  assert.equal(capabilitiesOf({ TERM: 'xterm' }, tty, tty).colors, '16');
  assert.ok(screen(INITIAL_STATE).includes(ESCAPE));

  const states = [INITIAL_STATE, press([TAB]), press([key('3')]), press([key('4')]), press([key('?')])];
  const rows = [...states.flatMap((state) => renderScreen(state, data, PLAIN)), ...renderLinear(data, PLAIN)];
  for (const row of rows) {
    assert.ok(!row.includes(ESCAPE), row);
    assert.match(row, ASCII_ONLY);
    assert.ok(row.length <= NARROW, row);
  }

  const { engine, campaignId, session } = engineSession();
  const output: string[] = [];
  await runTui(session, campaignId, {
    capabilities: PLAIN,
    lines: each(['', ACTION, '2', '?', 'q', 'ignored after quit']),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.equal(engine.getState(campaignId).turns.length, 2);
  assert.ok(!printed.includes(ESCAPE));
  assert.match(printed, /Conversation:[\s\S]*Wanderer: I wave\.[\s\S]*Sheet:[\s\S]*q - Quit/);

  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-tui-'));
  try {
    const env = { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir, TERM: 'dumb', NO_COLOR: '1' };
    const rpg = (args: readonly string[], input = '') =>
      spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', env });
    assert.equal(rpg(['new', CAMPAIGN]).status, EXIT_OK);
    const run = rpg(['tui', CAMPAIGN], `${ACTION}\nq\n`);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.ok(!run.stdout.includes(ESCAPE));
    assert.match(run.stdout, /Conversation:[\s\S]*Mechanics:[\s\S]*I wave\./);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const visibleRows = (rows: readonly string[]) => rows.map(stripVTControlCharacters);

test('rpg-42a.11 TUI draws bordered panes at 80x24 and reflows to two panes at 200x60', (t) => {
  for (const [columns, rows] of [
    [WIDE, HEIGHT],
    [LARGE_WIDTH, LARGE_HEIGHT],
  ] as const) {
    const size = terminalOf(columns, rows);
    const capabilities = capabilitiesOf(TRUECOLOR_ENV, size, size);
    assert.equal(capabilities.colors, 'truecolor');
    assert.equal(capabilities.unicode, true);
    for (const state of [INITIAL_STATE, press([key('2')]), press([key('?')])]) {
      const screen = renderScreen(state, data, capabilities);
      const visible = visibleRows(screen);
      assert.equal(screen.length, rows);
      assert.ok(screen.some((row) => row.includes(ESCAPE)));
      assert.ok(visible.every((row) => row.length <= columns));
      assert.ok(visible.slice(1, -1).every((row) => row.length === columns));
      t.assert.snapshot(visible);
    }
  }
  const wide = terminalOf(LARGE_WIDTH, LARGE_HEIGHT);
  const split = visibleRows(renderScreen(INITIAL_STATE, data, capabilitiesOf(TRUECOLOR_ENV, wide, wide)));
  assert.match(split[1] ?? '', /┏━ Conversation ━+┓╭─ Sheet ─+╮/);
  assert.ok(split.some((row) => /Wanderer: I greet.*Grit: 3/.test(row)));
  const narrow = visibleRows(
    renderScreen(
      press([key('2')]),
      data,
      capabilitiesOf(TRUECOLOR_ENV, terminalOf(WIDE, HEIGHT), terminalOf(WIDE, HEIGHT)),
    ),
  );
  assert.match(narrow[1] ?? '', /^┏━ Sheet ━+┓$/);
  assert.doesNotMatch(narrow.join('\n'), /Wanderer: I greet/);
});

test('rpg-42a.11 TUI honors NO_COLOR, ASCII terminals and piped output', (t) => {
  const size = terminalOf(WIDE, HEIGHT);
  const noColor = capabilitiesOf({ ...TRUECOLOR_ENV, NO_COLOR: '1' }, size, size);
  assert.equal(noColor.colors, 'none');
  const plainScreen = renderScreen(INITIAL_STATE, data, noColor);
  assert.ok(plainScreen.every((row) => !row.includes(ESCAPE) && row.length <= WIDE));
  assert.equal(plainScreen.length, HEIGHT);
  t.assert.snapshot(plainScreen);

  const ascii = capabilitiesOf({ ...TRUECOLOR_ENV, LANG: 'C' }, size, size);
  assert.equal(ascii.unicode, false);
  const asciiScreen = visibleRows(renderScreen(INITIAL_STATE, data, ascii));
  assert.ok(asciiScreen.every((row) => ASCII_ONLY.test(row)));
  assert.match(asciiScreen[1] ?? '', /^\+= Conversation =+\+$/);

  const piped = capabilitiesOf(TRUECOLOR_ENV, {}, {});
  assert.deepEqual(piped, { width: WIDE, height: HEIGHT, colors: 'none', unicode: true, interactive: false });
  const linear = renderLinear(data, piped);
  assert.ok(linear.every((row) => !row.includes(ESCAPE) && row.length <= WIDE));
  t.assert.snapshot(linear);
  assert.equal(capabilitiesOf({ ...TRUECOLOR_ENV, FORCE_COLOR: '2' }, {}, {}).colors, '256');
  assert.ok(renderLinear(data, { ...piped, colors: '256' }).some((row) => row.includes(ESCAPE)));
});

test('UI06: control sequences in campaign text never reach the terminal', async () => {
  const TITLE_PAYLOAD = '\x1b]0;pwn\x07';
  const CLEAR_PAYLOAD = '\x1b[2J';
  const BELL = String.fromCharCode(7);
  const BIDI_OVERRIDE = '\u202e';
  const hostile: TuiData = {
    ...data,
    snapshot: {
      ...snapshot,
      characters: [{ id: 'h1', campaignId: 'c1', name: `Wan${CLEAR_PAYLOAD}derer` }],
      turns: snapshot.turns.map((turn) => ({
        ...turn,
        narration: `Nods${TITLE_PAYLOAD}.`,
        input: `Hi${CLEAR_PAYLOAD}`,
      })),
    },
    sheet: [{ kind: 'field', id: 'grit', label: `Grit${TITLE_PAYLOAD}${BIDI_OVERRIDE}`, value: 3 }],
  };
  const states = [INITIAL_STATE, press([TAB]), press([key('3')])];
  const plain = [...states.flatMap((state) => renderScreen(state, hostile, PLAIN)), ...renderLinear(hostile, PLAIN)];
  for (const row of plain)
    assert.ok(!row.includes(ESCAPE) && !row.includes(BELL) && !row.includes(BIDI_OVERRIDE), JSON.stringify(row));
  const colored = states.flatMap((state) => renderScreen(state, hostile, COLOR)).join('\n');
  assert.ok(!colored.includes(TITLE_PAYLOAD) && !colored.includes(CLEAR_PAYLOAD) && !colored.includes(BELL));
  assert.match(colored, /Wan\[2Jderer: Hi\[2J[\s\S]*Nods\]0;pwn\./);
  assert.equal(press([key('i'), ...typed('a😀'), key('\x7f', 'backspace')]).draft, 'a');

  const { campaignId, session } = engineSession();
  const output: string[] = [];
  await runTui(session, campaignId, {
    capabilities: PLAIN,
    lines: each([`I wave${TITLE_PAYLOAD}${CLEAR_PAYLOAD}`]),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.ok(!printed.includes(ESCAPE) && !printed.includes(BELL), JSON.stringify(printed));
});

test('rpg-42a.93: Tab completes slash command names and lists the matches', () => {
  assert.equal(press([key('i'), ...typed('/ro'), TAB]).draft, '/roll ');
  assert.equal(press([key('i'), ...typed('/rol'), TAB, ...typed('now')]).draft, '/roll now');
  const listed = press([key('i'), ...typed('/'), TAB]);
  assert.equal(listed.draft, '/');
  assert.match(listed.notice ?? '', /\/gm \/roll \/retry \/edit \/language \/voice \/memory \/help/);
  assert.equal(press([key('i'), ...typed('/l'), TAB]).draft, '/language ');
  assert.equal(press([key('i'), ...typed('hello'), TAB]).draft, 'hello');
  assert.equal(press([key('i'), ...typed('/zzz'), TAB]).notice, undefined);
});

const UNKNOWN_COMMAND = /Unknown\s+command|Comando\s+\S+\s+desconoc|Comando\s+\S+\s+desconhec/;

const LISTED_LOCALES = ['en', 'es', 'pt-BR'];

const runListedCommands = async (withAudio: boolean) => {
  for (const locale of LISTED_LOCALES) {
    const names = matchSlash(locale, 'tui', '/').map(({ name }) => name);
    assert.ok(names.length > 0);
    const { engine, campaignId, session } = engineSession();
    const turns = engine.getState(campaignId).turns.length;
    const output: string[] = [];
    const audio: Terminal['audio'] = (_session, _campaignId, given) =>
      createTuiAudio(
        {
          campaignId,
          turn: 0,
          pendingInput: [],
          preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
        },
        ['en-US'],
        () => undefined,
        undefined,
        given,
      );
    await runTui(
      session,
      campaignId,
      {
        capabilities: PLAIN_WIDE,
        locale,
        ...(withAudio ? { audio } : {}),
        lines: each([...names, 'q']),
        write: (text) => output.push(text),
      },
      undefined,
      undefined,
      withAudio ? { pause() {}, resume() {}, skip() {}, stop() {}, diagnostics: () => undefined } : undefined,
    );
    assert.doesNotMatch(output.join(''), UNKNOWN_COMMAND, locale);
    assert.equal(engine.getState(campaignId).turns.length, turns, locale);
  }
};

test('rpg-42a.93: every command the interactive TUI lists runs, in every locale', () => runListedCommands(true));

test('rpg-42a.93: without --voice every listed command runs and /voice says voice is off', async () => {
  await runListedCommands(false);
  const { campaignId, session } = engineSession();
  const output: string[] = [];
  await runTui(session, campaignId, {
    capabilities: PLAIN_WIDE,
    locale: 'pt-BR',
    lines: each(['/voz', 'q']),
    write: (text) => output.push(text),
  });
  assert.match(output.join(''), /--voice/);
});

test('rpg-42a.93: an unknown slash command is not sent to the GM as story text', async () => {
  const { engine, campaignId, session } = engineSession();
  const turns = engine.getState(campaignId).turns.length;
  const output: string[] = [];
  await runTui(session, campaignId, {
    capabilities: PLAIN,
    lines: each(['/x marks the spot', '/zzz', 'q']),
    write: (text) => output.push(text),
  });
  assert.equal(engine.getState(campaignId).turns.length, turns);
  assert.match(output.join(''), /Unknown command \/x\.\s+It was not sent to\s+the GM/);
  assert.match(output.join(''), /Unknown command\s+\/zzz\./);
});

test('UI06: the sheet and mechanics panes show what the session serves', async () => {
  const { campaignId, session } = engineSession();
  const output: string[] = [];
  await runTui(servedSession(session), campaignId, {
    capabilities: PLAIN,
    lines: each(['2', '4', 'q']),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.match(printed, /Sheet:[\s\S]*Grit: 3/);
  assert.match(printed, /Mechanics:[\s\S]*attack: d20 -> 14/);
  assert.doesNotMatch(printed, /No sheet yet\.|No mechanics yet\./);
});

test('A18: unrecognized voice settings input reaches the GM as a player action', async () => {
  const GAMEPLAY = 'Turn to the bard and ask for a song.';
  const { engine, campaignId, session } = engineSession();
  const audio = () =>
    createTuiAudio(
      {
        campaignId,
        turn: 0,
        pendingInput: [],
        preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
      },
      ['en-US'],
      () => undefined,
    );
  const output: string[] = [];
  await runTui(session, campaignId, {
    capabilities: PLAIN_WIDE,
    audio,
    lines: each([GAMEPLAY, 'set speed to 1.5', '?', 'q']),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  const turns = engine.getState(campaignId).turns;
  assert.equal(turns.length, 2);
  assert.equal(turns.at(-1)?.input, GAMEPLAY);
  assert.match(printed, /Voice: mic off, output off, en-US, 1x/);
  assert.match(printed, /Voice settings changed: speed 1\.5/);
  assert.match(printed, /set mic to push-to-talk/);
});

test('A18: headless text-only play does not depend on audio stack', () => {
  const blocked = spawnSync(process.execPath, ['--import', BLOCK_AUDIO_STACK, TUI_AUDIO], { encoding: 'utf8' });
  assert.notEqual(blocked.status, EXIT_OK);
  assert.match(blocked.stderr, new RegExp(AUDIO_STACK_LOADED));

  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-tui-'));
  try {
    const env = { ...hermeticGmEnv(), RPG_DATA_DIR: dataDir, TERM: 'dumb', NO_COLOR: '1' };
    const rpg = (args: readonly string[], input = '') =>
      spawnSync(process.execPath, ['--import', BLOCK_AUDIO_STACK, BIN, ...args], { input, encoding: 'utf8', env });
    assert.equal(rpg(['new', CAMPAIGN]).status, EXIT_OK);
    const run = rpg(['tui', CAMPAIGN], `${ACTION}\nq\n`);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.match(run.stdout, /Wanderer: I wave\./);
    assert.doesNotMatch(run.stdout, /Voice:/);
    const blockedVoice = rpg(['tui', CAMPAIGN, '--voice'], 'q\n');
    assert.match(blockedVoice.stderr, new RegExp(AUDIO_STACK_LOADED));
    const voiced = spawnSync(process.execPath, [BIN, 'tui', CAMPAIGN, '--voice'], {
      input: `set speed to 1.5. ${ACTION}\nq\n`,
      encoding: 'utf8',
      env,
    });
    assert.equal(voiced.status, EXIT_OK, voiced.stderr);
    assert.match(voiced.stdout, /Voice: mic off, output off/);
    assert.match(voiced.stdout, /Voice settings changed: speed 1\.5/);
    assert.match(voiced.stdout, /Wanderer: I wave\./);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const ACCENT = `${ESCAPE}[38;2;111;134;198m`;
const ROLL_STEPS = 6;
const PROPERTY_ROLLS = 300;

test('UI15: TUI animation runs only on an interactive 256 or truecolor terminal without NO_COLOR', () => {
  const tty = terminalOf(WIDE, HEIGHT);
  const motion = (env: NodeJS.ProcessEnv, input: object, output: object) =>
    motionOf(env, capabilitiesOf(env, input, output));
  assert.equal(motion(TRUECOLOR_ENV, tty, tty), true);
  assert.equal(motion({ ...TRUECOLOR_ENV, COLORTERM: undefined, TERM: 'xterm-256color' }, tty, tty), true);
  assert.equal(motion({ ...TRUECOLOR_ENV, NO_COLOR: '1' }, tty, tty), false);
  assert.equal(motion({ ...TRUECOLOR_ENV, NO_COLOR: '1', FORCE_COLOR: '3' }, tty, tty), false);
  assert.equal(motion(TRUECOLOR_ENV, {}, {}), false);
  assert.equal(motion({ ...TRUECOLOR_ENV, FORCE_COLOR: '3' }, {}, {}), false);
  assert.equal(motion({ TERM: 'xterm' }, tty, tty), false);
});

test('UI15: TUI roll frames always land on the engine result', () => {
  assert.equal(
    rollFrames(data.mechanics[0] as VisualizationEvent, ROLL_STEPS).at(-1),
    'attack: d20 -> 14, Ace; modifier +2; total 16; outcome hit',
  );
  for (let roll = 0; roll < PROPERTY_ROLLS; roll += 1) {
    const sides = (roll % 19) + 2;
    const face = (roll % sides) + 1;
    const event = {
      ...(data.mechanics[0] as VisualizationEvent),
      frames: [{ step: 0, reveal: { kind: 'die', sides, face } as const }],
    };
    const frames = rollFrames(event, ROLL_STEPS);
    assert.equal(frames.length, ROLL_STEPS);
    assert.match(frames.at(-1) ?? '', new RegExp(`^attack: d${sides} -> ${face};`));
  }
});

test('rpg-42a.17 a rules outcome id reads as a plain word in the TUI roll line', () => {
  const event = data.mechanics[0] as VisualizationEvent;
  const checked = { ...event, final: { ...event.final, outcome: 'check.success' } };
  assert.match(rollFrames(checked, ROLL_STEPS).at(-1) ?? '', /; outcome success$/);
});

test('rpg-42a.17 the TUI conversation hides the engine opening seed and keeps its narration', () => {
  const opening = {
    id: 't0',
    campaignId: 'c1',
    sceneId: 's1',
    actionId: 'opening',
    actorId: 'h1',
    input: 'Begin.',
    narration: 'A bell tolls.',
  };
  const shown = renderScreen(INITIAL_STATE, { ...data, snapshot: { ...snapshot, turns: [opening] } }, COLOR).join('\n');
  assert.doesNotMatch(shown, /Begin\./);
  assert.match(shown, /A bell tolls\./);
});

test('UI15: changed sheet values are highlighted on colour terminals only', () => {
  const changed = { ...data, changed: ['grit'] };
  const wide = { ...COLOR, width: LARGE_WIDTH, height: LARGE_HEIGHT };
  assert.ok(renderScreen(INITIAL_STATE, changed, wide).join('\n').includes(`${ACCENT}Grit: 3`));
  assert.ok(!renderScreen(INITIAL_STATE, data, wide).join('\n').includes(`${ACCENT}Grit: 3`));
  assert.ok(
    !renderScreen(INITIAL_STATE, changed, { ...PLAIN, width: LARGE_WIDTH })
      .join('\n')
      .includes(ESCAPE),
  );
});

const rollingSession = (session: ClientSession): ClientSession => {
  let rolled = false;
  const listeners: ((event: ClientEvent) => void)[] = [];
  return {
    ...session,
    requestView: ({ campaignId, viewId }) => ({
      ok: true,
      value: { campaignId, viewId, components: [{ kind: 'field', id: 'grit', label: 'Grit', value: rolled ? 4 : 3 }] },
    }),
    subscribeEvents: (command, listener) => {
      listeners.push(listener);
      return session.subscribeEvents(command, listener);
    },
    submitPlayerAction: (command) => {
      const accepted = session.submitPlayerAction(command);
      rolled = true;
      if (mechanic !== undefined) for (const listener of listeners) listener(mechanic);
      return accepted;
    },
  };
};

const playRoll = async (motion: boolean) => {
  const { engine, campaignId, session } = engineSession();
  const output: string[] = [];
  const timers: (() => void)[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const keys = async function* () {
    yield key('i');
    yield* typed(ACTION);
    yield RETURN;
    await gate;
    yield key('q');
  };
  const run = runTui(rollingSession(session), campaignId, {
    capabilities: { ...COLOR, width: LARGE_WIDTH, height: LARGE_HEIGHT },
    motion,
    schedule: (later) => {
      timers.push(later);
    },
    keys: keys(),
    lines: each([]),
    write: (text) => output.push(text),
  });
  while (engine.getState(campaignId).turns.at(-1)?.input !== ACTION) await new Promise(setImmediate);
  await new Promise(setImmediate);
  const committed = output.length;
  return {
    output,
    timers,
    committed,
    finish: async () => {
      release();
      await run;
    },
  };
};

test('UI15: an interactive TUI roll animates in short frames without blocking input or the committed turn', async () => {
  const { output, timers, committed, finish } = await playRoll(true);
  assert.match(output.at(-1) ?? '', /Wanderer: I wave\./);
  assert.ok((output.at(-1) ?? '').includes(`${ACCENT}Grit: 4`));
  assert.ok(timers.length > 1);
  for (const later of timers.splice(0)) later();
  const frames = output.slice(committed);
  assert.ok(frames.length > 1);
  assert.match(frames.at(-1) ?? '', /attack: d20 -> 14, Ace; modifier \+2; total 16; outcome hit/);
  assert.ok(!(output.at(-1) ?? '').includes(`${ACCENT}Grit: 4`));
  await finish();
});

test('UI15: without motion the TUI prints the roll result directly', async () => {
  const { output, timers, finish } = await playRoll(false);
  assert.equal(timers.length, 0);
  assert.match(output.at(-1) ?? '', /attack: d20 -> 14, Ace; modifier \+2; total 16; outcome hit/);
  assert.ok(!(output.at(-1) ?? '').includes(`${ACCENT}Grit`));
  await finish();
});

test('UI15: a sheet highlight timer that fires after quit writes nothing', async () => {
  const { campaignId, session } = engineSession();
  const output: string[] = [];
  const timers: (() => void)[] = [];
  await runTui(rollingSession(session), campaignId, {
    capabilities: { ...COLOR, width: LARGE_WIDTH, height: LARGE_HEIGHT },
    motion: true,
    schedule: (later) => {
      timers.push(later);
    },
    keys: each([key('i'), ...typed(ACTION), RETURN, key('q')]),
    lines: each([]),
    write: (text) => output.push(text),
  });
  const written = output.length;
  assert.ok(timers.length > 0);
  for (const later of timers.splice(0)) later();
  assert.equal(output.length, written);
});

test('rpg-42a.21: the TUI groups the sheet and edits a field with /edit, showing validation feedback', async () => {
  const sheet = [
    { kind: 'field', id: 'might', label: 'Might', value: 6, group: 'core', editable: true },
    { kind: 'field', id: 'oath', label: 'Oath', value: 'guard', group: 'core', editable: true },
    { kind: 'field', id: 'guard', label: 'Guard', value: 10, group: 'computed', editable: false },
  ] as const;
  const grouped = renderScreen(press([key('2')]), { ...data, sheet }, PLAIN_WIDE).join('\n');
  assert.match(grouped, /Core:[\s\S]*Might: 6[\s\S]*Oath: guard[\s\S]*Computed:[\s\S]*Guard: 10/);
  assert.match(screen(press([key('?')])), /\/edit <field> <value>/);
  const { session, campaignId } = engineSession();
  const edits: unknown[] = [];
  const editing: ClientSession = {
    ...session,
    requestView: ({ viewId }) => ({ ok: true, value: { campaignId, viewId, components: sheet } }),
    editSheetField: ({ fieldId, value }) => {
      edits.push([fieldId, value]);
      return value === 99
        ? { ok: false, error: { code: 'Rejected', message: 'might must be at most 20' } }
        : { ok: true, value: { revision: 3 } };
    },
  };
  const output: string[] = [];
  await runTui(editing, campaignId, {
    capabilities: PLAIN_WIDE,
    lines: each([
      '/edit might 8',
      '/edit oath keep the road',
      '/edit might lots',
      '/edit Guard 3',
      '/edit luck 1',
      '/edit might 99',
      'q',
    ]),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.deepEqual(edits, [
    ['might', 8],
    ['oath', 'keep the road'],
    ['might', 99],
  ]);
  assert.match(printed, /Might needs a number\./);
  assert.match(printed, /Guard cannot be edited\./);
  assert.match(printed, /No sheet field luck\./);
  assert.match(printed, /might must be at most 20/);
});

test('rpg-42a.67: /language <locale> sets the story language, shows the result and is listed in the help', async () => {
  assert.match(screen(press([key('?')])), /\/language <locale>/);
  const { session, campaignId } = engineSession();
  const sent: unknown[] = [];
  const switching: ClientSession = {
    ...session,
    setCampaignLanguage: ({ language }) => {
      sent.push(language);
      return language === 'es'
        ? { ok: true, value: { revision: 3 } }
        : { ok: false, error: { code: 'Rejected', message: 'language is not a locale' } };
    },
  };
  const output: string[] = [];
  await runTui(switching, campaignId, {
    capabilities: PLAIN_WIDE,
    lines: each(['/language es', '/language bad!', 'q']),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.deepEqual(sent, ['es', 'bad!']);
  assert.match(printed, /Story language set to es\./);
  assert.match(printed, /language is not a locale/);
});

test('rpg-42a.27 the TUI conversation shows a no-reply line for a blank narration', () => {
  const blank = {
    id: 't1',
    campaignId: 'c1',
    sceneId: 's1',
    actionId: 'a1',
    actorId: 'h1',
    input: 'wait',
    narration: '',
  };
  const shown = renderScreen(INITIAL_STATE, { ...data, snapshot: { ...snapshot, turns: [blank] } }, COLOR).join('\n');
  assert.match(shown, /No reply was recorded for this turn\./);
});

test('rpg-42a.33 the TUI says in plain words which game master is active', async () => {
  const notice = 'Claude Code is the GM.';
  for (const terminal of [
    { capabilities: PLAIN_WIDE, lines: each(['q']) },
    { capabilities: COLOR, keys: each([key('q')]), lines: each([]) },
  ]) {
    const { campaignId, session } = engineSession();
    const output: string[] = [];
    await runTui(session, campaignId, { ...terminal, write: (text) => output.push(text) }, async () => {}, notice);
    assert.ok(output.join('').includes(notice));
  }
});

test('rpg-42a.37: TUI help shows GM model and token use, and a crossed budget warns once without blocking', async () => {
  const { engine, campaignId, session } = engineSession();
  const used = {
    turns: 1,
    inputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    costUsd: 0,
    pricedTurns: 0,
  };
  const settings = { model: 'haiku', sessionBudgetTokens: 10 };
  const gm = { settings, campaignSettings: settings, defaults: {}, session: used, campaign: used };
  const withGm: ClientSession = {
    ...session,
    getSnapshot: (command) => {
      const result = session.getSnapshot(command);
      return result.ok ? { ok: true, value: { ...result.value, gm } } : result;
    },
  };
  const output: string[] = [];
  await runTui(withGm, campaignId, {
    capabilities: PLAIN_WIDE,
    lines: each(['?', ACTION, ACTION, 'q']),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.match(printed, /Help:[\s\S]*GM model: haiku \(cheaper and faster\)[\s\S]*This session: 1 GM turns, 60 tokens/);
  const helpAndOneNotice = 3;
  assert.equal(printed.split('more than the 10 token budget').length, helpAndOneNotice);
  assert.equal(engine.getState(campaignId).turns.filter(({ input }) => input === ACTION).length, 2);
});

const DICELESS_SHEETLESS = { resolution: 'adjudicated', sheet: 'none' } as const;
const characterSheet = [
  { kind: 'field', id: 'name', label: 'Name', value: 'Wanderer' },
  { kind: 'field', id: 'description', label: 'Description', value: 'A tired lighthouse keeper.' },
] as const;
const sheetlessData: TuiData = {
  ...data,
  snapshot: { ...snapshot, rules: DICELESS_SHEETLESS },
  sheet: characterSheet,
  mechanics: [],
};
const diceOnlyData: TuiData = { ...data, snapshot: { ...snapshot, rules: { resolution: 'dice', sheet: 'none' } } };

test('rpg-42a.38 the TUI of a diceless sheetless game shows a Character pane and hides Mechanics', () => {
  const screens = visibleRows(renderScreen(INITIAL_STATE, sheetlessData, PLAIN_WIDE)).join('\n');
  assert.match(screens, /\[1 Conversation\] 2 Character 3 Event log/);
  assert.doesNotMatch(screens, /Sheet|Mechanics|No sheet yet|No mechanics yet/);
  const panes = panesFor(DICELESS_SHEETLESS);
  assert.deepEqual(
    panes.map(({ id, key }) => [id, key]),
    [
      ['conversation', '1'],
      ['sheet', '2'],
      ['log', '3'],
    ],
  );
  const step = nextStateIn(panes);
  assert.equal(step(INITIAL_STATE, key('2')).pane, 1);
  assert.equal(step(INITIAL_STATE, key('4')).pane, INITIAL_STATE.pane);
  const character = visibleRows(renderScreen(step(INITIAL_STATE, key('2')), sheetlessData, PLAIN_WIDE)).join('\n');
  assert.match(
    character,
    /Name: Wanderer[\s\S]*Description: A tired lighthouse keeper\.[\s\S]*This game does not use character sheets\./,
  );
  const linear = renderLinear(sheetlessData, PLAIN_WIDE).join('\n');
  assert.match(linear, /Conversation:[\s\S]*Character:[\s\S]*Event log:/);
  assert.doesNotMatch(linear, /Sheet|Mechanics/);
});

test('rpg-42a.38 the TUI keeps mechanics for a dice game without a sheet and the Sheet pane for a full sheet game', () => {
  const screen = visibleRows(renderScreen(INITIAL_STATE, diceOnlyData, PLAIN_WIDE)).join('\n');
  assert.match(screen, /\[1 Conversation\] 2 Character 3 Event log 4 Mechanics/);
  assert.match(
    visibleRows(renderScreen(INITIAL_STATE, data, PLAIN_WIDE)).join('\n'),
    /2 Sheet 3 Event log 4 Mechanics/,
  );
});

test('rpg-cm63.17: runTui hands the playback control to the audio and /pause reaches it', async () => {
  const { campaignId, session } = engineSession();
  const calls: string[] = [];
  const playback = {
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    skip: () => void calls.push('skip'),
    stop: () => void calls.push('stop'),
  };
  await runTui(
    session,
    campaignId,
    {
      capabilities: PLAIN_WIDE,
      audio: (_session, _campaignId, given) =>
        createTuiAudio(
          {
            campaignId,
            turn: 0,
            pendingInput: [],
            preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
          },
          ['en-US'],
          () => undefined,
          undefined,
          given,
        ),
      lines: each(['/pause', '/skip', '/resume', '/stop', 'q']),
      write: () => {},
    },
    undefined,
    undefined,
    playback,
  );
  assert.deepEqual(calls, ['pause', 'skip', 'resume', 'stop']);
});

const NARRATION_TIMEOUT_MS = 3000;

const pausedDuringNarration = async (interactive: boolean) => {
  const { campaignId, session } = engineSession();
  const calls: string[] = [];
  const playback = {
    pause: () => void calls.push('pause'),
    resume: () => {},
    skip: () => {},
    stop: () => {},
  };
  let release = () => {};
  const narration = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seenWhileNarrating: string[][] = [];
  const keys = async function* () {
    yield key('i');
    yield* typed(ACTION);
    yield RETURN;
    yield key('i');
    yield* typed('/pause');
    yield RETURN;
    seenWhileNarrating.push([...calls]);
    release();
    yield key('q');
  };
  const lines = async function* () {
    yield ACTION;
    yield '/pause';
    seenWhileNarrating.push([...calls]);
    release();
    yield 'q';
  };
  await runTui(
    session,
    campaignId,
    {
      capabilities: interactive ? { ...COLOR, width: LARGE_WIDTH, height: LARGE_HEIGHT } : PLAIN_WIDE,
      audio: (_session, _campaignId, given) =>
        createTuiAudio(
          {
            campaignId,
            turn: 0,
            pendingInput: [],
            preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
          },
          ['en-US'],
          () => undefined,
          undefined,
          given,
        ),
      ...(interactive ? { keys: keys(), lines: each([]) } : { lines: lines() }),
      write: () => {},
    },
    () => narration,
    undefined,
    playback,
  );
  return seenWhileNarrating;
};

test('rpg-cm63.21: /pause typed while linear narration streams is handled before it ends', {
  timeout: NARRATION_TIMEOUT_MS,
}, async () => {
  assert.deepEqual(await pausedDuringNarration(false), [['pause']]);
});

test('rpg-cm63.21: /pause typed while interactive narration streams is handled before it ends', {
  timeout: NARRATION_TIMEOUT_MS,
}, async () => {
  assert.deepEqual(await pausedDuringNarration(true), [['pause']]);
});

const typedAhead = async (
  inputs: readonly string[],
  narrate: () => Promise<unknown>,
  afterInputs: (submitted: readonly string[]) => void,
) => {
  const { campaignId, session } = engineSession();
  const submitted: string[] = [];
  const spying: ClientSession = {
    ...session,
    submitPlayerAction: (command) => {
      submitted.push(command.input);
      return session.submitPlayerAction(command);
    },
  };
  const lines = async function* () {
    yield* inputs;
    await new Promise(setImmediate);
    afterInputs(submitted);
    yield 'q';
  };
  const audio = (_session: unknown, id: typeof campaignId, given?: Parameters<typeof createTuiAudio>[4]) =>
    createTuiAudio(
      {
        campaignId: id,
        turn: 0,
        pendingInput: [],
        preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
      },
      ['en-US'],
      () => undefined,
      undefined,
      given,
    );
  const playback = { pause: () => {}, resume: () => {}, skip: () => {}, stop: () => {} };
  await runTui(
    spying,
    campaignId,
    { capabilities: PLAIN_WIDE, audio, lines: lines(), write: () => {} },
    narrate,
    undefined,
    playback,
  );
  return submitted;
};

test('rpg-cm63.21: typed-ahead actions run in order behind the running narration', {
  timeout: NARRATION_TIMEOUT_MS,
}, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const narrations: Promise<void>[] = [gate];
  const seen: string[][] = [];
  const submitted = await typedAhead(
    ['first', 'second'],
    () => narrations.shift() ?? Promise.resolve(),
    (now) => {
      seen.push([...now]);
      release();
    },
  );
  assert.deepEqual(seen, [['first']]);
  assert.deepEqual(submitted, ['first', 'second']);
});

test('rpg-cm63.21: a playback command mid-stream starts no extra narration', {
  timeout: NARRATION_TIMEOUT_MS,
}, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let narrations = 0;
  const submitted = await typedAhead(
    ['first', '/pause'],
    () => {
      narrations += 1;
      return gate;
    },
    () => release(),
  );
  assert.equal(narrations, 1);
  assert.deepEqual(submitted, ['first']);
});

test('rpg-cm63.21: a narration failure ends the run with its error', { timeout: NARRATION_TIMEOUT_MS }, async () => {
  const failure = new Error('narration exploded');
  let narrations = 0;
  await assert.rejects(
    typedAhead(
      ['first', 'second', 'third'],
      () => {
        narrations += 1;
        return Promise.reject(failure);
      },
      () => {},
    ),
    failure,
  );
  assert.equal(narrations, 1);
});

test('rpg-cm63.21: a second typed line is queued and narrated like an action', {
  timeout: NARRATION_TIMEOUT_MS,
}, async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const narrations: Promise<void>[] = [gate];
  let narrated = 0;
  const seen: string[][] = [];
  const submitted = await typedAhead(
    ['first', 'look around'],
    () => {
      narrated += 1;
      return narrations.shift() ?? Promise.resolve();
    },
    (now) => {
      seen.push([...now]);
      release();
    },
  );
  assert.deepEqual(seen, [['first']]);
  assert.equal(narrated, 2);
  assert.deepEqual(submitted, ['first', 'look around']);
});

const ROLL_OFFER = {
  offerId: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
};

test('rpg-42a.74: the TUI conversation names an open roll offer and the /roll hint', () => {
  const offered = { ...data, snapshot: { ...snapshot, rollOffer: ROLL_OFFER } };
  assert.match(
    renderLinear(offered, PLAIN_WIDE).join('\n'),
    /Roll offered: Attack Old Tam with your sword\. Type \/roll/,
  );
  assert.doesNotMatch(renderLinear(data, PLAIN).join('\n'), /Roll offered/);
  assert.match(screen(press([key('?')])), /\/roll - Roll the check the GM offered\./);
});

test('rpg-42a.77: the TUI conversation shows why the last action did not roll, localized', () => {
  const actionId = snapshot.turns.at(-1)?.actionId;
  assert.ok(actionId);
  const skipped = { ...data, snapshot: { ...snapshot, noRoll: { actionId, reason: 'dice-off' as const } } };
  assert.match(renderLinear(skipped, PLAIN_WIDE).join('\n'), /No roll: dice are off\./);
  assert.doesNotMatch(renderLinear(data, PLAIN).join('\n'), /No roll:/);
});

test('rpg-42a.74: /roll accepts the open offer by id and says so when none is open', async () => {
  const { session, campaignId } = engineSession();
  const sent: unknown[] = [];
  const base = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.ok(base.ok);
  let offer: typeof ROLL_OFFER | undefined;
  const offering: ClientSession = {
    ...session,
    getSnapshot: (command) => {
      const result = session.getSnapshot(command);
      return result.ok
        ? { ok: true, value: { ...result.value, ...(offer === undefined ? {} : { rollOffer: offer }) } }
        : result;
    },
    submitPlayerAction: (command) => {
      sent.push([command.input, command.rollOfferId]);
      offer = undefined;
      return { ok: true, value: { revision: 3 } };
    },
  };
  const output: string[] = [];
  const lines = (async function* () {
    yield '/roll';
    offer = ROLL_OFFER;
    yield '/roll';
    yield 'q';
  })();
  await runTui(offering, campaignId, { capabilities: PLAIN_WIDE, lines, write: (text) => output.push(text) });
  assert.deepEqual(sent, [[ROLL_OFFER.label, ROLL_OFFER.offerId]]);
  assert.match(output.join(''), /No roll is offered right now\./);
});

test('rpg-42a.91: /gm and (( )) go to the GM out of character; yes confirms, no declines, revert undoes', async () => {
  const { session, campaignId } = engineSession();
  const sent: string[] = [];
  const confirmed: unknown[] = [];
  let narrated = 0;
  const proposal = {
    kind: 'table_note' as const,
    summary: 'Table note: NPCs speak modern English',
    note: 'NPCs speak modern English',
  };
  const gm: ClientSession = {
    ...session,
    submitPlayerAction: (command) => {
      sent.push(command.input);
      return { ok: true, value: { revision: 3 } };
    },
    submitOocMessage: async ({ text }) => {
      sent.push(`ooc:${text}`);
      return { ok: true, value: { reply: 'I can keep this.', proposals: [proposal] } };
    },
    confirmOocProposal: (command) => {
      confirmed.push(command.proposal);
      return { ok: true, value: { revision: 4, summary: proposal.summary } };
    },
    undoOocChange: () => ({ ok: true, value: { revision: 5, summary: proposal.summary } }),
  };
  const output: string[] = [];
  const lines = (async function* () {
    yield '(( NPCs speak modern English ))';
    yield '/gm no';
    yield '/gm yes';
    yield '/gm NPCs speak modern English';
    yield '/gm yes';
    yield '/gm revert';
    yield 'q';
  })();
  await runTui(gm, campaignId, { capabilities: PLAIN_WIDE, lines, write: (text) => output.push(text) }, async () => {
    narrated++;
  });
  const screenText = output.join('');
  assert.deepEqual(sent, ['ooc:NPCs speak modern English', 'ooc:NPCs speak modern English']);
  assert.equal(narrated, 0);
  assert.deepEqual(confirmed, [proposal]);
  assert.match(screenText, /GM \(out of character\): I can keep this\. 1\. Table note: NPCs speak modern English/);
  assert.match(screenText, /Nothing changed\./);
  assert.match(screenText, /There is nothing to confirm\./);
  assert.match(screenText, /Done: Table note: NPCs speak modern English\./);
  assert.match(screenText, /Undone: Table note/);
});

test('rpg-42a.107: after a retcon the TUI shows the taken-back action so the player can send it again', async () => {
  const { session, campaignId } = engineSession();
  const retcon = { kind: 'retcon_last_turn' as const, summary: 'Take back your last turn' };
  const gm: ClientSession = {
    ...session,
    submitOocMessage: async () => ({ ok: true, value: { reply: 'Sure.', proposals: [retcon] } }),
    confirmOocProposal: () => ({
      ok: true,
      value: { revision: 4, summary: retcon.summary, retconnedInput: 'I kick the door' },
    }),
  };
  const output: string[] = [];
  const lines = (async function* () {
    yield '/gm undo that';
    yield '/gm yes';
    yield 'q';
  })();
  await runTui(gm, campaignId, { capabilities: PLAIN_WIDE, lines, write: (text) => output.push(text) });
  assert.match(output.join(''), /taken-back\s+action was: I kick the door\./);
});

test('rpg-42a.91: the TUI talks to the GM in Brazilian Portuguese', async () => {
  const { session, campaignId } = engineSession();
  const current = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.ok(current.ok);
  const language = session.setCampaignLanguage({
    version: PROTOCOL_VERSION,
    type: 'SetCampaignLanguage',
    campaignId,
    actionId: 'pt',
    expectedRevision: current.value.revision,
    language: 'pt-BR',
  });
  assert.ok(language.ok);
  const output: string[] = [];
  const lines = (async function* () {
    yield '/gm você esqueceu meu +2 por terreno alto';
    yield '/gm não';
    yield 'q';
  })();
  await runTui(session, campaignId, {
    capabilities: PLAIN_WIDE,
    lines,
    write: (text) => output.push(text),
    locale: 'pt-BR',
  });
  assert.match(output.join(''), /Mestre \(fora do personagem\): Justo\./);
  assert.match(output.join(''), /Nada mudou\./);
});

test('rpg-42a.89: a roll an NPC made is labelled with the NPC name in the terminal indicator', () => {
  const npcRoll = toVisualizationEvent(
    {
      resultId: 'tam-swing',
      mechanic: 'dice',
      visibility: 'player',
      reveals: [{ kind: 'die', sides: 20, face: 12 }],
      total: 15,
      roller: 'Old Tam',
    },
    'player',
    { enabled: true },
  );
  assert.ok(npcRoll);
  assert.match(rollFrames(npcRoll, ROLL_STEPS).at(-1) ?? '', /; rolled by Old Tam$/);
  assert.match(rollFrames(npcRoll, ROLL_STEPS, 'pt-BR').at(-1) ?? '', /; rolada por Old Tam$/);
});

test('rpg-42a.90: the terminal roll line breaks the total down in English and Brazilian Portuguese', () => {
  const event = toVisualizationEvent(
    {
      resultId: 'r-breakdown',
      mechanic: 'dice',
      visibility: 'player',
      reveals: [{ kind: 'die', sides: 20, face: 12 }],
      total: 7,
      modifier: -5,
      breakdown: {
        attribute: { id: 'wits', value: -3 },
        modifiers: [{ id: 'darkness', reason: 'the lantern went out', kind: 'flat', value: -2 }],
        target: 10,
      },
    },
    'player',
    { enabled: true },
  );
  assert.ok(event);
  assert.match(
    rollFrames(event, ROLL_STEPS).at(-1) ?? '',
    /; Die 12; wits -3; darkness -2: the lantern went out; Total 7 against 10$/,
  );
  assert.match(rollFrames(event, ROLL_STEPS, 'pt-BR').at(-1) ?? '', /; Dado 12; wits -3; .*; Total 7 contra 10$/);
});

const limited = () => new ProviderError('limit', undefined, false, { kind: 'limit', detail: '3:30pm (Europe/Lisbon)' });

const failingNarration = async (capabilities: Capabilities, inputs: readonly (string | Key)[], locale?: string) => {
  const { campaignId, session } = engineSession();
  const output: string[] = [];
  let calls = 0;
  const submitted: string[] = [];
  const spying: ClientSession = {
    ...session,
    submitPlayerAction: (command) => {
      submitted.push(command.input);
      return session.submitPlayerAction(command);
    },
  };
  await runTui(
    spying,
    campaignId,
    {
      capabilities,
      ...(locale === undefined ? {} : { locale }),
      keys: each(inputs.filter((input): input is Key => typeof input !== 'string')),
      lines: each(inputs.filter((input): input is string => typeof input === 'string')),
      write: (text) => output.push(text),
    },
    async () => {
      calls += 1;
      if (calls === 1) throw limited();
    },
  );
  return { text: stripVTControlCharacters(output.join('')).replace(/\s+/g, ' '), calls, submitted };
};

test('rpg-42a.101: a provider failure shows the reason and /retry narrates the pending action again', async () => {
  const { text, calls, submitted } = await failingNarration(PLAIN_WIDE, ['I wave', '/retry', 'q']);
  assert.match(text, /usage limit is reached\. It resets 3:30pm \(Europe\/Lisbon\)/);
  assert.match(text, /Type \/retry to try again\./);
  assert.equal(calls, 2);
  assert.deepEqual(submitted, ['I wave']);
});

test('rpg-42a.101: the interactive TUI shows the failure notice and keeps running', async () => {
  const { text, calls } = await failingNarration(COLOR, [
    key('i'),
    ...typed('I wave'),
    RETURN,
    key('i'),
    ...typed('/retry'),
    RETURN,
    key('q'),
  ]);
  assert.match(text, /usage limit is reached/);
  assert.equal(calls, 2);
});

test('rpg-42a.101: the failure notice follows the terminal language', async () => {
  const { text } = await failingNarration(PLAIN_WIDE, ['I wave', 'q'], 'pt-BR');
  assert.match(text, /limite de uso/);
  assert.match(text, /\/repetir/);
});

test('rpg-42a.101: /retry is listed and named in every locale', () => {
  assert.equal(matchSlash('en', 'tui', '/ret')[0]?.id, 'retry');
  assert.equal(matchSlash('es', 'tui', '/reint')[0]?.id, 'retry');
  assert.equal(matchSlash('pt-BR', 'tui', '/rep')[0]?.id, 'retry');
});

test('rpg-42a.61: /memory lists the story facts by person, place and thread and corrects one by number', async () => {
  const { session, campaignId } = engineSession();
  const entry = (entityId: string, entityName: string, value: string, corrected = false) => ({
    entityId,
    entityName,
    kind: 'alive' as const,
    key: '',
    value,
    sourceEventId: 'e1',
    corrected,
  });
  const memory = {
    person: [entry('p1', 'Mira', 'alive', true)],
    place: [entry('l1', 'Ember Inn', 'alive')],
    thread: [],
  };
  const fixes: unknown[] = [];
  const remembering = {
    ...session,
    getStoryMemory: (command) => ({
      ok: true,
      value: { version: command.version, campaignId, revision: 7, memory },
    }),
    correctStoryFact: (command) => {
      fixes.push(command);
      return { ok: true, value: { revision: 8 } };
    },
  } as ClientSession;
  const output: string[] = [];
  await runTui(remembering, campaignId, {
    capabilities: PLAIN_WIDE,
    lines: each(['/memory', '/memory 2 dead', '/memory 9 dead', 'q']),
    write: (text) => output.push(text),
  });
  const printed = output.join('');
  assert.match(printed, /What the story remembers/);
  assert.match(printed, /People\n1\. Mira - alive: alive \(corrected\)\nPlaces\n2\. Ember Inn - alive: alive\nThreads/);
  assert.equal(fixes.length, 1);
  assert.match(JSON.stringify(fixes[0]), /"entityId":"l1".*"kind":"alive".*"value":"dead"/);
  assert.equal((fixes[0] as { expectedRevision: number }).expectedRevision, 7);
  assert.match(printed, /Corrected: Ember Inn - alive: dead/);
  assert.match(printed, /There is no fact number 9\./);
});

test('rpg-42a.61: /memory shows a plain notice when the story is rejected', async () => {
  const { session, campaignId } = engineSession();
  const rejected = {
    ...session,
    getStoryMemory: () => ({ ok: false, error: { code: 'Rejected', message: 'no story' } }),
  } as ClientSession;
  const output: string[] = [];
  await runTui(rejected, campaignId, {
    capabilities: PLAIN_WIDE,
    lines: each(['/memory', '/memory 1 dead', 'q']),
    write: (text) => output.push(text),
  });
  assert.equal(output.join('').match(/The story memory is not available right now\./g)?.length, 2);
});

test('rpg-42a.61: /memory says why a correction was refused', async () => {
  const { session, campaignId } = engineSession();
  const entry = {
    entityId: 'p1',
    entityName: 'Mira',
    kind: 'alive',
    key: '',
    value: 'alive',
    sourceEventId: 'e1',
    corrected: false,
  };
  const refusing = {
    ...session,
    getStoryMemory: (command) => ({
      ok: true,
      value: { version: command.version, campaignId, revision: 7, memory: { person: [entry], place: [], thread: [] } },
    }),
    correctStoryFact: () => ({ ok: false, error: { code: 'StaleRevision', message: 'stale' } }),
  } as ClientSession;
  const output: string[] = [];
  await runTui(refusing, campaignId, {
    capabilities: PLAIN_WIDE,
    lines: each(['/memory 1 dead', 'q']),
    write: (text) => output.push(text),
  });
  assert.match(output.join(''), /The correction was refused: stale/);
});
