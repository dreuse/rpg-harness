import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoopSink, ffprobePathFor, NO_PLAYER_MESSAGE_LOOP, VOLUME_RESTART_STEP } from './loop-sink.ts';
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

const FFPLAY = '/opt/homebrew/bin/ffplay';
const TRACK_SECONDS = 100;

const harness = (platform: NodeJS.Platform = 'darwin', ffplay?: string) => {
  const spawned: { command: string; args: readonly string[]; player: FakePlayer }[] = [];
  const clock = { now: 0 };
  const probes = { count: 0 };
  const sink = createLoopSink({
    platform,
    resolve: (id) => PATHS[id],
    findFfplay: () => ffplay,
    durationOf: () => {
      probes.count += 1;
      return TRACK_SECONDS;
    },
    now: () => clock.now,
    spawn: (command, args) => {
      const player = new FakePlayer();
      spawned.push({ command, args, player });
      return player;
    },
  });
  return { sink, spawned, clock, probes };
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

test('ffplay loops gaplessly and plays ogg on macOS', () => {
  const { sink, spawned } = harness('darwin', FFPLAY);
  sink.setVolume('music:calm', 0.5);
  sink.start('music:calm');
  assert.equal(spawned[0]?.command, FFPLAY);
  assert.deepEqual(spawned[0]?.args, [
    '-nodisp',
    '-autoexit',
    '-loglevel',
    'quiet',
    '-volume',
    '50',
    '-loop',
    '0',
    '/sounds/music/calm.ogg',
  ]);
});

test('ffplay one-shot effects do not loop', () => {
  const { sink, spawned } = harness('darwin', FFPLAY);
  sink.start('effect:door');
  assert.equal(spawned[0]?.args.includes('-loop'), false);
  spawned[0]?.player.finish();
  assert.equal(spawned.length, 1);
});

test('a volume change resumes ffplay at the elapsed offset', () => {
  const { sink, spawned, clock } = harness('darwin', FFPLAY);
  sink.start('music:calm');
  clock.now = 30_000;
  sink.setVolume('music:calm', 0.5);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0]?.player.killed, true);
  const args = spawned[1]?.args ?? [];
  assert.equal(args[args.indexOf('-ss') + 1], '30.000');
  assert.equal(args[args.indexOf('-volume') + 1], '50');
  assert.equal(args.includes('-loop'), false);
});

test('the resume offset wraps at the track duration', () => {
  const { sink, spawned, clock } = harness('darwin', FFPLAY);
  sink.start('music:calm');
  clock.now = 230_000;
  sink.setVolume('music:calm', 0.5);
  const args = spawned[1]?.args ?? [];
  assert.equal(args[args.indexOf('-ss') + 1], '30.000');
});

test('a resumed segment loops again from the start when it ends', () => {
  const { sink, spawned, clock } = harness('darwin', FFPLAY);
  sink.start('music:calm');
  clock.now = 30_000;
  sink.setVolume('music:calm', 0.5);
  spawned[1]?.player.finish();
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2]?.args.includes('-ss'), false);
  assert.equal(spawned[2]?.args.includes('-loop'), true);
});

test('ffplay makes a platform without a default player work', () => {
  const { sink, spawned } = harness('win32', FFPLAY);
  sink.start('music:calm');
  assert.equal(spawned[0]?.command, FFPLAY);
});

test('dispose kills one-shot effects that are still playing', () => {
  const { sink, spawned } = harness();
  sink.start('effect:door');
  sink.dispose();
  assert.equal(spawned[0]?.player.killed, true);
});

const seekOf = (args: readonly string[] | undefined): number => Number(args?.[(args?.indexOf('-ss') ?? -2) + 1]);

test('crossfade respawns keep a growing sub-second offset', () => {
  const { sink, spawned, clock } = harness('darwin', FFPLAY);
  sink.start('music:calm');
  const offsets: number[] = [];
  for (let step = 1; step <= 4; step += 1) {
    clock.now = step * 200;
    sink.setVolume('music:calm', 1 - step * 0.2);
    offsets.push(seekOf(spawned.at(-1)?.args));
  }
  assert.deepEqual(offsets, [0.2, 0.4, 0.6, 0.8]);
  assert.equal(spawned.at(-1)?.args.includes('-loop'), false);
});

test('a sub-millisecond offset still resumes instead of looping from zero', () => {
  const { sink, spawned, clock } = harness('darwin', FFPLAY);
  sink.start('music:calm');
  clock.now = 400;
  sink.setVolume('music:calm', 0.5);
  assert.equal(spawned[1]?.args.includes('-loop'), false);
  assert.equal(spawned[1]?.args[spawned[1].args.indexOf('-ss') + 1], '0.400');
});

test('a finished effect is not replayed by a later volume change', () => {
  const { sink, spawned } = harness('darwin', FFPLAY);
  sink.start('effect:door');
  spawned[0]?.player.finish();
  sink.setVolume('effect:door', 0.2);
  assert.equal(spawned.length, 1);
});

test('starting the same effect twice stops the first player', () => {
  const { sink, spawned } = harness('darwin', FFPLAY);
  sink.start('effect:door');
  sink.start('effect:door');
  assert.equal(spawned[0]?.player.killed, true);
  sink.dispose();
  assert.equal(spawned[1]?.player.killed, true);
});

test('the sink kills its players when the process exits', () => {
  const before = process.listenerCount('exit');
  const { sink, spawned } = harness();
  sink.start('ambience:rain');
  assert.equal(process.listenerCount('exit'), before + 1);
  process.emit('exit', 0);
  assert.equal(spawned[0]?.player.killed, true);
  assert.ok(process.listenerCount('exit') <= before);
});

test('dispose removes the exit listener', () => {
  const before = process.listenerCount('exit');
  const { sink } = harness();
  sink.dispose();
  assert.equal(process.listenerCount('exit'), before);
});

test('the duration is probed once at start, not during volume changes', () => {
  const { sink, probes, clock } = harness('darwin', FFPLAY);
  sink.start('music:calm');
  assert.equal(probes.count, 1);
  clock.now = 100;
  sink.setVolume('music:calm', 0.5);
  sink.setVolume('music:calm', 0.2);
  assert.equal(probes.count, 1);
});

test('the ffprobe path sits next to ffplay with the same extension', () => {
  assert.equal(ffprobePathFor('/opt/homebrew/bin/ffplay'), '/opt/homebrew/bin/ffprobe');
  assert.equal(ffprobePathFor('C:/ff/ffplay.exe'), 'C:/ff/ffprobe.exe');
});
