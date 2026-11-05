import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AmbienceState,
  type AmbientSink,
  createAmbienceMixer,
  DEFAULT_CHANNEL_VOLUME,
  DUCK_FACTOR,
  MAX_CHANNEL_VOLUME,
  MIN_CHANNEL_VOLUME,
} from './ambience.ts';
import type { PlaybackEvent } from './playback.ts';

const RAIN = 'rain';
const TAVERN = 'tavern';
const DOOR = 'door-creak';
const HALF = 0.5;
const QUIET_NARRATION = 0.1;

type SinkCall = readonly ['start' | 'stop', string] | readonly ['volume', string, number];

const harness = () => {
  const calls: SinkCall[] = [];
  const states: AmbienceState[] = [];
  const sink: AmbientSink = {
    start: (layerId) => void calls.push(['start', layerId]),
    stop: (layerId) => void calls.push(['stop', layerId]),
    setVolume: (layerId, volume) => void calls.push(['volume', layerId, volume]),
  };
  const mixer = createAmbienceMixer({ sink, onChange: (state) => states.push(state) });
  const lastVolume = (layerId: string): number | undefined =>
    calls.findLast((call) => call[0] === 'volume' && call[1] === layerId)?.[2];
  return { calls, states, mixer, lastVolume };
};

const subtitle = (state: 'start' | 'end'): PlaybackEvent => ({
  kind: 'subtitle',
  utteranceEventId: 'ev-1',
  speakerId: 'gm',
  text: 'line',
  state,
});

test('ambience and effects are off by default and start nothing without a user selection', () => {
  const { calls, mixer } = harness();
  mixer.onPlaybackEvent(subtitle('start'));
  mixer.onPlaybackEvent(subtitle('end'));
  mixer.effect(DOOR);
  assert.deepEqual(calls, []);
  assert.deepEqual(mixer.state().active, []);
});

test('selecting an ambience layer is the opt-in that starts it at the channel volume', () => {
  const { calls, mixer, lastVolume } = harness();
  mixer.selectAmbience(RAIN);
  assert.deepEqual(calls.at(-1), ['start', RAIN]);
  assert.equal(lastVolume(RAIN), DEFAULT_CHANNEL_VOLUME);
  assert.deepEqual(mixer.state().active, [RAIN]);
  mixer.deselectAmbience(RAIN);
  assert.deepEqual(calls.at(-1), ['stop', RAIN]);
  assert.deepEqual(mixer.state().active, []);
});

test('effects play only after the user enables them', () => {
  const { calls, mixer } = harness();
  mixer.effect(DOOR);
  assert.deepEqual(calls, []);
  mixer.enableEffects(true);
  mixer.effect(DOOR);
  assert.deepEqual(calls.at(-1), ['start', DOOR]);
  mixer.enableEffects(false);
  assert.deepEqual(calls.at(-1), ['stop', DOOR]);
});

test('per-channel volume applies to active layers of that channel only', () => {
  const { mixer, lastVolume } = harness();
  mixer.selectAmbience(RAIN);
  mixer.enableEffects(true);
  mixer.effect(DOOR);
  mixer.setVolume('ambience', HALF);
  assert.equal(lastVolume(RAIN), HALF);
  assert.equal(lastVolume(DOOR), DEFAULT_CHANNEL_VOLUME);
  mixer.setVolume('dialogue', HALF);
  assert.equal(mixer.volume('dialogue'), HALF);
  assert.equal(mixer.volume('narration'), DEFAULT_CHANNEL_VOLUME);
});

test('invalid volumes are rejected with RangeError', () => {
  const { mixer } = harness();
  for (const bad of [MIN_CHANNEL_VOLUME - 1, MAX_CHANNEL_VOLUME + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => mixer.setVolume('ambience', bad), RangeError);
  }
  assert.equal(mixer.volume('ambience'), DEFAULT_CHANNEL_VOLUME);
});

test('speech ducks ambience and effects, then restores them on end', () => {
  const { mixer, lastVolume, states } = harness();
  mixer.selectAmbience(RAIN);
  mixer.enableEffects(true);
  mixer.effect(DOOR);
  mixer.onPlaybackEvent(subtitle('start'));
  assert.equal(lastVolume(RAIN), DEFAULT_CHANNEL_VOLUME * DUCK_FACTOR);
  assert.equal(lastVolume(DOOR), DEFAULT_CHANNEL_VOLUME * DUCK_FACTOR);
  assert.equal(states.at(-1)?.ducked, true);
  mixer.onPlaybackEvent(subtitle('end'));
  assert.equal(lastVolume(RAIN), DEFAULT_CHANNEL_VOLUME);
  assert.equal(states.at(-1)?.ducked, false);
});

test('ducking restores after interruption and text-only fallback', () => {
  const { mixer, lastVolume } = harness();
  mixer.selectAmbience(RAIN);
  mixer.onPlaybackEvent(subtitle('start'));
  mixer.onPlaybackEvent({ kind: 'interrupted', utteranceEventId: 'ev-1', dropped: 0 });
  assert.equal(lastVolume(RAIN), DEFAULT_CHANNEL_VOLUME);
  mixer.onPlaybackEvent(subtitle('start'));
  mixer.onPlaybackEvent({
    kind: 'subtitle',
    utteranceEventId: 'ev-2',
    speakerId: 'gm',
    text: 'line',
    state: 'text-only',
    reason: 'voice-off',
  });
  assert.equal(lastVolume(RAIN), DEFAULT_CHANNEL_VOLUME);
});

test('ducking never leaves ambience louder than quiet narration', () => {
  const { mixer, lastVolume } = harness();
  mixer.setVolume('narration', QUIET_NARRATION);
  mixer.selectAmbience(RAIN);
  mixer.onPlaybackEvent(subtitle('start'));
  const ducked = lastVolume(RAIN) ?? MAX_CHANNEL_VOLUME;
  assert.ok(ducked < QUIET_NARRATION);
  mixer.setVolume('ambience', MAX_CHANNEL_VOLUME);
  assert.ok((lastVolume(RAIN) ?? MAX_CHANNEL_VOLUME) < QUIET_NARRATION);
});

test('silence mode stops all background layers immediately and keeps speech volumes', () => {
  const { calls, mixer, states } = harness();
  mixer.selectAmbience(RAIN);
  mixer.selectAmbience(TAVERN);
  mixer.enableEffects(true);
  mixer.effect(DOOR);
  mixer.setSilence(true);
  const stopped = calls.filter((call) => call[0] === 'stop').map((call) => call[1]);
  assert.deepEqual(stopped.sort(), [DOOR, RAIN, TAVERN].sort());
  assert.deepEqual(mixer.state().active, []);
  assert.equal(states.at(-1)?.silenced, true);
  assert.equal(mixer.volume('narration'), DEFAULT_CHANNEL_VOLUME);
  assert.equal(mixer.volume('dialogue'), DEFAULT_CHANNEL_VOLUME);
});

test('silence mode blocks new layers and does not auto-restart them when lifted', () => {
  const { calls, mixer } = harness();
  mixer.selectAmbience(RAIN);
  mixer.enableEffects(true);
  mixer.setSilence(true);
  const before = calls.length;
  mixer.selectAmbience(TAVERN);
  mixer.effect(DOOR);
  mixer.setSilence(false);
  mixer.effect(DOOR);
  assert.deepEqual(calls.slice(before), []);
  assert.deepEqual(mixer.state().active, []);
});

test('music is its own channel with its own volume and ducks under speech', () => {
  const { mixer, lastVolume } = harness();
  mixer.setVolume('music', HALF);
  mixer.selectMusic('calm');
  assert.equal(lastVolume('calm'), HALF);
  mixer.onPlaybackEvent(subtitle('start'));
  assert.equal(lastVolume('calm'), HALF * DUCK_FACTOR);
  assert.equal(mixer.volume('ambience'), DEFAULT_CHANNEL_VOLUME);
});

test('silence mode stops music', () => {
  const { mixer, calls } = harness();
  mixer.selectMusic('calm');
  mixer.setSilence(true);
  assert.deepEqual(calls.at(-1), ['stop', 'calm']);
  mixer.selectMusic('combat');
  assert.deepEqual(mixer.state().active, []);
});
