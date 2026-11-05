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
import { toVisualizationEvent, type VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import { MAIN_BRANCH } from '../../../packages/domain/src/campaign.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { openScene } from '../../../packages/engine/src/turn.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createClientSessions, scopedEventsOf } from './client-session.ts';
import { EXIT_OK } from './main.ts';
import {
  type Capabilities,
  capabilitiesOf,
  INITIAL_STATE,
  motionOf,
  nextState,
  renderLinear,
  renderScreen,
  rollFrames,
  runTui,
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
    const env = { ...process.env, RPG_DATA_DIR: dataDir, TERM: 'dumb', NO_COLOR: '1' };
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
    const env = { ...process.env, RPG_DATA_DIR: dataDir, TERM: 'dumb', NO_COLOR: '1' };
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
