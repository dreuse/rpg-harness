import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { AmbientSink } from '../../../packages/voice/src/ambience.ts';
import type { SoundClock } from '../../../packages/voice/src/sound-controller.ts';
import { DEFAULT_SOUND_SETTINGS } from '../../../packages/voice/src/sound-settings.ts';
import { createSoundRuntime, DEFAULT_SCENE } from './sound-runtime.ts';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-runtime-'));
  dirs.push(dir);
  return dir;
};
const ON = { ...DEFAULT_SOUND_SETTINGS, music: { enabled: true, volume: 0.5 } };
const clock: SoundClock = { now: () => 0, every: () => () => undefined };

const fakeSink = () => {
  const started: string[] = [];
  let disposed = false;
  const sink: AmbientSink & { dispose(): void } = {
    start: (id) => void started.push(id),
    stop: () => undefined,
    setVolume: () => undefined,
    dispose: () => {
      disposed = true;
    },
  };
  return { sink, started, disposed: () => disposed };
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('returns nothing when every channel is off', async () => {
  const { sink } = fakeSink();
  assert.equal(createSoundRuntime(await tempDir(), { settings: DEFAULT_SOUND_SETTINGS, sink, clock }), undefined);
});

test('an enabled channel without downloaded sounds plays nothing', async () => {
  const { sink, started } = fakeSink();
  const runtime = createSoundRuntime(await tempDir(), { settings: ON, sink, clock });
  assert.notEqual(runtime, undefined);
  assert.deepEqual(started, []);
});

test('plays the music bed for the default scene when the sound is installed', async () => {
  const { sink, started } = fakeSink();
  createSoundRuntime(await tempDir(), { settings: ON, sink, clock, installed: () => true });
  assert.deepEqual(started, ['music:calm']);
  assert.deepEqual(DEFAULT_SCENE.mood, []);
});

test('dispose stops the sink', async () => {
  const { sink, disposed } = fakeSink();
  createSoundRuntime(await tempDir(), { settings: ON, sink, clock, installed: () => true })?.dispose();
  assert.equal(disposed(), true);
});

test('rpg-cm63.34 the opening scene picks the ambience and rings the scene effect', async () => {
  const { sink, started } = fakeSink();
  const settings = {
    ...ON,
    ambience: { enabled: true, volume: 0.5 },
    effects: { enabled: true, volume: 0.5 },
  };
  createSoundRuntime(await tempDir(), {
    settings,
    sink,
    clock,
    installed: () => true,
    scene: { location: 'tavern', mood: [] },
  });
  assert.deepEqual(started.sort(), ['ambience:tavern', 'effect:bell', 'music:calm']);
});
