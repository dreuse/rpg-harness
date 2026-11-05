import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBargeIn } from './barge-in.ts';
import { createOutputQueue, type InterruptOptions, type PlaybackEvent } from './playback.ts';
import { TEST_AUDIO_FORMAT } from './test-audio-format.ts';
import type { SpeechChunk, TtsProvider } from './tts.ts';
import { createTurnDetector, type TurnMode, type TurnOptions, type VoiceTurn } from './turns.ts';
import type { CommittedUtterance, MicrophoneMode, VoiceProfile, VoiceSettings } from './voice.ts';

const PROVIDER_ID = 'a';
const HANGING_EVENT = 'ev-1';
const SPEECH = new Uint8Array([9]);
const OPTIONS: TurnOptions = { speechChunksToStart: 2, silenceChunksToEnd: 2, minTurnChunks: 2 };
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 10;
const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: PROVIDER_ID, voiceId: 'a-voice' }],
};

const settingsFor = (microphone: MicrophoneMode): VoiceSettings => ({
  microphone,
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: [PROVIDER_ID] },
});

const utterance = (eventId: string): CommittedUtterance =>
  Object.freeze({ text: `line ${eventId}`, speakerId: 'gm', eventId, profile: PROFILE });

const hangingProvider: TtsProvider = {
  id: PROVIDER_ID,
  locality: 'local',
  retention: 'none',
  async *synthesize(spoken, voiceId, signal): AsyncGenerator<SpeechChunk> {
    yield {
      utteranceEventId: spoken.eventId,
      sequence: 0,
      audio: new Uint8Array([0]),
      mimeType: 'audio/mpeg',
      voiceId,
      final: false,
    };
    if (spoken.eventId === HANGING_EVENT) await new Promise((resolve) => signal.addEventListener('abort', resolve));
  },
};

const setup = (microphone: MicrophoneMode, interrupt?: InterruptOptions) => {
  const events: PlaybackEvent[] = [];
  const turns: VoiceTurn[] = [];
  let firstChunk: () => void = () => {};
  const playing = new Promise<void>((resolve) => {
    firstChunk = resolve;
  });
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: { play: async () => firstChunk() },
    speech: { settings: settingsFor(microphone), providers: [hangingProvider], rate: RATE, budget: BUDGET },
    onEvent: (event) => events.push(event),
  });
  let ids = 0;
  const detector = createTurnDetector({
    settings: settingsFor(microphone),
    options: OPTIONS,
    isSpeech: (chunk) => chunk[0] !== 0,
    nextId: () => `turn-${++ids}`,
    now: () => 0,
    onTurn: (turn) => turns.push(turn),
    onSpeechStart: createBargeIn(queue, interrupt),
  });
  return { queue, detector, events, turns, playing };
};

const interruptedEvents = (events: readonly PlaybackEvent[]) => events.filter((event) => event.kind === 'interrupted');

const startOutput = async (microphone: MicrophoneMode, mode: TurnMode, interrupt?: InterruptOptions) => {
  const harness = setup(microphone, interrupt);
  harness.detector.start(mode);
  for (const id of [HANGING_EVENT, 'ev-2', 'ev-3']) harness.queue.enqueue(utterance(id));
  await harness.playing;
  return harness;
};

test('player speech stops output and preserves the exact committed turn boundary', async () => {
  const ptt = await startOutput('push-to-talk', 'push-to-talk', { dropPending: false });
  ptt.detector.press();
  await ptt.queue.idle();
  assert.deepEqual(interruptedEvents(ptt.events), [
    { kind: 'interrupted', utteranceEventId: HANGING_EVENT, dropped: 0 },
  ]);
  assert.deepEqual(
    ptt.events.filter((event) => event.kind === 'subtitle' && event.utteranceEventId === HANGING_EVENT),
    [
      {
        kind: 'subtitle',
        utteranceEventId: HANGING_EVENT,
        speakerId: 'gm',
        text: `line ${HANGING_EVENT}`,
        state: 'start',
      },
      {
        kind: 'subtitle',
        utteranceEventId: HANGING_EVENT,
        speakerId: 'gm',
        text: `line ${HANGING_EVENT}`,
        state: 'end',
      },
    ],
  );

  const handsFree = await startOutput('hands-free', 'hands-free');
  handsFree.detector.push(SPEECH);
  assert.equal(interruptedEvents(handsFree.events).length, 0);
  handsFree.detector.push(SPEECH);
  await handsFree.queue.idle();
  assert.deepEqual(interruptedEvents(handsFree.events), [
    { kind: 'interrupted', utteranceEventId: HANGING_EVENT, dropped: 2 },
  ]);
  const ended = handsFree.events.filter((event) => event.kind === 'subtitle' && event.state === 'end');
  assert.deepEqual(
    ended.map((event) => event.kind === 'subtitle' && event.utteranceEventId),
    [HANGING_EVENT],
  );

  const quiet = setup('push-to-talk');
  quiet.detector.start('push-to-talk');
  quiet.detector.press();
  assert.equal(interruptedEvents(quiet.events).length, 0);
});

test('an interrupted half-heard sentence is not emitted as a completed player turn', async () => {
  const halfHeard = await startOutput('push-to-talk', 'push-to-talk');
  halfHeard.detector.press();
  halfHeard.detector.push(SPEECH);
  halfHeard.detector.release();
  assert.equal(interruptedEvents(halfHeard.events).length, 1);
  assert.equal(halfHeard.turns.length, 0);
  halfHeard.detector.press();
  for (let index = 0; index < OPTIONS.minTurnChunks; index++) halfHeard.detector.push(SPEECH);
  halfHeard.detector.release();
  assert.equal(halfHeard.turns.length, 1);
  assert.equal(halfHeard.turns[0]?.chunks.length, OPTIONS.minTurnChunks);
  await halfHeard.queue.idle();

  const cancelled = await startOutput('hands-free', 'hands-free');
  for (let index = 0; index < OPTIONS.speechChunksToStart + 1; index++) cancelled.detector.push(SPEECH);
  assert.equal(cancelled.detector.state(), 'listening');
  cancelled.detector.cancel();
  assert.equal(cancelled.detector.state(), 'idle');
  assert.deepEqual(cancelled.turns, []);
  await cancelled.queue.idle();
});
