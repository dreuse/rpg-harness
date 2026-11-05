import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKokoroProvider, KOKORO_PROVIDER_ID, type KokoroEngine } from './kokoro-provider.ts';
import { type SpeechChunk, speakOrText, type TtsProvider } from './tts.ts';
import { TTS_COOL_DOWN_MS, TTS_FAILURE_THRESHOLD, TTS_MAX_RETRIES, withCircuitBreaker } from './tts-circuit-breaker.ts';
import type { CommittedUtterance, VoiceProfile, VoiceSettings } from './voice.ts';

const SYSTEM_ID = 'system-speech';
const PROFILE: VoiceProfile = {
  id: 'narrator',
  language: 'en-US',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [
    { providerId: KOKORO_PROVIDER_ID, voiceId: 'af_heart' },
    { providerId: SYSTEM_ID, voiceId: 'default' },
  ],
};
const UTTERANCE: CommittedUtterance = { text: 'Hello there.', speakerId: 'gm', eventId: 'ev-1', profile: PROFILE };
const SETTINGS: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: [KOKORO_PROVIDER_ID, SYSTEM_ID] },
};
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 1;
const TIMEOUT_MS = 50;
const CHUNK: Omit<SpeechChunk, 'voiceId'> = {
  utteranceEventId: 'ev-1',
  sequence: 0,
  audio: new Uint8Array([1]),
  mimeType: 'audio/wav',
  final: true,
};

interface Scripted extends TtsProvider {
  attempts: number;
}

const scripted = (outcomes: readonly ('fail' | 'ok')[], id = KOKORO_PROVIDER_ID): Scripted => {
  const provider: Scripted = {
    id,
    locality: 'local',
    retention: 'none',
    attempts: 0,
    async *synthesize(_utterance, voiceId) {
      const outcome = outcomes[provider.attempts] ?? outcomes.at(-1);
      provider.attempts += 1;
      if (outcome === 'fail') throw new Error('engine failed');
      yield { ...CHUNK, voiceId };
    },
  };
  return provider;
};

const clock = () => {
  const state = { now: 0 };
  return { state, now: () => state.now };
};

const drain = async (provider: TtsProvider, signal = new AbortController().signal): Promise<SpeechChunk[]> => {
  const out: SpeechChunk[] = [];
  for await (const chunk of provider.synthesize(UTTERANCE, 'af_heart', signal)) out.push(chunk);
  return out;
};

const failTimes = async (provider: TtsProvider, times: number): Promise<void> => {
  for (let index = 0; index < times; index++) await assert.rejects(drain(provider));
};

test('retries a failed start a bounded number of times', async () => {
  const inner = scripted(['fail']);
  await assert.rejects(drain(withCircuitBreaker(inner)), /engine failed/);
  assert.equal(inner.attempts, TTS_MAX_RETRIES + 1);
});

test('recovers from a transient failure through a retry', async () => {
  const inner = scripted(['fail', 'ok']);
  assert.equal((await drain(withCircuitBreaker(inner))).length, 1);
});

test('opens after repeated failures, then half-opens after the cool-down', async () => {
  const time = clock();
  const breaker = withCircuitBreaker(scripted(['fail']), { now: time.now });
  await failTimes(breaker, TTS_FAILURE_THRESHOLD - 1);
  assert.equal(breaker.healthy?.(), true);
  await failTimes(breaker, 1);
  assert.equal(breaker.healthy?.(), false);
  time.state.now = TTS_COOL_DOWN_MS;
  assert.equal(breaker.healthy?.(), true);
  await failTimes(breaker, 1);
  assert.equal(breaker.healthy?.(), false);
});

test('a success closes the breaker', async () => {
  const time = clock();
  const outcomes: ('fail' | 'ok')[] = [];
  for (let index = 0; index < TTS_FAILURE_THRESHOLD * (TTS_MAX_RETRIES + 1); index++) outcomes.push('fail');
  const breaker = withCircuitBreaker(scripted([...outcomes, 'ok']), { now: time.now });
  await failTimes(breaker, TTS_FAILURE_THRESHOLD);
  time.state.now = TTS_COOL_DOWN_MS;
  assert.equal((await drain(breaker)).length, 1);
  assert.equal(breaker.healthy?.(), true);
});

test('reports the wrapped provider as unhealthy', () => {
  const breaker = withCircuitBreaker({ ...scripted(['ok']), healthy: () => false });
  assert.equal(breaker.healthy?.(), false);
});

test('a cancelled synthesis neither retries nor counts as a failure', async () => {
  const inner = scripted(['fail']);
  const breaker = withCircuitBreaker(inner, { failureThreshold: 1 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(drain(breaker, controller.signal));
  assert.equal(inner.attempts, 1);
  assert.equal(breaker.healthy?.(), true);
});

const brokenEngine = (): KokoroEngine & { loads: number } => {
  const engine = {
    loads: 0,
    ready: () => true,
    load: async () => {
      engine.loads += 1;
      throw new Error('model missing');
    },
    synthesize: async () => new Uint8Array(),
    unload: async () => {},
  };
  return engine;
};

const speak = (providers: TtsProvider[]) =>
  speakOrText({
    utterance: UTTERANCE,
    settings: SETTINGS,
    providers,
    rate: RATE,
    budget: BUDGET,
    firstChunkTimeoutMs: TIMEOUT_MS,
  });

test('speakOrText falls back to system speech when Kokoro fails', async () => {
  const kokoro = withCircuitBreaker(createKokoroProvider({ engine: brokenEngine() }));
  const system = scripted(['ok'], SYSTEM_ID);
  const outcome = await speak([kokoro, system]);
  assert.equal(outcome.kind, 'speech');
  assert.equal(system.attempts, 1);
});

test('speakOrText falls back to text when Kokoro fails and no other provider exists', async () => {
  const kokoro = withCircuitBreaker(createKokoroProvider({ engine: brokenEngine() }));
  assert.deepEqual(await speak([kokoro]), { kind: 'text', reason: 'provider-error' });
});

test('speakOrText skips Kokoro while its breaker is open', async () => {
  const engine = brokenEngine();
  const kokoro = withCircuitBreaker(createKokoroProvider({ engine }), { now: () => 0 });
  for (let index = 0; index < TTS_FAILURE_THRESHOLD; index++) await speak([kokoro]);
  const loads = engine.loads;
  assert.equal(kokoro.healthy?.(), false);
  const system = scripted(['ok'], SYSTEM_ID);
  assert.equal((await speak([kokoro, system])).kind, 'speech');
  assert.equal(engine.loads, loads);
  assert.deepEqual(await speak([kokoro]), { kind: 'text', reason: 'provider-unavailable' });
});
