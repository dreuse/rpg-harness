import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AudioInputProvider,
  type AudioOutputProvider,
  DEFAULT_VOICE_SETTINGS,
  estimateCost,
  type RealtimeProvider,
  resolveVoiceMode,
  type TranscriptSegment,
  type UsageRate,
  type VoiceProfile,
  type VoiceSettings,
} from './voice.ts';

const SEGMENT: TranscriptSegment = {
  id: 'seg-1',
  text: 'open the door',
  startMs: 0,
  endMs: 900,
  confidence: 0.92,
  final: true,
  locale: 'en-GB',
};

const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: { Eldoria: 'el-DOR-ee-uh' },
  fallbacks: [{ providerId: 'fake', voiceId: 'v1' }],
};

const RATE: UsageRate = { unit: 'audio-second', currency: 'EUR', pricePerUnit: 0.01 };

async function* silence(): AsyncIterable<Uint8Array> {
  yield new Uint8Array(0);
}

const fakeInput: AudioInputProvider = {
  id: 'fake-stt',
  locality: 'local',
  retention: 'none',
  async *transcribe() {
    yield { ...SEGMENT, final: false };
    yield SEGMENT;
  },
};

const spoken: string[] = [];
const fakeOutput: AudioOutputProvider = {
  id: 'fake-tts',
  locality: 'cloud',
  retention: 'session',
  async *speak(utterance) {
    spoken.push(utterance.text);
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3]);
  },
};

const fakeRealtime: RealtimeProvider = {
  id: 'fake-rt',
  locality: 'cloud',
  retention: 'none',
  open() {
    return {
      segments: (async function* () {
        yield SEGMENT;
      })(),
      interrupt() {},
      close() {},
    };
  },
};

const enabled: VoiceSettings = {
  ...DEFAULT_VOICE_SETTINGS,
  microphone: 'push-to-talk',
  spokenOutput: 'full',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: ['fake-stt'] },
};

test('specify stt, tts, realtime, transcript and voice-profile provider interfaces', async () => {
  const segments: TranscriptSegment[] = [];
  for await (const s of fakeInput.transcribe(silence())) segments.push(s);
  assert.deepEqual(
    segments.map((s) => s.final),
    [false, true],
  );
  assert.equal(segments[1]?.confidence, 0.92);

  const chunks: Uint8Array[] = [];
  for await (const c of fakeOutput.speak({
    text: 'The door creaks.',
    speakerId: 'npc-1',
    eventId: 'event-1',
    profile: PROFILE,
  }))
    chunks.push(c);
  assert.equal(chunks.length, 2);
  assert.deepEqual(spoken, ['The door creaks.']);

  const session = fakeRealtime.open(PROFILE);
  for await (const s of session.segments) assert.equal(s.text, 'open the door');
  session.interrupt();
  session.close();

  assert.equal(estimateCost(RATE, 30).amount, 0.3);
  assert.equal(estimateCost(RATE, 30).currency, 'EUR');
});

test('all features remain available with voice completely disabled', () => {
  assert.deepEqual(resolveVoiceMode(DEFAULT_VOICE_SETTINGS), { kind: 'typed-input-only' });
  assert.equal(DEFAULT_VOICE_SETTINGS.consent.granted, false);
  assert.equal(DEFAULT_VOICE_SETTINGS.microphone, 'off');
  assert.equal(DEFAULT_VOICE_SETTINGS.spokenOutput, 'off');
  const noConsent: VoiceSettings = { ...enabled, consent: { granted: false } };
  assert.deepEqual(resolveVoiceMode(noConsent), { kind: 'typed-input-only' });
  assert.deepEqual(resolveVoiceMode(enabled), {
    kind: 'voice',
    microphone: 'push-to-talk',
    spokenOutput: 'full',
  });
  const noProviders: VoiceSettings = {
    ...enabled,
    consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: [] },
  };
  assert.deepEqual(resolveVoiceMode(noProviders), { kind: 'typed-input-only' });
  assert.deepEqual(resolveVoiceMode({ ...enabled, microphone: 'off' }), {
    kind: 'voice',
    microphone: 'off',
    spokenOutput: 'full',
  });
});

test('estimateCost rejects non-finite or negative inputs', () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => estimateCost(RATE, bad), RangeError);
    assert.throws(() => estimateCost({ ...RATE, pricePerUnit: bad }, 1), RangeError);
  }
  assert.equal(estimateCost(RATE, 0).amount, 0);
});
