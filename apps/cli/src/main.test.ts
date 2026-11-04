import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignGateway, main } from './main.ts';

const ESCAPE = String.fromCharCode(27);

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
    open: (campaign, mode) => {
      calls.push(`${mode}:${campaign}`);
      return `Opened campaign ${campaign} to ${mode}.`;
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
  return { calls, gateway, io, out, err };
};

test('help lists every command with a one-line description in plain text', () => {
  for (const argv of [['help'], ['--help']]) {
    const { gateway, io, out, err } = setup();
    assert.equal(main(argv, io, gateway), 0);
    const text = out.join('');
    for (const command of ['launch', 'new', 'play', 'resume', 'help']) {
      assert.match(text, new RegExp(`^  ${command}\\b.* - .+$`, 'm'));
    }
    assert.deepEqual(err, []);
  }
});

test('launch, new, play and resume dispatch to the gateway and confirm', () => {
  const cases: [string[], string][] = [
    [[], 'launch'],
    [['launch'], 'launch'],
    [['new', 'Ember'], 'create:Ember'],
    [['play', 'Ember'], 'play:Ember'],
    [['resume', 'Ember'], 'resume:Ember'],
  ];
  for (const [argv, call] of cases) {
    const { calls, gateway, io, out, err } = setup();
    assert.equal(main(argv, io, gateway), 0);
    assert.deepEqual(calls, [call]);
    assert.ok(out.join('').trim().length > 0);
    assert.deepEqual(err, []);
  }
});

test('usage errors exit 2, hint at rpg help and never call the gateway', () => {
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
    assert.equal(main(argv, io, gateway), 2, argv.join(' '));
    assert.deepEqual(calls, []);
    assert.deepEqual(out, []);
    assert.ok(err.join('').includes(named), argv.join(' '));
    assert.match(err.join(''), /rpg help/);
  }
});

test('output contains no ANSI escape sequences', () => {
  for (const argv of [['help'], [], ['new', 'Ember'], ['dance'], ['new']]) {
    const { gateway, io, out, err } = setup();
    main(argv, io, gateway);
    assert.ok(![...out, ...err].join('').includes(ESCAPE));
  }
});
