import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { DUCK_RELEASE_MS, duckingSink } from './ducking-sink.ts';
import type { PlaybackSink } from './playback.ts';
import type { SpeechChunk } from './tts.ts';

const CHUNK = { audio: new Uint8Array(), mimeType: 'audio/wav' } as unknown as SpeechChunk;
const SIGNAL = new AbortController().signal;

const harness = (playing: () => Promise<void> = async () => {}) => {
  const events: boolean[] = [];
  const inner: PlaybackSink = { play: playing, pause: () => events.push(false), resume: () => events.push(true) };
  return { events, sink: duckingSink(inner, (active) => events.push(active)) };
};

test('ducks while a chunk plays and releases after the release delay', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sink, events } = harness();
    await sink.play(CHUNK, 1, SIGNAL);
    assert.deepEqual(events, [true]);
    mock.timers.tick(DUCK_RELEASE_MS);
    assert.deepEqual(events, [true, false]);
  } finally {
    mock.timers.reset();
  }
});

test('back-to-back chunks keep the duck without releasing in between', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sink, events } = harness();
    await sink.play(CHUNK, 1, SIGNAL);
    mock.timers.tick(DUCK_RELEASE_MS - 1);
    await sink.play(CHUNK, 1, SIGNAL);
    mock.timers.tick(DUCK_RELEASE_MS - 1);
    assert.deepEqual(events, [true, true]);
    mock.timers.tick(1);
    assert.deepEqual(events, [true, true, false]);
  } finally {
    mock.timers.reset();
  }
});

test('a failing chunk still releases the duck', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sink, events } = harness(async () => {
      throw new Error('no player');
    });
    await assert.rejects(sink.play(CHUNK, 1, SIGNAL), /no player/);
    mock.timers.tick(DUCK_RELEASE_MS);
    assert.deepEqual(events, [true, false]);
  } finally {
    mock.timers.reset();
  }
});

test('forwards pause and resume to the wrapped sink', () => {
  const { sink, events } = harness();
  sink.pause?.();
  sink.resume?.();
  assert.deepEqual(events, [false, true]);
});
