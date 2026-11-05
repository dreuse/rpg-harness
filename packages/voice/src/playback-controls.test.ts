import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPlaybackCommand, PLAYBACK_COMMANDS } from './playback-controls.ts';

const control = () => {
  const calls: string[] = [];
  return {
    calls,
    control: Object.fromEntries(PLAYBACK_COMMANDS.map((name) => [name, () => void calls.push(name)])) as never,
  };
};

test('applyPlaybackCommand routes each known command and rejects anything else', () => {
  const { calls, control: target } = control();
  for (const name of PLAYBACK_COMMANDS) assert.equal(applyPlaybackCommand(target, name), true);
  assert.deepEqual(calls, [...PLAYBACK_COMMANDS]);
  for (const bad of ['rm', 42, undefined, 'constructor']) assert.equal(applyPlaybackCommand(target, bad), false);
  assert.equal(calls.length, PLAYBACK_COMMANDS.length);
});
