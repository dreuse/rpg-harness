import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { type SpeechChunk, selectVoiceId, speakOrText, type TtsProvider } from './tts.ts';
import type { CommittedUtterance, VoiceProfile, VoiceSettings } from './voice.ts';

const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [
    { providerId: 'a', voiceId: 'a-voice' },
    { providerId: 'b', voiceId: 'b-voice' },
  ],
};
const UTTERANCE: CommittedUtterance = { text: 'abcd', speakerId: 'gm', eventId: 'ev-1', profile: PROFILE };
const SETTINGS: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: ['a', 'b'] },
};
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 1 };
const BUDGET = 10;
const TIMEOUT_MS = 20;
const CHUNK_COUNT = 3;
const LONG_STREAM = 40;

interface FakeOptions {
  readonly healthy?: boolean;
  readonly throwOnStart?: boolean;
  readonly hang?: boolean;
}

const fake = (id: string, options: FakeOptions = {}): TtsProvider & { voices: string[]; signals: AbortSignal[] } => {
  const voices: string[] = [];
  const signals: AbortSignal[] = [];
  return {
    id,
    locality: 'cloud',
    retention: 'none',
    voices,
    signals,
    healthy: () => options.healthy ?? true,
    async *synthesize(utterance, voiceId, signal): AsyncGenerator<SpeechChunk> {
      voices.push(voiceId);
      signals.push(signal);
      if (options.throwOnStart) throw new Error('boom');
      if (options.hang) await new Promise(() => {});
      for (let sequence = 0; sequence < CHUNK_COUNT; sequence++) {
        yield {
          utteranceEventId: utterance.eventId,
          sequence,
          audio: new Uint8Array([sequence]),
          mimeType: 'audio/mpeg',
          voiceId,
          final: sequence === CHUNK_COUNT - 1,
        };
      }
    },
  };
};

const collect = async (chunks: AsyncIterable<SpeechChunk>): Promise<SpeechChunk[]> => {
  const out: SpeechChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
};

const run = (providers: TtsProvider[], overrides: Partial<Parameters<typeof speakOrText>[0]> = {}) =>
  speakOrText({
    utterance: UTTERANCE,
    settings: SETTINGS,
    providers,
    rate: RATE,
    budget: BUDGET,
    firstChunkTimeoutMs: TIMEOUT_MS,
    ...overrides,
  });

test('support provider-neutral synthesized chunks, voice ids and cancellation', async () => {
  assert.equal(selectVoiceId(PROFILE, 'b'), 'b-voice');
  assert.equal(selectVoiceId(PROFILE, 'zzz'), undefined);

  const a = fake('a');
  const result = await run([a]);
  assert.equal(result.kind, 'speech');
  if (result.kind !== 'speech') return;
  const chunks = await collect(result.chunks);
  assert.deepEqual(
    chunks.map((c) => [c.sequence, c.voiceId, c.final, c.utteranceEventId]),
    [
      [0, 'a-voice', false, 'ev-1'],
      [1, 'a-voice', false, 'ev-1'],
      [2, 'a-voice', true, 'ev-1'],
    ],
  );

  const controller = new AbortController();
  const b = fake('b');
  const cancelled = await run([b], {
    signal: controller.signal,
    settings: SETTINGS,
    utterance: { ...UTTERANCE, profile: { ...PROFILE, fallbacks: [{ providerId: 'b', voiceId: 'b-voice' }] } },
  });
  assert.equal(cancelled.kind, 'speech');
  if (cancelled.kind !== 'speech') return;
  const seen: number[] = [];
  for await (const chunk of cancelled.chunks) {
    seen.push(chunk.sequence);
    controller.abort();
  }
  assert.deepEqual(seen, [0]);
  assert.equal(b.signals[0]?.aborted, true);
});

test('unavailable or unaffordable provider gracefully chooses text output', async () => {
  assert.deepEqual(
    await run([fake('a')], { settings: { ...SETTINGS, spokenOutput: 'off', microphone: 'push-to-talk' } }),
    {
      kind: 'text',
      reason: 'voice-off',
    },
  );
  assert.deepEqual(await run([fake('a')], { settings: { ...SETTINGS, consent: { granted: false } } }), {
    kind: 'text',
    reason: 'voice-off',
  });
  assert.deepEqual(
    await run([fake('a'), fake('b')], {
      settings: {
        ...SETTINGS,
        consent: { ...SETTINGS.consent, granted: true, grantedAt: 'x', providerIds: ['other'] },
      },
    }),
    {
      kind: 'text',
      reason: 'provider-unavailable',
    },
  );
  assert.deepEqual(await run([fake('a', { healthy: false })]), { kind: 'text', reason: 'provider-unavailable' });
  assert.deepEqual(await run([]), { kind: 'text', reason: 'provider-unavailable' });
  assert.deepEqual(await run([fake('a')], { budget: 1 }), { kind: 'text', reason: 'over-budget' });
});

test('falls back to the second voice when the first throws, is unhealthy or times out', async () => {
  for (const first of [{ throwOnStart: true }, { healthy: false }, { hang: true }]) {
    const a = fake('a', first);
    const b = fake('b');
    const result = await run([a, b]);
    assert.equal(result.kind, 'speech');
    if (result.kind !== 'speech') return;
    const chunks = await collect(result.chunks);
    assert.equal(chunks[0]?.voiceId, 'b-voice');
    assert.deepEqual(b.voices, ['b-voice']);
  }
});

test('timeout on the only provider falls back to text and cancels the provider', async () => {
  const a = fake('a', { hang: true });
  const result = await run([a]);
  assert.deepEqual(result, { kind: 'text', reason: 'timeout' });
  assert.equal(a.signals[0]?.aborted, true);
});

test('caller cancellation yields text and never reaches the next provider', async () => {
  const pre = new AbortController();
  pre.abort();
  const unused = fake('a');
  assert.deepEqual(await run([unused], { signal: pre.signal }), { kind: 'text', reason: 'cancelled' });
  assert.deepEqual(unused.voices, []);

  const during = new AbortController();
  const a = fake('a', { hang: true });
  const b = fake('b');
  const pending = run([a, b], { signal: during.signal, firstChunkTimeoutMs: 1000 });
  setTimeout(() => during.abort(), TIMEOUT_MS);
  assert.deepEqual(await pending, { kind: 'text', reason: 'cancelled' });
  assert.deepEqual(b.voices, []);
});

test('completed streams leave no abort listeners behind', async () => {
  const long: TtsProvider = {
    id: 'a',
    locality: 'cloud',
    retention: 'none',
    async *synthesize(utterance, voiceId, signal) {
      providerSignal = signal;
      for (let sequence = 0; sequence < LONG_STREAM; sequence++) {
        yield {
          utteranceEventId: utterance.eventId,
          sequence,
          audio: new Uint8Array(1),
          mimeType: 'audio/mpeg',
          voiceId,
          final: false,
        };
      }
    },
  };
  let providerSignal: AbortSignal | undefined;
  const caller = new AbortController();
  const result = await run([long], { signal: caller.signal });
  assert.equal(result.kind, 'speech');
  if (result.kind !== 'speech') return;
  assert.equal((await collect(result.chunks)).length, LONG_STREAM);
  assert.equal(getEventListeners(providerSignal as AbortSignal, 'abort').length, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('rejects an invalid first chunk timeout', async () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(run([fake('a')], { firstChunkTimeoutMs: bad }), RangeError);
  }
});

test('synchronous provider throw falls through and leaves no listeners', async () => {
  const broken: TtsProvider = {
    id: 'a',
    locality: 'cloud',
    retention: 'none',
    synthesize: () => {
      throw new Error('sync');
    },
  };
  const caller = new AbortController();
  const b = fake('b');
  const result = await run([broken, b], { signal: caller.signal });
  assert.equal(result.kind, 'speech');
  if (result.kind !== 'speech') return;
  assert.equal((await collect(result.chunks)).length, CHUNK_COUNT);
  assert.deepEqual(b.voices, ['b-voice']);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('return() without iterating releases listeners and aborts the provider', async () => {
  const caller = new AbortController();
  const a = fake('a');
  const result = await run([a], { signal: caller.signal });
  assert.equal(result.kind, 'speech');
  if (result.kind !== 'speech') return;
  await result.chunks[Symbol.asyncIterator]().return?.();
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  assert.equal(a.signals[0]?.aborted, true);
});
