import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoopSink, NO_PLAYER_MESSAGE_LOOP, VOLUME_RESTART_STEP } from './loop-sink.ts';
import type { PlayerProcess } from './process-sink.ts';

const PATHS: Readonly<Record<string, string>> = {
  'music:calm': '/sounds/music/calm.ogg',
  'ambience:rain': '/sounds/ambience/rain.ogg',
  'effect:door': '/sounds/effects/door.ogg',
};

class FakePlayer implements PlayerProcess {
  killed = false;
  private closers: ((code: number | null) => void)[] = [];
  on(event: 'close' | 'error', listener: never): this {
    if (event === 'close') this.closers.push(listener);
    return this;
  }
  kill(): boolean {
    this.killed = true;
    for (const close of this.closers) close(null);
    return true;
  }
  finish(): void {
    for (const close of this.closers) close(0);
  }
}

const harness = (platform: NodeJS.Platform = 'darwin') => {
  const spawned: { command: string; args: readonly string[]; player: FakePlayer }[] = [];
  const sink = createLoopSink({
    platform,
    resolve: (id) => PATHS[id],
    spawn: (command, args) => {
      const player = new FakePlayer();
      spawned.push({ command, args, player });
      return player;
    },
  });
  return { sink, spawned };
};

test('starts the player with the resolved file and volume', () => {
  const { sink, spawned } = harness();
  sink.setVolume('music:calm', 0.5);
  sink.start('music:calm');
  assert.equal(spawned[0]?.command, '/usr/bin/afplay');
  assert.deepEqual(spawned[0]?.args, ['-v', '0.5', '/sounds/music/calm.ogg']);
});

test('loops by starting the player again the moment it ends', () => {
  const { sink, spawned } = harness();
  sink.start('ambience:rain');
  spawned[0]?.player.finish();
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1]?.args.at(-1), '/sounds/ambience/rain.ogg');
});

test('stop kills the player and ends the loop', () => {
  const { sink, spawned } = harness();
  sink.start('ambience:rain');
  sink.stop('ambience:rain');
  assert.equal(spawned[0]?.player.killed, true);
  assert.equal(spawned.length, 1);
});

test('one-shot effects play once', () => {
  const { sink, spawned } = harness();
  sink.start('effect:door');
  spawned[0]?.player.finish();
  assert.equal(spawned.length, 1);
});

test('a volume change smaller than the step does not restart the player', () => {
  const { sink, spawned } = harness();
  sink.setVolume('music:calm', 0.5);
  sink.start('music:calm');
  sink.setVolume('music:calm', 0.5 + VOLUME_RESTART_STEP / 2);
  assert.equal(spawned.length, 1);
});

test('a larger volume change restarts the player at the new volume', () => {
  const { sink, spawned } = harness();
  sink.setVolume('music:calm', 0.5);
  sink.start('music:calm');
  sink.setVolume('music:calm', 0.5 + VOLUME_RESTART_STEP * 2);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0]?.player.killed, true);
  assert.equal(spawned[1]?.args[1], String(0.5 + VOLUME_RESTART_STEP * 2));
});

test('a zero volume keeps the player silent without stopping the loop', () => {
  const { sink, spawned } = harness();
  sink.setVolume('music:calm', 0.5);
  sink.start('music:calm');
  sink.setVolume('music:calm', 0);
  assert.equal(spawned.at(-1)?.args[1], '0');
});

test('layers without a downloaded file start nothing', () => {
  const { sink, spawned } = harness();
  sink.start('music:unknown');
  assert.equal(spawned.length, 0);
});

test('dispose kills every running player', () => {
  const { sink, spawned } = harness();
  sink.start('ambience:rain');
  sink.start('music:calm');
  sink.dispose();
  assert.deepEqual(
    spawned.map(({ player }) => player.killed),
    [true, true],
  );
});

test('a platform without a player throws a clear message on start', () => {
  const { sink } = harness('win32');
  assert.throws(() => sink.start('music:calm'), new RegExp(NO_PLAYER_MESSAGE_LOOP));
});
