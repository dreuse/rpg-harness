import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ClarificationDecision,
  decideAction,
  LOW_CONFIDENCE_THRESHOLD,
  segmentQuality,
  startTranscription,
} from './stt.ts';
import type { AudioInputProvider, Locality, TranscriptSegment, VoiceSettings } from './voice.ts';

const LOCAL_ID = 'local-whisper';
const CLOUD_ID = 'cloud-stt';
const LOCALE = 'en-GB';
const CLEAR_CONFIDENCE = 0.95;
const LOW_CONFIDENCE = 0.4;
const SEGMENT_MS = 500;

const consented = (providerIds: readonly string[]): VoiceSettings => ({
  microphone: 'push-to-talk',
  spokenOutput: 'off',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds },
});

const segment = (index: number, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: `seg-${index}`,
  text: `word ${index}`,
  startMs: index * SEGMENT_MS,
  endMs: (index + 1) * SEGMENT_MS,
  confidence: CLEAR_CONFIDENCE,
  final: true,
  locale: LOCALE,
  ...overrides,
});

interface FakeProvider extends AudioInputProvider {
  readonly received: Uint8Array[];
  calls: number;
}

const fakeProvider = (id: string, locality: Locality, output: readonly unknown[], failAfter?: number): FakeProvider => {
  const provider: FakeProvider = {
    id,
    locality,
    retention: 'none',
    received: [],
    calls: 0,
    async *transcribe(audio) {
      provider.calls += 1;
      for await (const chunk of audio) provider.received.push(chunk);
      for (const [index, item] of output.entries()) {
        if (index === failAfter) throw new Error('provider down');
        yield item as TranscriptSegment;
      }
    },
  };
  return provider;
};

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1]);
  yield new Uint8Array([2]);
}

const collect = async (segments: AsyncIterable<TranscriptSegment>): Promise<TranscriptSegment[]> => {
  const out: TranscriptSegment[] = [];
  for await (const item of segments) out.push(item);
  return out;
};

test('convert speech to time-stamped text using pluggable local or cloud adapters', async () => {
  const expected = [segment(0), segment(1)];
  for (const [id, locality] of [
    [LOCAL_ID, 'local'],
    [CLOUD_ID, 'cloud'],
  ] as const) {
    const local = fakeProvider(LOCAL_ID, 'local', expected);
    const cloud = fakeProvider(CLOUD_ID, 'cloud', expected);
    const session = startTranscription({
      settings: consented([LOCAL_ID, CLOUD_ID]),
      providers: [local, cloud],
      providerId: id,
      audio: chunks(),
    });
    assert.deepEqual(session.status(), { kind: 'listening', providerId: id, locality });
    assert.deepEqual(await collect(session.segments), expected);
    const used = id === LOCAL_ID ? local : cloud;
    const unused = id === LOCAL_ID ? cloud : local;
    assert.equal(used.received.length, 2);
    assert.equal(unused.calls, 0);
  }
});

test('low-confidence recognition requires clarification for consequential actions', () => {
  const unclear = [segment(0), segment(1, { confidence: LOW_CONFIDENCE })];
  const clear = [segment(0), segment(1)];
  const needs: ClarificationDecision = { decision: 'needs-clarification', quality: 'low-confidence' };
  assert.deepEqual(decideAction(unclear, true), needs);
  assert.deepEqual(decideAction(unclear, false), { decision: 'accept', quality: 'low-confidence' });
  assert.deepEqual(decideAction(clear, true), { decision: 'accept', quality: 'clear' });
  assert.deepEqual(decideAction([], true), needs);
});

test('segment quality uses the named threshold', () => {
  assert.equal(segmentQuality(segment(0, { confidence: LOW_CONFIDENCE_THRESHOLD })), 'clear');
  assert.equal(segmentQuality(segment(0, { confidence: LOW_CONFIDENCE })), 'low-confidence');
});

test('no consent means the provider is never called', async () => {
  const local = fakeProvider(LOCAL_ID, 'local', [segment(0)]);
  const session = startTranscription({
    settings: { microphone: 'push-to-talk', spokenOutput: 'off', consent: { granted: false } },
    providers: [local],
    providerId: LOCAL_ID,
    audio: chunks(),
  });
  assert.deepEqual(session.status(), { kind: 'typed-input-only', reason: 'no-consent' });
  assert.deepEqual(await collect(session.segments), []);
  assert.equal(local.calls, 0);
});

test('microphone off means the provider is never called', async () => {
  const local = fakeProvider(LOCAL_ID, 'local', [segment(0)]);
  const session = startTranscription({
    settings: { ...consented([LOCAL_ID]), microphone: 'off', spokenOutput: 'narrator' },
    providers: [local],
    providerId: LOCAL_ID,
    audio: chunks(),
  });
  assert.deepEqual(session.status(), { kind: 'typed-input-only', reason: 'no-consent' });
  assert.equal(local.calls, 0);
});

test('cloud provider missing from consent is refused', async () => {
  const cloud = fakeProvider(CLOUD_ID, 'cloud', [segment(0)]);
  const session = startTranscription({
    settings: consented([LOCAL_ID]),
    providers: [cloud],
    providerId: CLOUD_ID,
    audio: chunks(),
  });
  assert.deepEqual(session.status(), { kind: 'typed-input-only', reason: 'provider-not-consented' });
  assert.deepEqual(await collect(session.segments), []);
  assert.equal(cloud.calls, 0);
});

test('unknown provider degrades to typed input', () => {
  const session = startTranscription({
    settings: consented([LOCAL_ID]),
    providers: [],
    providerId: LOCAL_ID,
    audio: chunks(),
  });
  assert.deepEqual(session.status(), { kind: 'typed-input-only', reason: 'provider-unavailable' });
});

test('malformed segments from the provider are dropped', async () => {
  const good = segment(0);
  const malformed = [
    segment(1, { startMs: Number.NaN }),
    segment(2, { endMs: Number.POSITIVE_INFINITY }),
    segment(3, { startMs: SEGMENT_MS * 2, endMs: SEGMENT_MS }),
    segment(4, { confidence: 1.5 }),
    segment(5, { confidence: -0.1 }),
    segment(6, { startMs: -1 }),
    { ...segment(7), text: 7 },
    null,
  ];
  const local = fakeProvider(LOCAL_ID, 'local', [good, ...malformed]);
  const session = startTranscription({
    settings: consented([CLOUD_ID]),
    providers: [local],
    providerId: LOCAL_ID,
    audio: chunks(),
  });
  assert.deepEqual(await collect(session.segments), [good]);
});

test('provider errors degrade to typed-input-only instead of throwing', async () => {
  const local = fakeProvider(LOCAL_ID, 'local', [segment(0), segment(1)], 1);
  const session = startTranscription({
    settings: consented([LOCAL_ID]),
    providers: [local],
    providerId: LOCAL_ID,
    audio: chunks(),
  });
  assert.deepEqual(await collect(session.segments), [segment(0)]);
  assert.deepEqual(session.status(), { kind: 'typed-input-only', reason: 'provider-error' });
});
