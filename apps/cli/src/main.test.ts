import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignGateway, EXIT_FAILURE, EXIT_USAGE, main } from './main.ts';
import type { Terminal } from './tui.ts';
import { defaultTuiAudio } from './tui-audio.ts';

const ESCAPE = String.fromCharCode(27);
const FAILURE = 'Campaign Ember is broken.';
const PLAYER_LINES = ['I wave.', 'I sit.'];

const lines = async function* (input: readonly string[]) {
  yield* input;
};

const setup = (input: readonly string[] = PLAYER_LINES) => {
  const calls: string[] = [];
  const gateway: CampaignGateway = {
    home: async (terminal) => {
      calls.push('home');
      terminal.write('Home.\n');
    },
    create: async function* (name, intent) {
      calls.push(intent === undefined ? `create:${name}` : `create:${name}:${intent}`);
      yield `Created campaign ${name}.`;
    },
    list: () => {
      calls.push('list');
      return 'Campaigns: Ember';
    },
    archive: (name) => {
      calls.push(`archive:${name}`);
      return `Archived campaign ${name}.`;
    },
    remove: async function* (name, input) {
      calls.push(`delete:${name}`);
      for await (const line of input) yield `confirm:${line}`;
    },
    open: async function* (campaign, mode, input) {
      calls.push(`${mode}:${campaign}`);
      yield `Opened campaign ${campaign} to ${mode}.`;
      for await (const line of input) yield line;
    },
    importRules: async function* (files, input) {
      calls.push(`import:${files.join(',')}`);
      for await (const line of input) yield `reply:${line}`;
    },
    exportCampaign: (name, file) => {
      calls.push(`export:${name}:${file}`);
      return `Exported campaign ${name}.`;
    },
    backup: (name) => {
      calls.push(`backup:${name}`);
      return `Backed up campaign ${name}.`;
    },
    restore: (file) => {
      calls.push(`restore:${file}`);
      return `Restored ${file}.`;
    },
    view: (name, view) => {
      calls.push(`${view}:${name}`);
      return `Viewed ${view}.`;
    },
    tui: async (name) => {
      calls.push(`tui:${name}`);
    },
    start: async function* (input) {
      calls.push('start');
      for await (const line of input) yield `answer:${line}`;
    },
    update: async function* (request) {
      calls.push(`update:${JSON.stringify(request)}`);
      yield 'rpg 1.2.0 is up to date.';
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    lines: lines(input),
  };
  return { calls, gateway, io, out, err };
};

test('help lists every command with a one-line description in plain text', async () => {
  for (const argv of [['help'], ['--help']]) {
    const { gateway, io, out, err } = setup();
    assert.equal(await main(argv, io, gateway), 0);
    const text = out.join('');
    for (const command of [
      'launch',
      'new',
      'play',
      'resume',
      'list',
      'archive',
      'delete',
      'import',
      'export',
      'backup',
      'restore',
      'sheet',
      'sheet-export',
      'inventory',
      'journal',
      'quests',
      'encounter',
      'recap',
      'start',
      'update',
      'help',
    ]) {
      assert.match(text, new RegExp(`^  ${command}\\b.* - .+$`, 'm'));
    }
    assert.deepEqual(err, []);
  }
});

test('rpg-42a.14 start runs the guided start with the input lines and takes no arguments', async () => {
  const { calls, gateway, io, out, err } = setup(['2']);
  assert.equal(await main(['start'], io, gateway), 0);
  assert.deepEqual(calls, ['start']);
  assert.deepEqual(out, ['answer:2\n']);
  assert.deepEqual(err, []);
  assert.equal(await main(['start', 'Ember'], setup().io, gateway), EXIT_USAGE);
});

test('new asks questions on stdout and reads each answer from the input lines', async () => {
  const { gateway, io, out, err } = setup(['Ash']);
  const answers: (string | undefined)[] = [];
  gateway.create = async function* (_name, _intent, ask) {
    answers.push(await ask('Name?'), await ask('Calling?'));
    yield 'Done.';
  };
  assert.equal(await main(['new', 'Ember'], io, gateway), 0);
  assert.deepEqual(answers, ['Ash', undefined]);
  assert.deepEqual(out, ['Name?\n', 'Calling?\n', 'Done.\n']);
  assert.deepEqual(err, []);
});

test('new releases the input lines exactly once whether or not it asks anything', async () => {
  for (const questions of [[], ['Name?']]) {
    const { gateway, io } = setup();
    let released = 0;
    const source = lines(['Ash']);
    const counted: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => source.next(),
        return: async () => {
          released += 1;
          return { done: true, value: undefined };
        },
      }),
    };
    gateway.create = async function* (_name, _intent, ask) {
      for (const question of questions) await ask(question);
      yield 'Done.';
    };
    assert.equal(await main(['new', 'Ember'], { ...io, lines: counted }, gateway), 0);
    assert.equal(released, 1);
  }
});

test('launch, new, play and resume dispatch to the gateway and confirm', async () => {
  const cases: [string[], string][] = [
    [[], 'home'],
    [['launch'], 'home'],
    [['tui'], 'home'],
    [['new', 'Ember'], 'create:Ember'],
    [['new', 'Ember', 'A spooky tale'], 'create:Ember:A spooky tale'],
    [['play', 'Ember'], 'play:Ember'],
    [['resume', 'Ember'], 'resume:Ember'],
    [['list'], 'list'],
    [['archive', 'Ember'], 'archive:Ember'],
    [['delete', 'Ember'], 'delete:Ember'],
    [['import', 'rules.md', 'core.pdf'], 'import:rules.md,core.pdf'],
    [['export', 'Ember', 'ember.json'], 'export:Ember:ember.json'],
    [['backup', 'Ember'], 'backup:Ember'],
    [['restore', 'ember.json'], 'restore:ember.json'],
    [['sheet', 'Ember'], 'sheet:Ember'],
    [['inventory', 'Ember'], 'inventory:Ember'],
    [['journal', 'Ember'], 'journal:Ember'],
    [['quests', 'Ember'], 'quests:Ember'],
    [['encounter', 'Ember'], 'encounter:Ember'],
    [['recap', 'Ember'], 'recap:Ember'],
  ];
  for (const [argv, call] of cases) {
    const { calls, gateway, io, out, err } = setup();
    assert.equal(await main(argv, io, gateway), 0);
    assert.deepEqual(calls, [call]);
    assert.ok(out.join('').trim().length > 0);
    assert.deepEqual(err, []);
  }
});

test('usage errors exit 2, hint at rpg help and never call the gateway', async () => {
  const bad: [string[], string][] = [
    [['dance'], 'dance'],
    [['new'], 'new'],
    [['play'], 'play'],
    [['resume'], 'resume'],
    [['new', ''], 'new'],
    [['new', '   '], 'new'],
    [['play', '  '], 'play'],
    [['resume', ''], 'resume'],
    [['resume', ' \t'], 'resume'],
    [['new', 'a', 'b', 'c'], 'c'],
    [['play', 'a', 'b'], 'b'],
    [['launch', 'x'], 'x'],
    [['help', 'x'], 'x'],
    [['play', 'Ember', '--fast'], '--fast'],
    [['--bogus'], '--bogus'],
    [['import'], 'import'],
    [['import', ' '], 'import'],
    [['list', 'x'], 'x'],
    [['archive'], 'archive'],
    [['archive', ' '], 'archive'],
    [['sheet'], 'sheet'],
    [['quests', 'a', 'b'], 'b'],
    [['archive', 'a', 'b'], 'b'],
    [['delete'], 'delete'],
    [['delete', 'a', 'b'], 'b'],
    [['export'], 'export'],
    [['export', 'Ember'], 'export'],
    [['export', 'Ember', ' '], 'export'],
    [['export', 'a', 'b', 'c'], 'c'],
    [['backup'], 'backup'],
    [['backup', 'a', 'b'], 'b'],
    [['restore'], 'restore'],
    [['restore', ' '], 'restore'],
    [['restore', 'a', 'b'], 'b'],
  ];
  for (const [argv, named] of bad) {
    const { calls, gateway, io, out, err } = setup();
    assert.equal(await main(argv, io, gateway), 2, argv.join(' '));
    assert.deepEqual(calls, []);
    assert.deepEqual(out, []);
    assert.ok(err.join('').includes(named), argv.join(' '));
    assert.match(err.join(''), /rpg help/);
  }
});

test('play and resume stream player lines through the gateway', async () => {
  for (const mode of ['play', 'resume']) {
    const { io, gateway, out } = setup();
    assert.equal(await main([mode, 'Ember'], io, gateway), 0);
    assert.deepEqual(
      out.slice(1),
      PLAYER_LINES.map((line) => `${line}\n`),
    );
  }
});

test('gateway failures exit 1 and report the error on stderr', async () => {
  const broken = (): never => {
    throw new Error(FAILURE);
  };
  const failing: CampaignGateway = {
    home: async () => broken(),
    create: broken,
    list: broken,
    archive: broken,
    remove: async function* () {
      yield 'Confirm.';
      broken();
    },
    open: async function* () {
      yield 'Opened.';
      broken();
    },
    importRules: async function* () {
      yield 'Reading.';
      broken();
    },
    exportCampaign: broken,
    backup: broken,
    restore: broken,
    view: broken,
    tui: async () => broken(),
    start: async function* () {
      yield 'New adventure';
      broken();
    },
    update: async function* () {
      yield 'Checking.';
      broken();
    },
  };
  for (const argv of [
    [],
    ['new', 'Ember'],
    ['play', 'Ember'],
    ['resume', 'Ember'],
    ['list'],
    ['archive', 'Ember'],
    ['delete', 'Ember'],
    ['import', 'rules.md'],
    ['export', 'Ember', 'ember.json'],
    ['backup', 'Ember'],
    ['restore', 'ember.json'],
    ['sheet', 'Ember'],
    ['tui', 'Ember'],
    ['tui'],
    ['start'],
    ['update'],
  ]) {
    const { io, err } = setup();
    assert.equal(await main(argv, io, failing), EXIT_FAILURE, argv.join(' '));
    assert.deepEqual(err, [`${FAILURE}\n`]);
  }
});

test('output contains no ANSI escape sequences', async () => {
  for (const argv of [['help'], [], ['new', 'Ember'], ['dance'], ['new']]) {
    const { gateway, io, out, err } = setup();
    await main(argv, io, gateway);
    assert.ok(![...out, ...err].join('').includes(ESCAPE));
  }
});

const FREEFORM_HELP_LINE = 'ask the stranger for help';
const FREEFORM_QUIT_LINE = 'I quit my job and leave';

test('cli accepts freeform turns and supports keyboard-friendly history, help and errors', async () => {
  const { gateway, io, out, err } = setup(['I wave.', '/history', '/help', '/bogus', 'I sit.', '/quit', 'never seen']);
  assert.equal(await main(['play', 'Ember'], io, gateway), 0);
  const text = out.join('');
  assert.match(text, /^1\. I wave\.$/m);
  assert.match(text, /plain text/i);
  for (const control of ['/help', '/history', '/quit']) assert.ok(text.includes(control));
  assert.match(err.join(''), /\/bogus/);
  assert.match(err.join(''), /\/help/);
  assert.ok(text.includes('I sit.'));
  assert.ok(!text.includes('never seen'));
  assert.ok(!text.includes('/bogus'));
});

test('gameplay does not require commands for normal actions', async () => {
  const { gateway, io, out, err } = setup([FREEFORM_HELP_LINE, FREEFORM_QUIT_LINE]);
  assert.equal(await main(['play', 'Ember'], io, gateway), 0);
  assert.deepEqual(
    out.slice(1),
    [FREEFORM_HELP_LINE, FREEFORM_QUIT_LINE].map((line) => `${line}\n`),
  );
  assert.deepEqual(err, []);
});

test('import streams conversation replies to the import workflow and honours /quit', async () => {
  const { calls, gateway, io, out, err } = setup(['use my-pack', '/quit', 'activate']);
  assert.equal(await main(['import', 'rules.md'], io, gateway), 0);
  assert.deepEqual(calls, ['import:rules.md']);
  assert.deepEqual(out, ['reply:use my-pack\n']);
  assert.deepEqual(err, []);
});

test('session help lists only the controls the session supports', async () => {
  const play = setup(['/help']);
  assert.equal(await main(['play', 'Ember'], play.io, play.gateway), 0);
  assert.match(play.out.join(''), /\/sheet/);
  const imports = setup(['/help']);
  assert.equal(await main(['import', 'rules.md'], imports.io, imports.gateway), 0);
  assert.match(imports.out.join(''), /\/history/);
  assert.doesNotMatch(imports.out.join(''), /\/sheet/);
});

test('A18 tui gets voice controls only with --voice', async () => {
  const terminals: Terminal[] = [];
  for (const argv of [
    ['tui', 'Ember'],
    ['tui', 'Ember', '--voice'],
  ]) {
    const { gateway, io } = setup();
    assert.equal(
      await main(argv, io, { ...gateway, tui: async (_name, terminal) => void terminals.push(terminal) }),
      0,
    );
  }
  const voicedHome = setup();
  assert.equal(
    await main(['tui', '--voice'], voicedHome.io, {
      ...voicedHome.gateway,
      home: async (terminal) => void terminals.push(terminal),
    }),
    0,
  );
  const [plain, voiced, home] = terminals;
  assert.equal(plain?.audio, undefined);
  assert.equal(voiced?.audio, defaultTuiAudio);
  assert.equal(home?.audio, defaultTuiAudio);
  const { gateway, io, err } = setup();
  assert.equal(await main(['play', 'Ember', '--voice'], io, gateway), EXIT_USAGE);
  assert.match(err.join(''), /--voice/);
  const help = setup();
  await main(['help'], help.io, help.gateway);
  assert.match(help.out.join(''), /tui \[campaign\] \[--voice\]/);
});

test('rpg-42a.16 update --check prints the status and exits 0', async () => {
  const { calls, gateway, io, out, err } = setup();
  assert.equal(await main(['update', '--check'], io, gateway), 0);
  assert.deepEqual(calls, ['update:{"check":true}']);
  assert.deepEqual(out, ['rpg 1.2.0 is up to date.\n']);
  assert.deepEqual(err, []);
});

test('rpg-42a.16 update passes the auto-check and pre-release settings', async () => {
  const { calls, gateway, io } = setup();
  assert.equal(await main(['update'], io, gateway), 0);
  assert.equal(await main(['update', '--no-auto-check', '--pre-release'], io, gateway), 0);
  assert.equal(await main(['update', '--auto-check', '--no-pre-release'], io, gateway), 0);
  assert.deepEqual(calls, [
    'update:{"check":false}',
    'update:{"check":false,"autoCheck":false,"preRelease":true}',
    'update:{"check":false,"autoCheck":true,"preRelease":false}',
  ]);
});

test('rpg-42a.16 update options work only with update and update takes no arguments', async () => {
  for (const argv of [
    ['list', '--check'],
    ['play', 'Ember', '--no-auto-check'],
    ['update', 'now'],
  ]) {
    const { calls, gateway, io } = setup();
    assert.equal(await main(argv, io, gateway), EXIT_USAGE, argv.join(' '));
    assert.deepEqual(calls, []);
  }
});
