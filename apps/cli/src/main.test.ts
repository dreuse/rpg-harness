import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignGateway, EXIT_FAILURE, main } from './main.ts';

const ESCAPE = String.fromCharCode(27);
const FAILURE = 'Campaign Ember is broken.';
const PLAYER_LINES = ['I wave.', 'I sit.'];

const lines = async function* () {
  yield* PLAYER_LINES;
};

const setup = () => {
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
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    lines: lines(),
  };
  return { calls, gateway, io, out, err };
};

test('help lists every command with a one-line description in plain text', async () => {
  for (const argv of [['help'], ['--help']]) {
    const { gateway, io, out, err } = setup();
    assert.equal(await main(argv, io, gateway), 0);
    const text = out.join('');
    for (const command of ['launch', 'new', 'play', 'resume', 'help']) {
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
  };
  for (const argv of [[], ['new', 'Ember'], ['play', 'Ember'], ['resume', 'Ember']]) {
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
