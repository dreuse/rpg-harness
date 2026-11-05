import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProcessSink, type PlayerProcess, type SpawnPlayer } from './process-sink.ts';
import type { SpeechChunk } from './tts.ts';

const AUDIO = new Uint8Array([1, 2, 3]);
const chunk = (mimeType = 'audio/wav'): SpeechChunk => ({
  utteranceEventId: 'e',
  sequence: 0,
  audio: AUDIO,
  mimeType,
  voiceId: 'v',
  final: true,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakePlayer extends EventEmitter implements PlayerProcess {
  readonly signals: string[] = [];
  kill(signal?: NodeJS.Signals | number) {
    this.signals.push(String(signal));
    if (signal === 'SIGKILL') this.emit('close', null);
    return true;
  }
}

const harness = (platform: NodeJS.Platform = 'darwin') => {
  const spawned: { command: string; args: readonly string[]; file: string | undefined; bytes: Uint8Array }[] = [];
  const players: FakePlayer[] = [];
  const spawn: SpawnPlayer = (command, args) => {
    const file = args.at(-1);
    spawned.push({
      command,
      args,
      file,
      bytes: file !== undefined && existsSync(file) ? readFileSync(file) : new Uint8Array(),
    });
    const player = new FakePlayer();
    players.push(player);
    return player;
  };
  const sink = createProcessSink({ platform, spawn });
  return { sink, spawned, players };
};

test('plays a chunk through the platform player and removes the temp file when it ends', async (t) => {
  const { sink, spawned, players } = harness();
  t.after(() => sink.dispose());
  const done = sink.play(chunk(), 1, new AbortController().signal);
  await tick();
  assert.equal(spawned[0]?.command, '/usr/bin/afplay');
  assert.deepEqual([...(spawned[0]?.bytes ?? [])], [...AUDIO]);
  assert.match(spawned[0]?.file ?? '', /\.wav$/);
  players[0]?.emit('close', 0);
  await done;
  assert.equal(existsSync(spawned[0]?.file ?? ''), false);
});

test('pause stops the running player and resume continues it', async (t) => {
  const { sink, players } = harness();
  t.after(() => sink.dispose());
  const done = sink.play(chunk(), 1, new AbortController().signal);
  await tick();
  sink.pause?.();
  sink.resume?.();
  assert.deepEqual(players[0]?.signals, ['SIGSTOP', 'SIGCONT']);
  players[0]?.emit('close', 0);
  await done;
});

test('abort kills the player even when it is paused', async (t) => {
  const { sink, players } = harness();
  t.after(() => sink.dispose());
  const controller = new AbortController();
  const done = sink.play(chunk(), 1, controller.signal);
  await tick();
  sink.pause?.();
  controller.abort();
  await done;
  assert.equal(players[0]?.signals.at(-1), 'SIGKILL');
});

test('an already aborted signal never starts a player', async (t) => {
  const { sink, spawned } = harness();
  t.after(() => sink.dispose());
  const controller = new AbortController();
  controller.abort();
  await sink.play(chunk(), 1, controller.signal);
  assert.equal(spawned.length, 0);
});

test('a platform without a player rejects so the turn stays in text', async (t) => {
  const { sink } = harness('win32');
  t.after(() => sink.dispose());
  await assert.rejects(sink.play(chunk(), 1, new AbortController().signal), /audio player/);
});

test('a player that cannot start rejects the play', async (t) => {
  const { sink, players } = harness();
  t.after(() => sink.dispose());
  const done = sink.play(chunk(), 1, new AbortController().signal);
  await tick();
  players[0]?.emit('error', new Error('spawn failed'));
  await assert.rejects(done, /spawn failed/);
});

test('dispose removes the temp directory', async () => {
  const { sink, spawned, players } = harness();
  const done = sink.play(chunk(), 1, new AbortController().signal);
  await tick();
  const dir = join(spawned[0]?.file ?? '', '..');
  assert.ok(readdirSync(dir).length > 0);
  players[0]?.emit('close', 0);
  await done;
  sink.dispose();
  assert.equal(existsSync(dir), false);
});

test('dispose kills a playing player before it removes the temp directory', async () => {
  const { sink, players } = harness();
  void sink.play(chunk(), 1, new AbortController().signal);
  await tick();
  sink.dispose();
  assert.equal(players[0]?.signals.at(-1), 'SIGKILL');
});
