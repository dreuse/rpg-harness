import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Accepted, Result, SubmitPlayerAction } from '../../client-protocol/src/protocol.ts';
import { createAudioCache, createUsageLedger, speakWithBudget } from './audio-budget.ts';
import { createBargeIn } from './barge-in.ts';
import { createVoiceActionSubmitter, transcribeTurn, type VoiceActionCommand } from './fallback.ts';
import { createMicrophoneController, type MicrophoneSource } from './microphone.ts';
import { createOutputQueue, type PlaybackEvent } from './playback.ts';
import { startTranscription } from './stt.ts';
import { createSubtitleTranscript } from './subtitles.ts';
import { TEST_AUDIO_FORMAT } from './test-audio-format.ts';
import type { SpeechChunk, TtsProvider } from './tts.ts';
import { createTurnDetector, type TurnOptions, type VoiceTurn } from './turns.ts';
import {
  type AudioInputProvider,
  type CommittedUtterance,
  DEFAULT_VOICE_SETTINGS,
  resolveVoiceMode,
  type VoiceProfile,
  type VoiceSettings,
} from './voice.ts';
import { routeVoiceInput, type VoiceSession } from './voice-settings.ts';

const STT_ID = 'fake-stt';
const TTS_ID = 'fake-tts';
const STT_LATENCY_MS = 300;
const TTS_FIRST_AUDIO_LATENCY_MS = 200;
const CHUNK_TICK_MS = 20;
const HANGING_EVENT = 'ev-1';
const QUEUED_EVENT = 'ev-2';
const TRANSCRIPT_TEXT = 'open the door';
const NARRATION = 'The door creaks open.';
const SPEECH = new Uint8Array([9]);
const TURN_OPTIONS: TurnOptions = { speechChunksToStart: 2, silenceChunksToEnd: 2, minTurnChunks: 2 };
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 10;
const CACHE_MAX_BYTES = 4;
const REVISION = 7;

const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: TTS_ID, voiceId: 'v1' }],
};

const ENABLED: VoiceSettings = {
  microphone: 'push-to-talk',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: [STT_ID, TTS_ID] },
};
const DISABLED: VoiceSettings = { ...ENABLED, microphone: 'off', spokenOutput: 'off' };

const utterance = (eventId: string, text = `line ${eventId}`): CommittedUtterance =>
  Object.freeze({ text, speakerId: 'gm', eventId, profile: PROFILE });

const chunkFor = (spoken: CommittedUtterance, voiceId: string, sequence: number, final: boolean): SpeechChunk => ({
  utteranceEventId: spoken.eventId,
  sequence,
  audio: new Uint8Array([1, 2]),
  mimeType: 'audio/mpeg',
  voiceId,
  final,
});

const ttsProvider = (onSynthesize: (spoken: CommittedUtterance, signal: AbortSignal) => Promise<void>) => {
  const spoken: string[] = [];
  const provider: TtsProvider = {
    id: TTS_ID,
    locality: 'local',
    retention: 'none',
    async *synthesize(item, voiceId, signal) {
      spoken.push(item.eventId);
      await onSynthesize(item, signal);
      yield chunkFor(item, voiceId, 0, true);
    },
  };
  return { provider, spoken };
};

const sttProvider = (text: string, onTranscribe: () => void = () => {}): AudioInputProvider => ({
  id: STT_ID,
  locality: 'local',
  retention: 'none',
  async *transcribe(audio) {
    for await (const chunk of audio) void chunk;
    onTranscribe();
    yield { id: 'seg-1', text, startMs: 0, endMs: 900, confidence: 0.95, final: true, locale: 'en-GB' };
  },
});

const spokenTurn = (settings: VoiceSettings, now: () => number): VoiceTurn[] => {
  const turns: VoiceTurn[] = [];
  const detector = createTurnDetector({
    settings,
    options: TURN_OPTIONS,
    isSpeech: (chunk) => chunk[0] !== 0,
    nextId: () => 'turn-1',
    now,
    onTurn: (turn) => turns.push(turn),
  });
  detector.start('push-to-talk');
  detector.press();
  for (const chunk of [SPEECH, SPEECH]) detector.push(chunk);
  detector.release();
  return turns;
};

const spySession = () => {
  const commands: SubmitPlayerAction[] = [];
  return {
    commands,
    session: {
      submitPlayerAction: (command: SubmitPlayerAction): Result<Accepted> => {
        commands.push(command);
        return { ok: true, value: { revision: REVISION + commands.length } };
      },
    },
  };
};

const fakeMicrophone = () => {
  const source = {
    permissionRequests: 0,
    opened: [] as string[],
    async requestPermission() {
      source.permissionRequests += 1;
      return 'granted' as const;
    },
    async listDevices() {
      return [{ id: 'built-in', label: 'Built-in', isDefault: true }];
    },
    async open(deviceId: string) {
      source.opened.push(deviceId);
      return { chunks: (async function* () {})(), close() {} };
    },
    onDeviceChange: () => () => {},
  };
  return source satisfies MicrophoneSource;
};

const session = (): VoiceSession => ({
  campaignId: 'c1',
  turn: 1,
  pendingInput: [],
  preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-GB', speed: 1 },
});

test('latency from end of speech to transcript and to first audio stays within budget', async () => {
  let clock = 0;
  const now = () => clock;
  const tick = (ms: number) => {
    clock += ms;
  };
  const turns = spokenTurn(ENABLED, () => {
    tick(CHUNK_TICK_MS);
    return clock;
  });
  const turn = turns[0] as VoiceTurn;
  const endOfSpeech = turn.endedAt;

  const transcription = await transcribeTurn({
    settings: ENABLED,
    providers: [sttProvider(TRANSCRIPT_TEXT, () => tick(STT_LATENCY_MS))],
    providerId: STT_ID,
    turn,
  });
  assert.equal(transcription.kind, 'transcript');
  const transcriptAt = now();

  let firstAudioAt: number | undefined;
  const { provider } = ttsProvider(async () => tick(TTS_FIRST_AUDIO_LATENCY_MS));
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: {
      play: async () => {
        firstAudioAt ??= now();
      },
    },
    speech: { settings: ENABLED, providers: [provider], rate: RATE, budget: BUDGET },
    onEvent: () => {},
  });
  queue.enqueue(utterance('ev-latency', NARRATION));
  await queue.idle();

  const report = {
    speechToTranscriptMs: transcriptAt - endOfSpeech,
    transcriptToFirstAudioMs: (firstAudioAt ?? Number.NaN) - transcriptAt,
  };
  assert.deepEqual(report, {
    speechToTranscriptMs: STT_LATENCY_MS,
    transcriptToFirstAudioMs: TTS_FIRST_AUDIO_LATENCY_MS,
  });
});

test('barge-in cancels playback and pending speech, and the cancelled line is never spoken', async () => {
  const transcript = createSubtitleTranscript();
  const played: string[] = [];
  let firstChunk: () => void = () => {};
  const playing = new Promise<void>((resolve) => {
    firstChunk = resolve;
  });
  const { provider: hanging, spoken } = ttsProvider(async () => {});
  const speakThenHang = hanging.synthesize;
  hanging.synthesize = async function* (item, voiceId, signal) {
    yield* speakThenHang(item, voiceId, signal);
    if (item.eventId === HANGING_EVENT) await new Promise((resolve) => signal.addEventListener('abort', resolve));
  };
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: {
      play: async (chunk) => {
        played.push(chunk.utteranceEventId);
        firstChunk();
      },
    },
    speech: { settings: ENABLED, providers: [hanging], rate: RATE, budget: BUDGET },
    onEvent: (event) => transcript.onPlayback(event),
  });
  const lines = [utterance(HANGING_EVENT), utterance(QUEUED_EVENT)];
  for (const line of lines) {
    transcript.commit(line);
    queue.enqueue(line);
  }
  await playing;

  const detector = createTurnDetector({
    settings: ENABLED,
    options: TURN_OPTIONS,
    isSpeech: (chunk) => chunk[0] !== 0,
    nextId: () => 'turn-1',
    now: () => 0,
    onTurn: () => {},
    onSpeechStart: createBargeIn(queue),
  });
  detector.start('push-to-talk');
  detector.press();
  await queue.idle();

  assert.deepEqual(played, [HANGING_EVENT]);
  assert.deepEqual(spoken, [HANGING_EVENT]);
  assert.equal(queue.playing(), false);
  assert.deepEqual(
    transcript.entries().map(({ eventId, status }) => [eventId, status]),
    [
      [HANGING_EVENT, 'interrupted'],
      [QUEUED_EVENT, 'pending'],
    ],
  );
  assert.equal(transcript.current(), undefined);
});

test('stt transcript is only a proposal and subtitles match the committed utterance text', async () => {
  const { commands, session: actionSession } = spySession();
  const submit = createVoiceActionSubmitter(actionSession);
  const [turn] = spokenTurn(ENABLED, () => 0);
  const result = await transcribeTurn({
    settings: ENABLED,
    providers: [sttProvider(TRANSCRIPT_TEXT)],
    providerId: STT_ID,
    turn: turn as VoiceTurn,
  });
  assert.equal(result.kind, 'transcript');
  assert.equal(commands.length, 0);
  if (result.kind !== 'transcript') return;
  const proposed = result.segments.map(({ text }) => text).join(' ');
  assert.equal(proposed, TRANSCRIPT_TEXT);
  const command: VoiceActionCommand = {
    version: 1,
    type: 'SubmitPlayerAction',
    campaignId: 'c1',
    expectedRevision: REVISION,
    sceneId: 'scene-1',
    actorId: 'hero-1',
    input: proposed,
  };
  assert.equal(submit(result.turnId, command).ok, true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.input, TRANSCRIPT_TEXT);

  const events: PlaybackEvent[] = [];
  const transcript = createSubtitleTranscript();
  const shown: (string | undefined)[] = [];
  const { provider } = ttsProvider(async () => {});
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: { play: async () => void shown.push(transcript.current()?.text) },
    speech: { settings: ENABLED, providers: [provider], rate: RATE, budget: BUDGET },
    onEvent: (event) => {
      events.push(event);
      transcript.onPlayback(event);
    },
  });
  const committed = utterance('ev-text', NARRATION);
  transcript.commit(committed);
  queue.enqueue(committed);
  await queue.idle();

  assert.deepEqual(shown, [NARRATION]);
  assert.equal(transcript.entries()[0]?.text, committed.text);
  assert.equal(transcript.entries()[0]?.status, 'spoken');
  assert.equal(commands.length, 1);
});

test('disabling voice stops capture and output while the text path keeps working', async () => {
  const source = fakeMicrophone();
  const microphone = createMicrophoneController(source, ENABLED);
  assert.equal((await microphone.start()).kind, 'capturing');
  microphone.stop();
  assert.deepEqual(microphone.state(), { kind: 'typed-input-only', reason: 'stopped' });
  assert.equal(microphone.stream(), undefined);

  const off = createMicrophoneController(source, DISABLED);
  assert.deepEqual(await off.start(), { kind: 'typed-input-only', reason: 'no-consent' });
  assert.equal(source.opened.length, 1);
  assert.equal(
    startTranscription({
      settings: DISABLED,
      providers: [sttProvider(TRANSCRIPT_TEXT)],
      providerId: STT_ID,
      audio: (async function* () {})(),
    }).status().kind,
    'typed-input-only',
  );

  const events: PlaybackEvent[] = [];
  const { provider, spoken } = ttsProvider(async () => {});
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: { play: async () => assert.fail('no audio when voice is off') },
    speech: { settings: DISABLED, providers: [provider], rate: RATE, budget: BUDGET },
    onEvent: (event) => events.push(event),
  });
  queue.enqueue(utterance('ev-off', NARRATION));
  await queue.idle();
  assert.deepEqual(spoken, []);
  assert.deepEqual(
    events.map((event) => event.kind === 'subtitle' && [event.state, 'reason' in event && event.reason]),
    [['text-only', 'voice-off']],
  );

  const submitted: string[] = [];
  const route = routeVoiceInput(session(), { source: 'typed', text: TRANSCRIPT_TEXT }, ['en-GB'], (text) => {
    submitted.push(text);
    return text;
  });
  assert.deepEqual(route, { kind: 'action', result: TRANSCRIPT_TEXT });
  assert.deepEqual(submitted, [TRANSCRIPT_TEXT]);
});

test('mic capture is never activated silently and audio is not stored indefinitely by default', async () => {
  assert.deepEqual(resolveVoiceMode(DEFAULT_VOICE_SETTINGS), { kind: 'typed-input-only' });
  const source = fakeMicrophone();
  const microphone = createMicrophoneController(source, DEFAULT_VOICE_SETTINGS);
  assert.deepEqual(await microphone.start(), { kind: 'typed-input-only', reason: 'no-consent' });
  assert.equal(source.permissionRequests, 0);
  assert.deepEqual(source.opened, []);

  const cache = createAudioCache(CACHE_MAX_BYTES);
  const ledger = createUsageLedger({ rate: RATE, cap: BUDGET });
  const { provider, spoken } = ttsProvider(async () => {});
  const defaultOutcome = await speakWithBudget({
    audioFormat: TEST_AUDIO_FORMAT,
    utterance: utterance('ev-default'),
    settings: DEFAULT_VOICE_SETTINGS,
    providers: [provider],
    ledger,
    cache,
    safeToCache: true,
  });
  assert.deepEqual(defaultOutcome, { kind: 'text', reason: 'voice-off' });
  assert.deepEqual(spoken, []);
  assert.equal(cache.bytes, 0);

  for (const eventId of ['ev-a', 'ev-b', 'ev-c']) {
    const outcome = await speakWithBudget({
      audioFormat: TEST_AUDIO_FORMAT,
      utterance: utterance(eventId),
      settings: ENABLED,
      providers: [provider],
      ledger,
      cache,
      safeToCache: true,
    });
    if (outcome.kind === 'speech') for await (const chunk of outcome.chunks) void chunk;
  }
  assert.ok(cache.bytes <= CACHE_MAX_BYTES);
});

test('subtitles accompany spoken output and text fallback works when audio is unavailable', async () => {
  const transcript = createSubtitleTranscript();
  const { provider } = ttsProvider(async () => {});
  const live: (string | undefined)[] = [];
  const speaking = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: { play: async () => void live.push(transcript.current()?.text) },
    speech: { settings: ENABLED, providers: [provider], rate: RATE, budget: BUDGET },
    onEvent: (event) => transcript.onPlayback(event),
  });
  const spokenLine = utterance('ev-spoken', NARRATION);
  transcript.commit(spokenLine);
  speaking.enqueue(spokenLine);
  await speaking.idle();
  assert.deepEqual(live, [NARRATION]);

  const unavailable = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: { play: async () => assert.fail('no audio without a provider') },
    speech: { settings: ENABLED, providers: [], rate: RATE, budget: BUDGET },
    onEvent: (event) => transcript.onPlayback(event),
  });
  const fallbackLine = utterance('ev-fallback', 'The rain stops.');
  transcript.commit(fallbackLine);
  unavailable.enqueue(fallbackLine);
  await unavailable.idle();

  const [first, second] = transcript.entries();
  assert.deepEqual([first?.status, first?.text], ['spoken', NARRATION]);
  assert.deepEqual(
    [second?.status, second?.text, second?.reason],
    ['text-only', 'The rain stops.', 'provider-unavailable'],
  );
});
