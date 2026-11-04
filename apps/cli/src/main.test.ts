import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignGateway, EXIT_FAILURE, main } from './main.ts';

const ESCAPE = String.fromCharCode(27);
const FAILURE = 'Campaign Ember is broken.';
const PLAYER_LINES = ['I wave.', 'I sit.'];

const lines = async function* (input: readonly string[]) {
  yield* input;
};

const setup = (input: readonly string[] = PLAYER_LINES) => {
  const calls: string[] = [];
  const gateway: CampaignGateway = {
    launch: () => {
      calls.push('launch');
      return 'Launched.';
    },
    create: (name) => {
      calls.push(`create:${name}`);
      return `Created campaign ${name}.`;
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
    for (const command of ['launch', 'new', 'play', 'resume', 'import', 'help']) {
      assert.match(text, new RegExp(`^  ${command}\\b.* - .+$`, 'm'));
    }
    assert.deepEqual(err, []);
  }
});

test('launch, new, play and resume dispatch to the gateway and confirm', async () => {
  const cases: [string[], string][] = [
    [[], 'launch'],
    [['launch'], 'launch'],
    [['new', 'Ember'], 'create:Ember'],
    [['play', 'Ember'], 'play:Ember'],
    [['resume', 'Ember'], 'resume:Ember'],
    [['import', 'rules.md', 'core.pdf'], 'import:rules.md,core.pdf'],
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
    [['new', 'a', 'b'], 'b'],
    [['launch', 'x'], 'x'],
    [['help', 'x'], 'x'],
    [['play', 'Ember', '--fast'], '--fast'],
    [['--bogus'], '--bogus'],
    [['import'], 'import'],
    [['import', ' '], 'import'],
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
    launch: broken,
    create: broken,
    open: async function* () {
      yield 'Opened.';
      broken();
    },
    importRules: async function* () {
      yield 'Reading.';
      broken();
    },
  };
  for (const argv of [[], ['new', 'Ember'], ['play', 'Ember'], ['resume', 'Ember'], ['import', 'rules.md']]) {
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
