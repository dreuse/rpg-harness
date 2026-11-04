import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Accepted, Result, SubmitPlayerAction } from '../../client-protocol/src/protocol.ts';
import {
  classifyAudioFailure,
  createVoiceActionSubmitter,
  type RecoveryEvent,
  reportSinkFailures,
  type TurnTranscriptionOptions,
  transcribeTurn,
  type VoiceActionCommand,
  voiceActionId,
} from './fallback.ts';
import { createOutputQueue, type PlaybackEvent } from './playback.ts';
import { type SpeechChunk, speakOrText, type TtsProvider } from './tts.ts';
import type { VoiceTurn } from './turns.ts';
import type {
  AudioInputProvider,
  CommittedUtterance,
  TranscriptSegment,
  VoiceProfile,
  VoiceSettings,
} from './voice.ts';

const STT_ID = 'local-stt';
const TTS_ID = 'local-tts';
const TURN_ID = 'turn-1';
const TIMEOUT_MS = 20;
const ATTEMPTS = 2;
const REVISION = 7;
const NOT_FOUND = 'NotFoundError';
const TIMEOUT = 'TimeoutError';
const AUDIO = new Uint8Array([1]);
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 10;

type Script = 'ok' | 'hang' | 'fail' | 'partial-then-fail' | 'no-device';

const SETTINGS: VoiceSettings = {
  microphone: 'push-to-talk',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: [STT_ID, TTS_ID] },
};

const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: TTS_ID, voiceId: 'tts-voice' }],
};

const UTTERANCE: CommittedUtterance = { text: 'The door opens.', speakerId: 'gm', eventId: 'ev-1', profile: PROFILE };

const TURN: VoiceTurn = { id: TURN_ID, mode: 'push-to-talk', chunks: [AUDIO], startedAt: 0, endedAt: 1 };

const segment = (id: string, text: string): TranscriptSegment => ({
  id,
  text,
  startMs: 0,
  endMs: 1,
  confidence: 1,
  final: true,
  locale: 'en-GB',
});

const FULL = segment('seg-full', 'open the door');

const scriptedStt = (scripts: readonly Script[]): AudioInputProvider & { calls: number } => {
  const provider = {
    id: STT_ID,
    locality: 'local' as const,
    retention: 'none' as const,
    calls: 0,
    async *transcribe(audio: AsyncIterable<Uint8Array>): AsyncGenerator<TranscriptSegment> {
      const script = scripts[provider.calls] ?? 'ok';
      provider.calls += 1;
      for await (const _ of audio);
      if (script === 'hang') await new Promise(() => {});
      if (script === 'fail') throw new Error('provider down');
      if (script === 'no-device') throw new DOMException('no input device', NOT_FOUND);
      if (script === 'partial-then-fail') {
        yield segment('seg-partial', 'open');
        throw new Error('stream dropped');
      }
      yield FULL;
    },
  };
  return provider;
};

const transcribe = (provider: AudioInputProvider, events: RecoveryEvent[], settings = SETTINGS) => {
  const options: TurnTranscriptionOptions = {
    turn: TURN,
    settings,
    providers: [provider],
    providerId: STT_ID,
    timeoutMs: TIMEOUT_MS,
    maxAttempts: ATTEMPTS,
    onEvent: (event) => events.push(event),
  };
  return transcribeTurn(options);
};

const ttsProvider = (behaviour: 'hang' | 'fail'): TtsProvider => ({
  id: TTS_ID,
  locality: 'local',
  retention: 'none',
  async *synthesize(): AsyncGenerator<SpeechChunk> {
    if (behaviour === 'hang') await new Promise(() => {});
    throw new Error('tts down');
  },
});

const speak = (provider: TtsProvider) =>
  speakOrText({
    utterance: UTTERANCE,
    settings: SETTINGS,
    providers: [provider],
    rate: RATE,
    budget: BUDGET,
    firstChunkTimeoutMs: TIMEOUT_MS,
  });

test('classify timeout, missing device and any other error as provider error', () => {
  assert.equal(classifyAudioFailure(new DOMException('slow', TIMEOUT)), 'timeout');
  assert.equal(classifyAudioFailure(new DOMException('gone', NOT_FOUND)), 'missing-device');
  assert.equal(classifyAudioFailure(new Error('boom')), 'provider-error');
  assert.equal(classifyAudioFailure(undefined), 'provider-error');
});

test('recover gracefully from an stt timeout by retrying the same turn', async () => {
  const events: RecoveryEvent[] = [];
  const provider = scriptedStt(['hang', 'ok']);
  const result = await transcribe(provider, events);
  assert.deepEqual(result, { kind: 'transcript', turnId: TURN_ID, segments: [FULL] });
  assert.deepEqual(events, [
    { kind: 'audio-failure', channel: 'stt', id: TURN_ID, attempt: 1, failure: 'timeout', next: 'retry' },
    { kind: 'audio-recovered', channel: 'stt', id: TURN_ID, attempt: 2 },
  ]);
});

test('recover gracefully from repeated stt timeouts by falling back to typed input', async () => {
  const events: RecoveryEvent[] = [];
  const provider = scriptedStt(['hang', 'hang']);
  const result = await transcribe(provider, events);
  assert.deepEqual(result, { kind: 'typed-input-only', turnId: TURN_ID, reason: 'timeout' });
  assert.equal(provider.calls, ATTEMPTS);
  assert.deepEqual(events.at(-1), {
    kind: 'audio-failure',
    channel: 'stt',
    id: TURN_ID,
    attempt: ATTEMPTS,
    failure: 'timeout',
    next: 'text',
  });
});

test('recover gracefully from a tts timeout by showing the text with a timeout reason', async () => {
  assert.deepEqual(await speak(ttsProvider('hang')), { kind: 'text', reason: 'timeout' });
});

test('recover gracefully from a missing input device without retrying', async () => {
  const events: RecoveryEvent[] = [];
  const provider = scriptedStt(['no-device', 'ok']);
  const result = await transcribe(provider, events);
  assert.deepEqual(result, { kind: 'typed-input-only', turnId: TURN_ID, reason: 'missing-device' });
  assert.equal(provider.calls, 1);
  assert.deepEqual(events, [
    { kind: 'audio-failure', channel: 'stt', id: TURN_ID, attempt: 1, failure: 'missing-device', next: 'text' },
  ]);
});

test('recover gracefully from a missing speaker while subtitles keep the text', async () => {
  const recovery: RecoveryEvent[] = [];
  const playback: PlaybackEvent[] = [];
  const speaking: TtsProvider = {
    id: TTS_ID,
    locality: 'local',
    retention: 'none',
    async *synthesize(utterance, voiceId) {
      yield {
        utteranceEventId: utterance.eventId,
        sequence: 0,
        audio: AUDIO,
        mimeType: 'audio/mpeg',
        voiceId,
        final: true,
      };
    },
  };
  const missingSpeaker = {
    play: async () => {
      throw new DOMException('no output device', NOT_FOUND);
    },
  };
  const queue = createOutputQueue({
    sink: reportSinkFailures(missingSpeaker, (event) => recovery.push(event)),
    speech: { settings: SETTINGS, providers: [speaking], rate: RATE, budget: BUDGET },
    onEvent: (event) => playback.push(event),
  });
  queue.enqueue(UTTERANCE);
  await queue.idle();
  assert.deepEqual(recovery, [
    {
      kind: 'audio-failure',
      channel: 'tts',
      id: UTTERANCE.eventId,
      attempt: 1,
      failure: 'missing-device',
      next: 'text',
    },
  ]);
  assert.deepEqual(
    playback.map((event) => (event.kind === 'subtitle' ? [event.state, event.text] : [event.kind])),
    [
      ['start', UTTERANCE.text],
      ['end', UTTERANCE.text],
    ],
  );
});

test('recover gracefully from an stt provider error by retrying the same turn', async () => {
  const events: RecoveryEvent[] = [];
  const provider = scriptedStt(['fail', 'ok']);
  const result = await transcribe(provider, events);
  assert.deepEqual(result, { kind: 'transcript', turnId: TURN_ID, segments: [FULL] });
  assert.deepEqual(events, [
    { kind: 'audio-failure', channel: 'stt', id: TURN_ID, attempt: 1, failure: 'provider-error', next: 'retry' },
    { kind: 'audio-recovered', channel: 'stt', id: TURN_ID, attempt: 2 },
  ]);
});

test('recover gracefully from a tts provider error by showing the text with a provider-error reason', async () => {
  assert.deepEqual(await speak(ttsProvider('fail')), { kind: 'text', reason: 'provider-error' });
});

test('keep typed input and never call the provider when voice is not consented', async () => {
  const events: RecoveryEvent[] = [];
  const provider = scriptedStt(['ok']);
  const result = await transcribe(provider, events, { ...SETTINGS, consent: { granted: false } });
  assert.deepEqual(result, { kind: 'typed-input-only', turnId: TURN_ID, reason: 'no-consent' });
  assert.equal(provider.calls, 0);
  assert.deepEqual(events, []);
});

test('reject invalid recovery options', () => {
  const provider = scriptedStt([]);
  for (const bad of [{ timeoutMs: 0 }, { timeoutMs: Number.NaN }, { maxAttempts: 0 }, { maxAttempts: 1.5 }]) {
    assert.throws(
      () => transcribeTurn({ turn: TURN, settings: SETTINGS, providers: [provider], providerId: STT_ID, ...bad }),
      RangeError,
    );
  }
});

test('no gameplay event is committed twice after retry', async () => {
  const events: RecoveryEvent[] = [];
  const provider = scriptedStt(['partial-then-fail', 'ok']);
  const result = await transcribe(provider, events);
  assert.equal(result.kind, 'transcript');
  if (result.kind !== 'transcript') return;
  assert.deepEqual(result.segments, [FULL]);

  const committed: SubmitPlayerAction[] = [];
  const submitted = createVoiceActionSubmitter({
    submitPlayerAction: (command): Result<Accepted> => {
      committed.push(command);
      return { ok: true, value: { revision: REVISION + committed.length } };
    },
  });
  const command: VoiceActionCommand = {
    version: 1,
    type: 'SubmitPlayerAction',
    campaignId: 'campaign-1',
    expectedRevision: REVISION,
    sceneId: 'scene-1',
    actorId: 'hero-1',
    input: result.segments.map((item) => item.text).join(' '),
  };
  const first = submitted(result.turnId, command);
  const again = submitted(result.turnId, command);
  assert.deepEqual(again, first);
  assert.equal(committed.length, 1);
  assert.equal(committed[0]?.actionId, voiceActionId(TURN_ID));
  assert.equal(committed[0]?.input, FULL.text);
});

test('resubmit the same action id after a rejected submission', () => {
  const actionIds: string[] = [];
  const outcomes: Result<Accepted>[] = [
    { ok: false, error: { code: 'StaleRevision', message: 'stale' } },
    { ok: true, value: { revision: REVISION } },
  ];
  const submitted = createVoiceActionSubmitter({
    submitPlayerAction: (command) => {
      actionIds.push(command.actionId);
      return outcomes[actionIds.length - 1] as Result<Accepted>;
    },
  });
  const command: VoiceActionCommand = {
    version: 1,
    type: 'SubmitPlayerAction',
    campaignId: 'campaign-1',
    expectedRevision: REVISION,
    sceneId: 'scene-1',
    actorId: 'hero-1',
    input: FULL.text,
  };
  assert.equal(submitted(TURN_ID, command).ok, false);
  assert.equal(submitted(TURN_ID, command).ok, true);
  assert.deepEqual(actionIds, [voiceActionId(TURN_ID), voiceActionId(TURN_ID)]);
});
