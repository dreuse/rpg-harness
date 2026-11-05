import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AudioFormat,
  audioCacheKey,
  createAudioCache,
  createUsageLedger,
  speakWithBudget,
} from './audio-budget.ts';
import type { SpeechChunk, SpeechOutcome, TtsProvider } from './tts.ts';
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
const REPEAT: CommittedUtterance = { ...UTTERANCE, eventId: 'ev-2' };
const SETTINGS: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: ['a', 'b'] },
};
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 1 };
const COST = UTTERANCE.text.length;
const CHUNK_COUNT = 2;
const ROOMY_CACHE_BYTES = 1024;
const TINY_CACHE_BYTES = CHUNK_COUNT;
const TAMPER_BYTE = 255;
const FORMAT: AudioFormat = { modelVersion: 'v1', outputFormat: 'audio/wav' };

const fake = (id: string): TtsProvider & { calls: number } => {
  const provider = {
    id,
    locality: 'cloud' as const,
    retention: 'none' as const,
    calls: 0,
    async *synthesize(utterance: CommittedUtterance, voiceId: string): AsyncGenerator<SpeechChunk> {
      provider.calls++;
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
  return provider;
};

const drain = async (outcome: SpeechOutcome): Promise<SpeechChunk[]> => {
  assert.equal(outcome.kind, 'speech');
  const chunks: SpeechChunk[] = [];
  if (outcome.kind === 'speech') for await (const chunk of outcome.chunks) chunks.push(chunk);
  return chunks;
};

test('A16: cache safe repeated output and show model/voice costs and limits', async () => {
  const provider = fake('a');
  const ledger = createUsageLedger({ rate: RATE, cap: COST * 3 });
  const cache = createAudioCache(ROOMY_CACHE_BYTES);
  const base = { audioFormat: FORMAT, settings: SETTINGS, providers: [provider], ledger, cache, safeToCache: true };

  const first = await drain(await speakWithBudget({ ...base, utterance: UTTERANCE }));
  const repeat = await drain(await speakWithBudget({ ...base, utterance: REPEAT }));

  assert.equal(provider.calls, 1);
  assert.deepEqual(
    repeat.map((chunk) => [chunk.utteranceEventId, chunk.sequence, chunk.voiceId]),
    first.map((chunk) => ['ev-2', chunk.sequence, chunk.voiceId]),
  );
  assert.deepEqual(ledger.report(), {
    currency: 'USD',
    cap: COST * 3,
    spent: COST,
    remaining: COST * 2,
    entries: [{ providerId: 'a', voiceId: 'a-voice', units: COST, amount: COST, cacheHits: 1 }],
  });
});

test('A16: cache key depends on provider, model version, voice, language, delivery, format and text', () => {
  const key = audioCacheKey('a', 'a-voice', UTTERANCE, FORMAT);
  assert.equal(key, audioCacheKey('a', 'a-voice', REPEAT, FORMAT));
  assert.notEqual(key, audioCacheKey('b', 'a-voice', UTTERANCE, FORMAT));
  assert.notEqual(key, audioCacheKey('a', 'b-voice', UTTERANCE, FORMAT));
  assert.notEqual(key, audioCacheKey('a', 'a-voice', { ...UTTERANCE, text: 'other' }, FORMAT));
  assert.notEqual(key, audioCacheKey('a', 'a-voice', { ...UTTERANCE, profile: { ...PROFILE, pace: 2 } }, FORMAT));
  assert.notEqual(key, audioCacheKey('a', 'a-voice', { ...UTTERANCE, profile: { ...PROFILE, style: 'x' } }, FORMAT));
  assert.notEqual(
    key,
    audioCacheKey('a', 'a-voice', { ...UTTERANCE, profile: { ...PROFILE, language: 'pt-BR' } }, FORMAT),
  );
  assert.notEqual(key, audioCacheKey('a', 'a-voice', { ...UTTERANCE, delivery: { emotion: 'angry' } }, FORMAT));
  assert.notEqual(key, audioCacheKey('a', 'a-voice', UTTERANCE, { ...FORMAT, modelVersion: 'v2' }));
  assert.notEqual(key, audioCacheKey('a', 'a-voice', UTTERANCE, { ...FORMAT, outputFormat: 'audio/mpeg' }));
});

test('A16: full output audio is not replayed for cinematic delivery', async () => {
  const provider = fake('a');
  const cache = createAudioCache(ROOMY_CACHE_BYTES);
  const ledger = createUsageLedger({ rate: RATE });
  const base = { audioFormat: FORMAT, providers: [provider], ledger, cache, safeToCache: true };
  const delivered = { ...UTTERANCE, delivery: { emotion: 'angry', intensity: 1 } };

  await drain(
    await speakWithBudget({ ...base, settings: { ...SETTINGS, spokenOutput: 'full' }, utterance: delivered }),
  );
  await drain(
    await speakWithBudget({ ...base, settings: { ...SETTINGS, spokenOutput: 'cinematic' }, utterance: delivered }),
  );

  assert.equal(provider.calls, 2);
});

test('A16: output not marked safe is never cached', async () => {
  const provider = fake('a');
  const cache = createAudioCache(ROOMY_CACHE_BYTES);
  const ledger = createUsageLedger({ rate: RATE });
  const base = { audioFormat: FORMAT, settings: SETTINGS, providers: [provider], ledger, cache };

  await drain(await speakWithBudget({ ...base, utterance: UTTERANCE }));
  await drain(await speakWithBudget({ ...base, utterance: REPEAT }));

  assert.equal(provider.calls, 2);
  assert.equal(cache.bytes, 0);
  assert.equal(ledger.report().remaining, undefined);
  assert.equal(ledger.report().spent, COST * 2);
});

test('A16: cache evicts least recently used entries past its byte bound', () => {
  const cache = createAudioCache(TINY_CACHE_BYTES);
  const chunk = (byte: number): SpeechChunk => ({
    utteranceEventId: 'ev',
    sequence: 0,
    audio: new Uint8Array([byte]),
    mimeType: 'audio/mpeg',
    voiceId: 'v',
    final: true,
  });
  cache.set('one', [chunk(1)]);
  cache.set('two', [chunk(2)]);
  cache.get('one');
  cache.set('three', [chunk(3)]);
  cache.set('oversized', [chunk(4), chunk(5), chunk(6)]);

  assert.ok(cache.get('one'));
  assert.equal(cache.get('two'), undefined);
  assert.ok(cache.get('three'));
  assert.equal(cache.get('oversized'), undefined);
  assert.equal(cache.bytes, TINY_CACHE_BYTES);
});

test('A16: a budget cap falls back to text instead of blocking gameplay', async () => {
  const provider = fake('a');
  const ledger = createUsageLedger({ rate: RATE, cap: COST });
  const base = { audioFormat: FORMAT, settings: SETTINGS, providers: [provider], ledger };

  await drain(await speakWithBudget({ ...base, utterance: UTTERANCE }));
  const capped = await speakWithBudget({ ...base, utterance: REPEAT });

  assert.deepEqual(capped, { kind: 'text', reason: 'over-budget' });
  assert.equal(provider.calls, 1);
  assert.equal(ledger.report().remaining, 0);
});

test('A16: cached output still plays after the budget cap is reached', async () => {
  const provider = fake('a');
  const ledger = createUsageLedger({ rate: RATE, cap: COST });
  const cache = createAudioCache(ROOMY_CACHE_BYTES);
  const base = { audioFormat: FORMAT, settings: SETTINGS, providers: [provider], ledger, cache, safeToCache: true };

  await drain(await speakWithBudget({ ...base, utterance: UTTERANCE }));
  const repeat = await drain(await speakWithBudget({ ...base, utterance: REPEAT }));

  assert.equal(repeat.length, CHUNK_COUNT);
  assert.equal(ledger.report().spent, COST);
});

test('A16: cache respects voice-off settings', async () => {
  const cache = createAudioCache(ROOMY_CACHE_BYTES);
  const ledger = createUsageLedger({ rate: RATE });
  const base = { audioFormat: FORMAT, providers: [fake('a')], ledger, cache, safeToCache: true };
  await drain(await speakWithBudget({ ...base, settings: SETTINGS, utterance: UTTERANCE }));

  const off = await speakWithBudget({ ...base, settings: { ...SETTINGS, spokenOutput: 'off' }, utterance: REPEAT });

  assert.deepEqual(off, { kind: 'text', reason: 'voice-off' });
});

test('A16b: cache copies buffers on store and on replay', async () => {
  const provider = fake('a');
  const ledger = createUsageLedger({ rate: RATE });
  const cache = createAudioCache(ROOMY_CACHE_BYTES);
  const base = { audioFormat: FORMAT, settings: SETTINGS, providers: [provider], ledger, cache, safeToCache: true };

  const first = await drain(await speakWithBudget({ ...base, utterance: UTTERANCE }));
  first[0]?.audio.fill(TAMPER_BYTE);
  const replayed = await drain(await speakWithBudget({ ...base, utterance: REPEAT }));
  assert.equal(replayed[0]?.audio[0], 0);
  replayed[0]?.audio.fill(TAMPER_BYTE);
  const again = await drain(await speakWithBudget({ ...base, utterance: { ...UTTERANCE, eventId: 'ev-3' } }));
  assert.equal(again[0]?.audio[0], 0);
  assert.equal(provider.calls, 1);
});
