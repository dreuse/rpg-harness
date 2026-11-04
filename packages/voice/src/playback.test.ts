import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOutputQueue,
  DEFAULT_PLAYBACK_SPEED,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  type PlaybackEvent,
  type PlaybackSink,
} from './playback.ts';
import type { SpeechChunk, TtsProvider } from './tts.ts';
import type { CommittedUtterance, VoiceProfile, VoiceSettings } from './voice.ts';

const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: 'a', voiceId: 'a-voice' }],
};
const SETTINGS: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: ['a'] },
};
const VOICE_OFF: VoiceSettings = { ...SETTINGS, spokenOutput: 'off' };
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 10;
const TIMEOUT_MS = 20;
const CHUNK_COUNT = 2;
const FAST_SPEED = 1.5;
const FAILING_EVENT = 'ev-fail';

const utterance = (eventId: string, speakerId = 'gm'): CommittedUtterance =>
  Object.freeze({ text: `line ${eventId}`, speakerId, eventId, profile: PROFILE });

interface FakeOptions {
  readonly hangFor?: string;
  readonly failMidStreamFor?: string;
}

const provider = (options: FakeOptions = {}): TtsProvider => ({
  id: 'a',
  locality: 'local',
  retention: 'none',
  async *synthesize(spoken, voiceId, signal): AsyncGenerator<SpeechChunk> {
    for (let sequence = 0; sequence < CHUNK_COUNT; sequence++) {
      if (sequence > 0 && spoken.eventId === options.failMidStreamFor) throw new Error('boom');
      yield {
        utteranceEventId: spoken.eventId,
        sequence,
        audio: new Uint8Array([sequence]),
        mimeType: 'audio/mpeg',
        voiceId,
        final: sequence === CHUNK_COUNT - 1,
      };
      if (spoken.eventId === options.hangFor) await new Promise((resolve) => signal.addEventListener('abort', resolve));
    }
  },
});

interface Played {
  readonly eventId: string;
  readonly sequence: number;
  readonly speed: number;
}

const setup = (options: { providers?: TtsProvider[]; settings?: VoiceSettings; sink?: PlaybackSink } = {}) => {
  const events: PlaybackEvent[] = [];
  const played: Played[] = [];
  const sink: PlaybackSink = options.sink ?? {
    async play(chunk, speed) {
      played.push({ eventId: chunk.utteranceEventId, sequence: chunk.sequence, speed });
      events.push({
        kind: 'subtitle',
        utteranceEventId: chunk.utteranceEventId,
        speakerId: 'chunk',
        text: '',
        state: 'start',
      });
    },
  };
  const queue = createOutputQueue({
    sink,
    speech: {
      settings: options.settings ?? SETTINGS,
      providers: options.providers ?? [provider()],
      rate: RATE,
      budget: BUDGET,
      firstChunkTimeoutMs: TIMEOUT_MS,
    },
    onEvent: (event) => events.push(event),
  });
  return { queue, events, played };
};

const firstChunk = async (played: readonly Played[]): Promise<void> => {
  while (played.length === 0) await new Promise((resolve) => setImmediate(resolve));
};

const subtitles = (events: PlaybackEvent[]) =>
  events.filter((event) => event.kind === 'subtitle' && event.speakerId !== 'chunk');

test('stream ordered utterances, synchronize subtitles and control playback speed', async () => {
  const { queue, events, played } = setup();
  assert.equal(queue.speed(), DEFAULT_PLAYBACK_SPEED);
  queue.enqueue(utterance('ev-1'));
  queue.setSpeed(FAST_SPEED);
  queue.enqueue(utterance('ev-2', 'npc'));
  await queue.idle();

  assert.deepEqual(
    played.map(({ eventId, sequence }) => `${eventId}:${sequence}`),
    ['ev-1:0', 'ev-1:1', 'ev-2:0', 'ev-2:1'],
  );
  assert.ok(played.every(({ speed }) => speed === FAST_SPEED));
  const order = events.map((event) =>
    event.kind === 'subtitle'
      ? `${event.speakerId === 'chunk' ? 'chunk' : event.state}:${event.utteranceEventId}`
      : event.kind,
  );
  assert.deepEqual(order, [
    'start:ev-1',
    'chunk:ev-1',
    'chunk:ev-1',
    'end:ev-1',
    'start:ev-2',
    'chunk:ev-2',
    'chunk:ev-2',
    'end:ev-2',
  ]);
  assert.deepEqual(subtitles(events)[2], {
    kind: 'subtitle',
    utteranceEventId: 'ev-2',
    speakerId: 'npc',
    text: 'line ev-2',
    state: 'start',
  });
});

test('setSpeed applies to the next chunk mid-playback', async () => {
  const speeds: number[] = [];
  const holder: { queue?: ReturnType<typeof createOutputQueue> } = {};
  const { queue } = setup({
    sink: {
      async play(_chunk, speed) {
        speeds.push(speed);
        holder.queue?.setSpeed(FAST_SPEED);
      },
    },
  });
  holder.queue = queue;
  queue.enqueue(utterance('ev-1'));
  await queue.idle();
  assert.deepEqual(speeds, [DEFAULT_PLAYBACK_SPEED, FAST_SPEED]);
});

test('reject playback speed outside the supported range', () => {
  const { queue } = setup();
  for (const invalid of [MIN_PLAYBACK_SPEED / 2, MAX_PLAYBACK_SPEED * 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => queue.setSpeed(invalid), RangeError);
  }
  assert.equal(queue.speed(), DEFAULT_PLAYBACK_SPEED);
  queue.setSpeed(MIN_PLAYBACK_SPEED);
  queue.setSpeed(MAX_PLAYBACK_SPEED);
  assert.equal(queue.speed(), MAX_PLAYBACK_SPEED);
});

test('emit a text-only subtitle with the reason when speech falls back to text', async () => {
  const { queue, events, played } = setup({ settings: VOICE_OFF });
  queue.enqueue(utterance('ev-1'));
  await queue.idle();
  assert.equal(played.length, 0);
  assert.deepEqual(events, [
    {
      kind: 'subtitle',
      utteranceEventId: 'ev-1',
      speakerId: 'gm',
      text: 'line ev-1',
      state: 'text-only',
      reason: 'voice-off',
    },
  ]);
});

test('provider failure on one utterance does not stall the queue', async () => {
  const { queue, events, played } = setup({ providers: [provider({ failMidStreamFor: FAILING_EVENT })] });
  queue.enqueue(utterance(FAILING_EVENT));
  queue.enqueue(utterance('ev-2'));
  await queue.idle();
  assert.deepEqual(
    played.map(({ eventId, sequence }) => `${eventId}:${sequence}`),
    [`${FAILING_EVENT}:0`, 'ev-2:0', 'ev-2:1'],
  );
  assert.deepEqual(
    subtitles(events).map((event) => event.kind === 'subtitle' && `${event.state}:${event.utteranceEventId}`),
    [`start:${FAILING_EVENT}`, `end:${FAILING_EVENT}`, 'start:ev-2', 'end:ev-2'],
  );
});

test('sink failure does not stall the queue', async () => {
  const played: string[] = [];
  const { queue } = setup({
    sink: {
      async play(chunk) {
        if (chunk.utteranceEventId === FAILING_EVENT) throw new Error('device lost');
        played.push(chunk.utteranceEventId);
      },
    },
  });
  queue.enqueue(utterance(FAILING_EVENT));
  queue.enqueue(utterance('ev-2'));
  await queue.idle();
  assert.deepEqual(played, ['ev-2', 'ev-2']);
});

test('interrupted playback never undoes already committed gameplay state', async () => {
  const committed = Object.freeze([utterance('ev-1'), utterance('ev-2'), utterance('ev-3')]);
  const snapshot = structuredClone(committed);
  const { queue, events, played } = setup({ providers: [provider({ hangFor: 'ev-1' })] });
  for (const item of committed) queue.enqueue(item);
  await firstChunk(played);
  queue.interrupt({ dropPending: false });
  await queue.idle();

  assert.deepEqual(committed, snapshot);
  assert.ok(Object.isFrozen(committed) && committed.every((item) => Object.isFrozen(item)));
  const interrupted = events.filter((event) => event.kind === 'interrupted');
  assert.deepEqual(interrupted[0], { kind: 'interrupted', utteranceEventId: 'ev-1', dropped: 0 });
  const started = subtitles(events)
    .filter((event) => event.kind === 'subtitle' && event.state !== 'end')
    .map((event) => event.kind === 'subtitle' && event.utteranceEventId);
  assert.deepEqual(started, ['ev-1', 'ev-2', 'ev-3']);
  assert.ok(
    subtitles(events).some(
      (event) => event.kind === 'subtitle' && event.utteranceEventId === 'ev-1' && event.state === 'end',
    ),
  );
});

test('interrupt with dropPending discards queued utterances', async () => {
  const { queue, events, played } = setup({ providers: [provider({ hangFor: 'ev-1' })] });
  queue.enqueue(utterance('ev-1'));
  queue.enqueue(utterance('ev-2'));
  queue.enqueue(utterance('ev-3'));
  await firstChunk(played);
  queue.interrupt({ dropPending: true });
  await queue.idle();
  assert.deepEqual(
    events.find((event) => event.kind === 'interrupted'),
    {
      kind: 'interrupted',
      utteranceEventId: 'ev-1',
      dropped: 2,
    },
  );
  assert.deepEqual([...new Set(played.map(({ eventId }) => eventId))], ['ev-1']);
});

const isolated = (onEvent: (event: PlaybackEvent) => void, firstChunkTimeoutMs = TIMEOUT_MS) =>
  createOutputQueue({
    sink: { play: async () => {} },
    speech: { settings: SETTINGS, providers: [provider()], rate: RATE, budget: BUDGET, firstChunkTimeoutMs },
    onEvent,
  });

test('a throwing event listener does not stall the queue', async () => {
  const events: PlaybackEvent[] = [];
  const queue = isolated((event) => {
    events.push(event);
    if (events.length === 1) throw new Error('listener failed');
  });
  queue.enqueue(utterance('ev-1'));
  await queue.idle();
  queue.enqueue(utterance('ev-2'));
  await queue.idle();
  assert.ok(events.some((event) => event.kind === 'subtitle' && event.utteranceEventId === 'ev-2'));
});

test('a speech setup error does not stall the queue', async () => {
  const queue = isolated(() => {}, 0);
  queue.enqueue(utterance('ev-1'));
  queue.enqueue(utterance('ev-2'));
  await queue.idle();
});

test('interrupt before the first chunk shows the text with the cancelled reason', async () => {
  const events: PlaybackEvent[] = [];
  const queue = isolated((event) => events.push(event));
  queue.enqueue(utterance('ev-1'));
  queue.interrupt();
  await queue.idle();
  assert.ok(
    events.some((event) => event.kind === 'subtitle' && event.state === 'text-only' && event.reason === 'cancelled'),
  );
});
