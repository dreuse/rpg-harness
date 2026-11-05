import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOutputQueue, type PlaybackSink } from './playback.ts';
import { createSubtitleTranscript } from './subtitles.ts';
import { TEST_AUDIO_FORMAT } from './test-audio-format.ts';
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
const MUTED: VoiceSettings = { ...SETTINGS, spokenOutput: 'off' };
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 10;
const CLOCK_START = 100;

const utterance = (eventId: string, speakerId = 'gm', text = `line ${eventId}`): CommittedUtterance =>
  Object.freeze({ text, speakerId, eventId, profile: PROFILE });

const tickingClock = () => {
  let now = CLOCK_START;
  return () => now++;
};

const subtitle = (u: CommittedUtterance) => ({
  kind: 'subtitle' as const,
  utteranceEventId: u.eventId,
  speakerId: u.speakerId,
  text: u.text,
});

test('keep text, speaker and timing aligned with playback', () => {
  const transcript = createSubtitleTranscript({ now: tickingClock() });
  const first = utterance('ev-1');
  const second = utterance('ev-2', 'npc');
  transcript.commit(first);
  transcript.commit(second);
  assert.equal(transcript.current(), undefined);

  transcript.onPlayback({ ...subtitle(first), state: 'start' });
  assert.deepEqual(transcript.current(), { eventId: 'ev-1', speakerId: 'gm', text: 'line ev-1' });
  transcript.onPlayback({ ...subtitle(first), state: 'end' });
  assert.equal(transcript.current(), undefined);

  transcript.onPlayback({ ...subtitle(second), state: 'start' });
  transcript.onPlayback({ kind: 'interrupted', utteranceEventId: 'ev-2', dropped: 0 });
  assert.equal(transcript.current(), undefined);
  transcript.onPlayback({ ...subtitle(second), state: 'end' });

  assert.deepEqual(transcript.entries(), [
    {
      sequence: 0,
      eventId: 'ev-1',
      speakerId: 'gm',
      text: 'line ev-1',
      status: 'spoken',
      startedAt: CLOCK_START,
      endedAt: CLOCK_START + 1,
    },
    {
      sequence: 1,
      eventId: 'ev-2',
      speakerId: 'npc',
      text: 'line ev-2',
      status: 'interrupted',
      startedAt: CLOCK_START + 2,
      endedAt: CLOCK_START + 3,
    },
  ]);
});

test('text-only playback shows the subtitle with the reason voice was not played', () => {
  const transcript = createSubtitleTranscript({ now: tickingClock() });
  const line = utterance('ev-1');
  transcript.commit(line);
  transcript.onPlayback({ ...subtitle(line), state: 'text-only', reason: 'provider-unavailable' });
  assert.deepEqual(transcript.current(), {
    eventId: 'ev-1',
    speakerId: 'gm',
    text: 'line ev-1',
    reason: 'provider-unavailable',
  });
  assert.equal(transcript.entries()[0]?.status, 'text-only');
  assert.equal(transcript.entries()[0]?.reason, 'provider-unavailable');
});

const mutedSetup = () => {
  const transcript = createSubtitleTranscript({ now: tickingClock() });
  const sink: PlaybackSink = { play: async () => undefined };
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink,
    speech: { settings: MUTED, providers: [], rate: RATE, budget: BUDGET },
    onEvent: transcript.onPlayback,
  });
  const lines = [utterance('ev-1'), utterance('ev-2', 'npc'), utterance('ev-3')];
  for (const line of lines) {
    transcript.commit(line);
    queue.enqueue(line);
  }
  return { transcript, queue };
};

test('users can mute voice and still access full narrative transcript', async () => {
  const { transcript, queue } = mutedSetup();
  await queue.idle();

  const mutedEntry = (sequence: number, eventId: string, speakerId: string) => ({
    sequence,
    eventId,
    speakerId,
    text: `line ${eventId}`,
    status: 'text-only',
    reason: 'voice-off',
    startedAt: CLOCK_START + sequence * 2,
    endedAt: CLOCK_START + sequence * 2 + 1,
  });
  assert.deepEqual(transcript.entries(), [
    mutedEntry(0, 'ev-1', 'gm'),
    mutedEntry(1, 'ev-2', 'npc'),
    mutedEntry(2, 'ev-3', 'gm'),
  ]);
  assert.deepEqual(
    transcript.search({ text: 'LINE EV-2' }).map(({ eventId }) => eventId),
    ['ev-2'],
  );
});

test('interrupting a muted queue clears the live subtitle and keeps dropped lines pending', async () => {
  const { transcript, queue } = mutedSetup();
  queue.interrupt({ dropPending: true });
  await queue.idle();

  assert.equal(transcript.current(), undefined);
  assert.deepEqual(
    transcript.entries().map(({ status }) => status),
    ['interrupted', 'pending', 'pending'],
  );
});

test('ignore duplicate commits and playback for uncommitted utterances', () => {
  const transcript = createSubtitleTranscript({ now: tickingClock() });
  const line = utterance('ev-1');
  transcript.commit(line);
  transcript.commit(utterance('ev-1', 'gm', 'rewritten'));
  const stray = utterance('ev-x');
  transcript.onPlayback({ ...subtitle(stray), state: 'start' });
  transcript.onPlayback({ ...subtitle(line), state: 'start' });
  transcript.onPlayback({ ...subtitle(line), state: 'start' });
  transcript.onPlayback({ ...subtitle(line), state: 'end' });
  transcript.onPlayback({ ...subtitle(line), state: 'end' });

  assert.deepEqual(transcript.entries(), [
    {
      sequence: 0,
      eventId: 'ev-1',
      speakerId: 'gm',
      text: 'line ev-1',
      status: 'spoken',
      startedAt: CLOCK_START,
      endedAt: CLOCK_START + 1,
    },
  ]);
  assert.equal(transcript.current(), undefined);
});

test('search history by folded text and filter by speaker', () => {
  const transcript = createSubtitleTranscript({ now: tickingClock() });
  transcript.commit(utterance('ev-1', 'gm', 'The Café opens'));
  transcript.commit(utterance('ev-2', 'npc', 'cafe is closed'));
  transcript.commit(utterance('ev-3', 'npc', 'Goodbye'));

  const ids = (query: Parameters<typeof transcript.search>[0]) => transcript.search(query).map((e) => e.eventId);
  assert.deepEqual(ids({ text: 'CAFÉ' }), ['ev-1', 'ev-2']);
  assert.deepEqual(ids({ speakerId: 'npc' }), ['ev-2', 'ev-3']);
  assert.deepEqual(ids({ text: 'cafe', speakerId: 'npc' }), ['ev-2']);
  assert.deepEqual(ids({}), ['ev-1', 'ev-2', 'ev-3']);
});
