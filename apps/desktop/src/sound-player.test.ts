import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DUCK_FACTOR } from '../../../packages/voice/src/ambience.ts';
import { CROSSFADE_MS, FADE_TICK_MS, type SoundClock } from '../../../packages/voice/src/sound-controller.ts';
import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from '../../../packages/voice/src/sound-settings.ts';
import {
  createDesktopSound,
  createWebAudioSink,
  type SoundAudioContext,
  type SoundBridge,
  sceneSoundInput,
} from './sound-player.ts';

const VOLUME = 0.5;
const TOLERANCE = 1e-9;
const MUSIC_ON: SoundSettings = { ...DEFAULT_SOUND_SETTINGS, music: { enabled: true, volume: VOLUME } };
const AMBIENCE_ON: SoundSettings = { ...MUSIC_ON, ambience: { enabled: true, volume: VOLUME } };
const TAVERN = { location: 'tavern', mood: [] };
const QUIET_SCENE = { location: '', mood: [] };
const COMBAT = { location: '', mood: ['combat'] };

type FakeGain = {
  gain: { value: number };
  connected: unknown;
  disconnected: boolean;
  connect(target: unknown): void;
  disconnect(): void;
};
type FakeSource = {
  buffer: unknown;
  loop: boolean;
  gain: FakeGain | undefined;
  started: boolean;
  stopped: boolean;
  connect(target: FakeGain): void;
  start(): void;
  stop(): void;
  disconnect(): void;
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const fakeContext = () => {
  const gains: FakeGain[] = [];
  const sources: FakeSource[] = [];
  const state = { resumed: 0, closed: 0, created: 0 };
  const context: SoundAudioContext = {
    destination: 'speakers',
    resume: async () => {
      state.resumed += 1;
    },
    close: async () => {
      state.closed += 1;
    },
    decodeAudioData: async (data) => new TextDecoder().decode(data),
    createGain: () => {
      const gain: FakeGain = {
        gain: { value: 1 },
        connected: undefined,
        disconnected: false,
        connect: (target) => {
          gain.connected = target;
        },
        disconnect: () => {
          gain.disconnected = true;
        },
      };
      gains.push(gain);
      return gain;
    },
    createBufferSource: () => {
      const source: FakeSource = {
        buffer: undefined,
        loop: false,
        gain: undefined,
        started: false,
        stopped: false,
        connect: (target) => {
          source.gain = target;
        },
        start: () => {
          source.started = true;
        },
        stop: () => {
          source.stopped = true;
        },
        disconnect: () => {},
      };
      sources.push(source);
      return source;
    },
  };
  return {
    state,
    gains,
    sources,
    make: () => {
      state.created += 1;
      return context;
    },
    playing: (label: string) => sources.find(({ buffer, stopped }) => buffer === label && !stopped),
    volumeOf: (label: string) => sources.findLast(({ buffer }) => buffer === label)?.gain?.gain.value,
  };
};

const fakeClock = () => {
  let now = 0;
  const timers = new Set<() => void>();
  const clock: SoundClock = {
    now: () => now,
    every: (fn) => {
      timers.add(fn);
      return () => timers.delete(fn);
    },
  };
  return {
    clock,
    timers,
    advance: (total: number) => {
      for (let elapsed = 0; elapsed < total; elapsed += FADE_TICK_MS) {
        now += FADE_TICK_MS;
        for (const tick of [...timers]) tick();
      }
    },
  };
};

const bytesOf = (label: string) => new TextEncoder().encode(label);

const fakeBridge = (installed = true, missing: readonly string[] = []) => {
  const requested: string[] = [];
  const bridge: Pick<SoundBridge, 'status' | 'file'> = {
    status: async () => ({ installed, bytes: 0, offer: { source: '', bytes: 0, sizeMiB: 0 } }),
    file: async (kind, key) => {
      const label = `${kind}:${key}`;
      requested.push(label);
      return missing.includes(label) ? undefined : bytesOf(label);
    },
  };
  return { bridge, requested };
};

const near = (actual: number | undefined, expected: number) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < TOLERANCE, `${actual} is not ${expected}`);

const sinkSetup = (
  load = async (kind: string, key: string): Promise<Uint8Array | undefined> => bytesOf(`${kind}:${key}`),
) => {
  const audio = fakeContext();
  const sink = createWebAudioSink({ context: audio.make, load });
  return { audio, sink };
};

test('rpg-cm63.33 the sink loops a loaded layer through its own gain node at the set volume', async () => {
  const { audio, sink } = sinkSetup();
  sink.setVolume('music:calm', 0.25);
  sink.start('music:calm');
  await flush();
  const source = audio.playing('music:calm');
  assert.ok(source?.started && source.loop);
  assert.equal(source.gain?.connected, 'speakers');
  near(audio.volumeOf('music:calm'), 0.25);
  sink.setVolume('music:calm', 0.75);
  near(audio.volumeOf('music:calm'), 0.75);
  assert.equal(audio.state.resumed, 1);
});

test('rpg-cm63.33 an effect plays once and a stopped layer is released', async () => {
  const { audio, sink } = sinkSetup();
  sink.start('effect:bell');
  sink.start('music:calm');
  await flush();
  assert.equal(audio.playing('effect:bell')?.loop, false);
  sink.stop('music:calm');
  assert.equal(audio.sources.find(({ buffer }) => buffer === 'music:calm')?.stopped, true);
  assert.equal(audio.gains[1]?.disconnected, true);
});

test('rpg-cm63.33 a layer stopped before it finished loading never plays', async () => {
  const { audio, sink } = sinkSetup();
  sink.start('music:calm');
  sink.stop('music:calm');
  await flush();
  assert.equal(audio.sources.length, 0);
});

test('rpg-cm63.33 sink failures stay silent', async () => {
  const missing = sinkSetup(async () => undefined);
  missing.sink.start('music:calm');
  const broken = sinkSetup(async () => {
    throw new Error('ipc failed');
  });
  broken.sink.start('music:calm');
  const noAudio = createWebAudioSink({
    context: () => {
      throw new Error('no audio device');
    },
    load: async () => bytesOf('x'),
  });
  noAudio.start('music:calm');
  await flush();
  assert.equal(missing.audio.sources.length + broken.audio.sources.length, 0);
});

test('rpg-cm63.33 disposing the sink stops every layer and closes the context', async () => {
  const { audio, sink } = sinkSetup();
  sink.start('music:calm');
  await flush();
  sink.dispose();
  assert.equal(audio.sources[0]?.stopped, true);
  assert.equal(audio.state.closed, 1);
});

const soundSetup = (installed = true, missing: readonly string[] = []) => {
  const audio = fakeContext();
  const time = fakeClock();
  const { bridge, requested } = fakeBridge(installed, missing);
  const sound = createDesktopSound({ bridge, context: audio.make, clock: time.clock });
  return { audio, time, sound, requested };
};

test('rpg-cm63.33 nothing is loaded and no audio context exists while every channel is off', async () => {
  const { audio, sound, requested } = soundSetup();
  sound.update(DEFAULT_SOUND_SETTINGS, TAVERN);
  await flush();
  assert.deepEqual(requested, []);
  assert.equal(audio.state.created, 0);
});

test('rpg-cm63.33 an enabled channel fades the scene sound in to its volume', async () => {
  const { audio, time, sound, requested } = soundSetup();
  sound.update(AMBIENCE_ON, TAVERN);
  await flush();
  assert.deepEqual(requested.sort(), ['ambience:tavern', 'music:calm']);
  near(audio.volumeOf('music:calm'), 0);
  time.advance(CROSSFADE_MS / 2);
  near(audio.volumeOf('music:calm'), VOLUME / 2);
  time.advance(CROSSFADE_MS / 2);
  near(audio.volumeOf('music:calm'), VOLUME);
  near(audio.volumeOf('ambience:tavern'), VOLUME);
});

test('rpg-cm63.33 a scene change crossfades the old track out while the new one fades in', async () => {
  const { audio, time, sound } = soundSetup();
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  sound.update(MUSIC_ON, COMBAT);
  await flush();
  time.advance(CROSSFADE_MS / 2);
  near(audio.volumeOf('music:calm'), VOLUME / 2);
  near(audio.volumeOf('music:combat'), VOLUME / 2);
  assert.ok(audio.playing('music:calm'));
  time.advance(CROSSFADE_MS / 2);
  assert.equal(audio.playing('music:calm'), undefined);
  near(audio.volumeOf('music:combat'), VOLUME);
});

test('rpg-cm63.33 speech ducks the background and releases it afterwards', async () => {
  const { audio, time, sound } = soundSetup();
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  sound.speaking(true);
  near(audio.volumeOf('music:calm'), VOLUME * DUCK_FACTOR);
  sound.speaking(false);
  near(audio.volumeOf('music:calm'), VOLUME);
});

test('rpg-cm63.33 speech already playing ducks sound that starts later', async () => {
  const { audio, time, sound } = soundSetup();
  sound.speaking(true);
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  near(audio.volumeOf('music:calm'), VOLUME * DUCK_FACTOR);
});

test('rpg-cm63.33 turning every channel off stops playback and drops the audio context', async () => {
  const { audio, time, sound } = soundSetup();
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  sound.update(DEFAULT_SOUND_SETTINGS, QUIET_SCENE);
  assert.equal(audio.playing('music:calm'), undefined);
  assert.equal(audio.state.closed, 1);
  assert.equal(time.timers.size, 0);
});

test('rpg-cm63.33 leaving the game silences playback and returning brings it back', async () => {
  const { audio, time, sound } = soundSetup();
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  sound.update(MUSIC_ON, undefined);
  assert.equal(audio.playing('music:calm'), undefined);
  sound.update(MUSIC_ON, COMBAT);
  await flush();
  time.advance(CROSSFADE_MS);
  near(audio.volumeOf('music:combat'), VOLUME);
});

test('rpg-cm63.33 a volume change applies without restarting the track', async () => {
  const { audio, time, sound, requested } = soundSetup();
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  sound.update({ ...MUSIC_ON, music: { enabled: true, volume: 1 } }, QUIET_SCENE);
  near(audio.volumeOf('music:calm'), 1);
  assert.deepEqual(requested, ['music:calm']);
});

test('rpg-cm63.33 without downloaded sounds nothing plays and nothing fails', async () => {
  const { audio, sound, requested } = soundSetup(false);
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  assert.deepEqual(requested, []);
  assert.equal(audio.sources.length, 0);
});

test('rpg-cm63.33 a failing status check keeps the game quiet', async () => {
  const audio = fakeContext();
  const time = fakeClock();
  const bridge: Pick<SoundBridge, 'status' | 'file'> = {
    status: async () => {
      throw new Error('ipc failed');
    },
    file: async () => undefined,
  };
  const sound = createDesktopSound({ bridge, context: audio.make, clock: time.clock });
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  assert.equal(audio.sources.length, 0);
});

test('rpg-cm63.33 scene titles map to sound locations and moods', () => {
  assert.deepEqual(sceneSoundInput('The Rusty Tavern'), { location: 'tavern', mood: ['the', 'rusty', 'tavern'] });
  assert.deepEqual(sceneSoundInput('Combat at the Harbour'), {
    location: 'harbour',
    mood: ['combat', 'at', 'the', 'harbour'],
  });
  assert.deepEqual(sceneSoundInput(undefined), { location: '', mood: [] });
});

test('rpg-cm63.33 disposing stops the sound', async () => {
  const { audio, time, sound } = soundSetup();
  sound.update(MUSIC_ON, QUIET_SCENE);
  await flush();
  time.advance(CROSSFADE_MS);
  sound.dispose();
  assert.equal(audio.playing('music:calm'), undefined);
});
