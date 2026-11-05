import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PreviewAudio, PreviewRequest } from './voice-host.ts';
import { createReplay, type ReplaySegment } from './voice-replay.ts';

const PASSAGE = 'turn-1';
const OTHER_PASSAGE = 'turn-2';
const CHUNK = new Uint8Array([1]);
const SPEED = 1.5;
const VOLUME = 0.4;
const DURATION_MS = 250;
const SEGMENTS: readonly ReplaySegment[] = [
  { text: 'The gate opens.' },
  { speakerId: 'Vyrnax', text: 'Who goes there?' },
  { speakerId: 'Nobody', text: 'Only me.' },
];

const setup = () => {
  const events: string[] = [];
  const waits: (() => void)[] = [];
  const requests: PreviewRequest[] = [];
  let changes = 0;
  const replay = createReplay({
    preview: async (request): Promise<PreviewAudio> => {
      requests.push(request);
      return { chunks: [CHUNK], synthesisMs: 0, cacheHit: request.text === SEGMENTS[0]?.text };
    },
    stopLive: () => events.push('live-stop'),
    audio: {
      play: async (_chunks, volume) => {
        events.push(`play@${volume}`);
        return { decodeMs: 0, durationMs: DURATION_MS };
      },
      stop: () => events.push('audio-stop'),
    },
    provider: () => 'kokoro',
    voiceOf: (speakerId) => (speakerId === 'Vyrnax' ? 'am_adam' : 'af_heart'),
    language: () => 'en',
    speed: () => SPEED,
    volume: () => VOLUME,
    wait: (ms) => {
      events.push(`wait@${ms}`);
      return new Promise<void>((resolve) => waits.push(resolve));
    },
    changed: () => {
      changes += 1;
    },
  });
  const tick = async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  };
  const release = async () => {
    waits.shift()?.();
    await tick();
  };
  return { replay, events, requests, release, tick, changes: () => changes };
};

test('rpg-cm63.46 replay speaks every segment in order with its own voice, speed and volume', async () => {
  const { replay, requests, events, release, tick } = setup();
  void replay.toggle(PASSAGE, SEGMENTS);
  await tick();
  assert.equal(replay.playing(), PASSAGE);
  await release();
  await release();
  await release();
  assert.deepEqual(
    requests.map(({ providerId, voiceId, language, speed, text }) => [providerId, voiceId, language, speed, text]),
    [
      ['kokoro', 'af_heart', 'en', SPEED, 'The gate opens.'],
      ['kokoro', 'am_adam', 'en', SPEED, 'Who goes there?'],
      ['kokoro', 'af_heart', 'en', SPEED, 'Only me.'],
    ],
  );
  assert.deepEqual(events.slice(0, 3), ['live-stop', `play@${VOLUME}`, `wait@${DURATION_MS}`]);
  assert.equal(replay.playing(), undefined);
});

test('rpg-cm63.46 a second press stops the replay and later segments are not spoken', async () => {
  const { replay, requests, events, release, tick } = setup();
  void replay.toggle(PASSAGE, SEGMENTS);
  await tick();
  void replay.toggle(PASSAGE, SEGMENTS);
  await tick();
  assert.equal(replay.playing(), undefined);
  assert.ok(events.includes('audio-stop'));
  await release();
  assert.equal(requests.length, 1);
});

test('rpg-cm63.46 starting another replay stops the first one', async () => {
  const { replay, requests, release, tick } = setup();
  void replay.toggle(PASSAGE, SEGMENTS);
  await tick();
  void replay.toggle(OTHER_PASSAGE, [{ text: 'Elsewhere.' }]);
  await tick();
  assert.equal(replay.playing(), OTHER_PASSAGE);
  await release();
  await release();
  assert.deepEqual(
    requests.map(({ text }) => text),
    ['The gate opens.', 'Elsewhere.'],
  );
  assert.equal(replay.playing(), undefined);
});

test('rpg-cm63.46 stop ends playback and does nothing when idle', async () => {
  const { replay, events, tick } = setup();
  replay.stop();
  assert.equal(events.length, 0);
  void replay.toggle(PASSAGE, SEGMENTS);
  await tick();
  replay.stop();
  assert.equal(replay.playing(), undefined);
  assert.ok(events.includes('audio-stop'));
});

test('rpg-cm63.46 a failed synthesis ends the replay without throwing', async () => {
  const replay = createReplay({
    preview: async () => {
      throw new Error('engine stopped');
    },
    stopLive: () => {},
    audio: { play: async () => ({ decodeMs: 0 }), stop: () => {} },
    provider: () => 'kokoro',
    voiceOf: () => 'af_heart',
    language: () => 'en',
    speed: () => 1,
    volume: () => 1,
    wait: async () => {},
    changed: () => {},
  });
  await replay.toggle(PASSAGE, SEGMENTS);
  assert.equal(replay.playing(), undefined);
});

test('rpg-cm63.46 nothing is spoken without an installed provider', async () => {
  const requests: unknown[] = [];
  const replay = createReplay({
    preview: async (request) => {
      requests.push(request);
      return { chunks: [], synthesisMs: 0, cacheHit: false };
    },
    stopLive: () => {},
    audio: { play: async () => ({ decodeMs: 0 }), stop: () => {} },
    provider: () => undefined,
    voiceOf: () => undefined,
    language: () => 'en',
    speed: () => 1,
    volume: () => 1,
    wait: async () => {},
    changed: () => {},
  });
  await replay.toggle(PASSAGE, SEGMENTS);
  assert.deepEqual(requests, []);
  assert.equal(replay.playing(), undefined);
});

test('rpg-cm63.49 replay builds each request with the live style and pronunciations and the segment delivery', async () => {
  const { replay, requests, release, tick } = setup();
  const delivery = { emotion: 'angry', intensity: 0.8 };
  void replay.toggle(PASSAGE, [
    { text: 'The gate opens.' },
    { speakerId: 'Vyrnax', text: 'Who goes there?', delivery },
  ]);
  await tick();
  await release();
  await release();
  assert.deepEqual(
    requests.map(({ style, pronunciations, delivery: spoken }) => [style, pronunciations, spoken]),
    [
      ['', {}, undefined],
      ['', {}, delivery],
    ],
  );
});
