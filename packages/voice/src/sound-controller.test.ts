import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DUCK_FACTOR } from './ambience.ts';
import {
  CROSSFADE_MS,
  createSoundController,
  FADE_TICK_MS,
  type SoundClock,
  type SoundControllerDeps,
  systemClock,
} from './sound-controller.ts';
import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from './sound-settings.ts';

const ALL_ON: SoundSettings = {
  ambience: { enabled: true, volume: 1 },
  effects: { enabled: true, volume: 1 },
  music: { enabled: true, volume: 1 },
};
const TAVERN = { location: 'tavern', mood: [] as string[] };
const FOREST_TENSE = { location: 'forest', mood: ['tense'] };
const HALF = 0.5;
const HALF_FADE = CROSSFADE_MS / 2;

type Call = readonly ['start' | 'stop', string] | readonly ['volume', string, number];

const harness = (overrides: Partial<SoundControllerDeps> = {}) => {
  const calls: Call[] = [];
  let now = 0;
  let tick: (() => void) | undefined;
  let cancelled = 0;
  const clock: SoundClock = {
    now: () => now,
    every: (fn, ms) => {
      assert.equal(ms, FADE_TICK_MS);
      tick = fn;
      return () => {
        tick = undefined;
        cancelled += 1;
      };
    },
  };
  const controller = createSoundController({
    sink: {
      start: (id) => void calls.push(['start', id]),
      stop: (id) => void calls.push(['stop', id]),
      setVolume: (id, volume) => void calls.push(['volume', id, volume]),
    },
    clock,
    ...overrides,
  });
  const advance = (ms: number) => {
    now += ms;
    tick?.();
  };
  const volumeOf = (id: string) => calls.findLast((call) => call[0] === 'volume' && call[1] === id)?.[2];
  const started = () => calls.filter((call) => call[0] === 'start').map((call) => call[1]);
  return {
    controller,
    calls,
    advance,
    volumeOf,
    started,
    cancelled: () => cancelled,
    ticking: () => tick !== undefined,
  };
};

test('nothing plays unless a channel is enabled', () => {
  const { controller, calls } = harness();
  controller.setScene(TAVERN);
  controller.effect('door');
  controller.speaking(true);
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.state().layers, []);
});

test('enabling a channel starts the layer for the current scene and fades it in', () => {
  const { controller, started, volumeOf, advance } = harness();
  controller.setScene(TAVERN);
  controller.apply({ ...DEFAULT_SOUND_SETTINGS, ambience: { enabled: true, volume: HALF } });
  assert.deepEqual(started(), ['ambience:tavern']);
  assert.equal(volumeOf('ambience:tavern'), 0);
  advance(CROSSFADE_MS);
  assert.equal(volumeOf('ambience:tavern'), HALF);
});

test('music has its own channel and volume', () => {
  const { controller, started, volumeOf, advance } = harness();
  controller.apply({ ...DEFAULT_SOUND_SETTINGS, music: { enabled: true, volume: 0.25 } });
  controller.setScene(TAVERN);
  advance(CROSSFADE_MS);
  assert.deepEqual(started(), ['music:calm']);
  assert.equal(volumeOf('music:calm'), 0.25);
});

test('a scene change crossfades the old layer out while the new one fades in', () => {
  const { controller, started, volumeOf, advance, calls } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  advance(CROSSFADE_MS);
  calls.length = 0;
  controller.setScene(FOREST_TENSE);
  assert.deepEqual(started(), ['ambience:tension', 'music:tension']);
  advance(HALF_FADE);
  assert.equal(volumeOf('ambience:tavern'), HALF);
  assert.equal(volumeOf('ambience:tension'), HALF);
  assert.equal(
    calls.some((call) => call[0] === 'stop'),
    false,
  );
  advance(HALF_FADE);
  assert.equal(volumeOf('ambience:tavern'), 0);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'stop').map((call) => call[1]),
    ['ambience:tavern', 'music:calm'],
  );
  assert.equal(volumeOf('ambience:tension'), 1);
});

test('the fade timer stops once every fade is finished', () => {
  const { controller, advance, ticking, cancelled } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  assert.equal(ticking(), true);
  advance(CROSSFADE_MS);
  assert.equal(ticking(), false);
  assert.equal(cancelled(), 1);
});

test('an unchanged scene does not restart layers', () => {
  const { controller, started, advance } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  advance(CROSSFADE_MS);
  controller.setScene({ location: 'inn', mood: [] });
  assert.deepEqual(started(), ['ambience:tavern', 'music:calm']);
});

test('narration and NPC speech duck every layer and restore afterwards', () => {
  const { controller, volumeOf, advance } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  advance(CROSSFADE_MS);
  controller.speaking(true);
  assert.equal(volumeOf('ambience:tavern'), DUCK_FACTOR);
  assert.equal(volumeOf('music:calm'), DUCK_FACTOR);
  controller.speaking(false);
  assert.equal(volumeOf('ambience:tavern'), 1);
});

test('ducking applies on top of a fade in progress', () => {
  const { controller, volumeOf, advance } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  advance(HALF_FADE);
  controller.speaking(true);
  assert.equal(volumeOf('ambience:tavern'), HALF * DUCK_FACTOR);
});

test('silence stops everything at once and stays silent until lifted', () => {
  const { controller, calls, started } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  controller.setSilence(true);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'stop').map((call) => call[1]),
    ['ambience:tavern', 'music:calm'],
  );
  controller.setScene(FOREST_TENSE);
  assert.equal(started().length, 2);
  controller.setSilence(false);
  assert.deepEqual(started().slice(2), ['ambience:tension', 'music:tension']);
});

test('disabling a channel fades its layer out and stops it', () => {
  const { controller, calls, advance } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  advance(CROSSFADE_MS);
  controller.apply({ ...ALL_ON, music: { enabled: false, volume: 1 } });
  advance(CROSSFADE_MS);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'stop').map((call) => call[1]),
    ['music:calm'],
  );
});

test('layers whose sound is not downloaded are skipped', () => {
  const { controller, started } = harness({ available: (kind, key) => !(kind === 'music' && key === 'calm') });
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  assert.deepEqual(started(), ['ambience:tavern']);
});

test('effects play only when the effects channel is enabled', () => {
  const { controller, started } = harness();
  controller.effect('door');
  controller.apply(ALL_ON);
  controller.effect('door');
  assert.deepEqual(started(), ['effect:door']);
});

test('a genre extension changes the selection', () => {
  const { controller, started } = harness({ table: { locations: { tavern: 'city' } } });
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  assert.deepEqual(started(), ['ambience:city', 'music:calm']);
});

test('dispose stops all layers and the timer', () => {
  const { controller, calls, ticking } = harness();
  controller.apply(ALL_ON);
  controller.setScene(TAVERN);
  controller.dispose();
  assert.equal(calls.filter((call) => call[0] === 'stop').length, 2);
  assert.equal(ticking(), false);
});

test('the system clock ticks until cancelled', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const ticks: number[] = [];
    const cancel = systemClock.every(() => ticks.push(ticks.length), FADE_TICK_MS);
    mock.timers.tick(FADE_TICK_MS * 2);
    assert.equal(ticks.length, 2);
    assert.equal(systemClock.now(), FADE_TICK_MS * 2);
    cancel();
    mock.timers.tick(FADE_TICK_MS);
    assert.equal(ticks.length, 2);
  } finally {
    mock.timers.reset();
  }
});
