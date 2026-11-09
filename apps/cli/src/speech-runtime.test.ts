import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { audioCacheKey } from '../../../packages/voice/src/audio-budget.ts';
import { createFileAudioCache } from '../../../packages/voice/src/audio-cache-store.ts';
import { KOKORO_MODEL_SOURCE } from '../../../packages/voice/src/kokoro-model.ts';
import { KOKORO_MIME_TYPE, KOKORO_PROVIDER_ID } from '../../../packages/voice/src/kokoro-provider.ts';
import type { PlaybackSink } from '../../../packages/voice/src/playback.ts';
import type { SpeechChunk, TtsProvider } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance, VoiceProfile } from '../../../packages/voice/src/voice.ts';
import {
  createLiveSpeechRuntime,
  createSpeechRuntime,
  liveProviders,
  optedInNarrator,
  PREFERENCES_FILE,
  prepareVoice,
  takePreloadFailureNotice,
  withOptedInNarrator,
} from './speech-runtime.ts';

const SECRET = 'secret campaign words';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const profileWith = (providerId: string): VoiceProfile => ({
  id: 'narrator',
  language: 'en',
  pace: 1,
  style: '',
  pronunciations: {},
  fallbacks: [{ providerId, voiceId: 'voice-1' }],
});
const utterance = (providerId: string): CommittedUtterance => ({
  text: SECRET,
  speakerId: 'narrator',
  eventId: 'event-1',
  profile: profileWith(providerId),
});
const provider = (id: string, healthy = true): TtsProvider => ({
  id,
  locality: 'local',
  retention: 'none',
  healthy: () => healthy,
  async *synthesize(item, voiceId): AsyncGenerator<SpeechChunk> {
    yield {
      utteranceEventId: item.eventId,
      sequence: 0,
      audio: new Uint8Array([1]),
      mimeType: 'audio/wav',
      voiceId,
      final: true,
    };
  },
});
const sinkOf = (played: string[]): PlaybackSink => ({
  play: async (chunk) => void played.push(chunk.voiceId),
});

test('speaks through the provider named by the speaker profile', async () => {
  const played: string[] = [];
  const runtime = createSpeechRuntime({ providers: [provider('other'), provider('kokoro')], sink: sinkOf(played) });
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(played, ['voice-1']);
});

test('a provider that is not healthy keeps the line in text', async () => {
  const played: string[] = [];
  const runtime = createSpeechRuntime({ providers: [provider('kokoro', false)], sink: sinkOf(played) });
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(played, []);
});

test('rpg-asjw.20 a provider that is not healthy hands the line to the next healthy fallback', async () => {
  const played: string[] = [];
  const runtime = createSpeechRuntime({
    providers: [provider('mlx', false), provider('kokoro')],
    sink: sinkOf(played),
  });
  const line = utterance('mlx');
  runtime.speech.hold('t', {
    ...line,
    profile: {
      ...line.profile,
      fallbacks: [
        { providerId: 'mlx', voiceId: 'dora' },
        { providerId: 'kokoro', voiceId: 'heart' },
      ],
    },
  });
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(played, ['heart']);
  assert.equal(runtime.takeFailureNotice(), undefined);
});

test('rpg-asjw.20 a provider that yields nothing hands the line to the next fallback', async () => {
  const played: string[] = [];
  const silent: TtsProvider = { ...provider('mlx'), synthesize: async function* () {} };
  const runtime = createSpeechRuntime({ providers: [silent, provider('kokoro')], sink: sinkOf(played) });
  const line = utterance('mlx');
  runtime.speech.hold('t', {
    ...line,
    profile: {
      ...line.profile,
      fallbacks: [
        { providerId: 'mlx', voiceId: 'dora' },
        { providerId: 'kokoro', voiceId: 'heart' },
      ],
    },
  });
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(played, ['heart']);
});

test('rpg-asjw.34 a provider that throws before yielding hands the line to the next fallback', async () => {
  const played: string[] = [];
  const broken: TtsProvider = {
    ...provider('mlx'),
    synthesize: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('engine crashed')),
      }),
    }),
  };
  const runtime = createSpeechRuntime({ providers: [broken, provider('kokoro')], sink: sinkOf(played) });
  const line = utterance('mlx');
  runtime.speech.hold('t', {
    ...line,
    profile: {
      ...line.profile,
      fallbacks: [
        { providerId: 'mlx', voiceId: 'dora' },
        { providerId: 'kokoro', voiceId: 'heart' },
      ],
    },
  });
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(played, ['heart']);
  assert.equal(runtime.takeFailureNotice(), undefined);
});

test('rpg-asjw.20 a line no healthy provider can read gives a notice in the interface language', async () => {
  const runtime = createSpeechRuntime({ providers: [provider('kokoro', false)], sink: sinkOf([]) });
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.match(runtime.takeFailureNotice('pt-BR') ?? '', /não pôde ser lida em voz alta/);
  assert.equal(runtime.takeFailureNotice(), undefined);
});

test('metrics reach the voice diagnostics without campaign text', async () => {
  const runtime = createSpeechRuntime({ providers: [provider('kokoro')], sink: sinkOf([]) });
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  await tick();
  const summary = runtime.diagnostics.summary();
  assert.equal(summary.samples, 1);
  assert.ok(summary.firstAudioMs !== undefined);
  assert.ok(summary.peakQueueDepth !== undefined && summary.peakQueueDepth >= 1);
  assert.ok(!JSON.stringify(summary).includes(SECRET));
});

test('a failing provider is counted as an error and does not throw', async () => {
  const failing: TtsProvider = {
    ...provider('kokoro'),
    synthesize: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(SECRET)) }) }),
  };
  const runtime = createSpeechRuntime({ providers: [failing], sink: sinkOf([]) });
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(
    Object.values(runtime.diagnostics.summary().errors).reduce((sum, count) => sum + (count ?? 0), 0),
    1,
  );
  assert.ok(!JSON.stringify(runtime.diagnostics.summary()).includes(SECRET));
});

test('rpg-42a.98: a line no voice could read gives one notice for the next turn', async () => {
  const failing: TtsProvider = {
    ...provider('kokoro'),
    synthesize: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(SECRET)) }) }),
  };
  const runtime = createSpeechRuntime({ providers: [failing], sink: sinkOf([]) });
  assert.equal(runtime.takeFailureNotice(), undefined);
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.hold('t', { ...utterance('kokoro'), eventId: 'event-2' });
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.match(runtime.takeFailureNotice() ?? '', /could not be read aloud/);
  assert.equal(runtime.takeFailureNotice(), undefined);
});

test('dispose stops playback and disposes the sink', async () => {
  const disposed: string[] = [];
  const runtime = createSpeechRuntime({
    providers: [provider('kokoro')],
    sink: { play: () => new Promise<void>(() => {}), dispose: () => void disposed.push('sink') },
  });
  const before = runtime.speech.generation();
  runtime.dispose();
  assert.deepEqual(disposed, ['sink']);
  assert.equal(runtime.speech.generation(), before + 1);
});

test('the live runtime builds without a model and keeps lines in text', async () => {
  const runtime = createLiveSpeechRuntime('/nonexistent-data-dir', {});
  runtime.speech.hold('t', utterance('kokoro'));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.equal(runtime.diagnostics.summary().samples, 0);
  runtime.dispose();
});

const MLX_ID = 'kokoro-mlx';
const PT_BR = 'pt-BR';
const ROUTE = 'mlx';
const withPreload = (id: string, preload: () => Promise<void>) => ({ ...provider(id), preload });

test('rpg-cm63.53 live providers pick the pt-BR route: mlx where supported, ONNX elsewhere', () => {
  const ids = (route: 'mlx' | 'onnx') => liveProviders('/data', {}, route).map(({ id }) => id);
  assert.deepEqual(ids('mlx'), ['kokoro', MLX_ID, 'chatterbox', 'f5-tts']);
  assert.deepEqual(ids('onnx'), ['kokoro', 'kokoro-onnx', 'chatterbox', 'f5-tts']);
});

test('a pt-BR campaign preloads the mlx voice without waiting for it', () => {
  const calls: string[] = [];
  const never = withPreload(MLX_ID, () => new Promise<void>(() => calls.push('preload')));
  assert.equal(prepareVoice([never], PT_BR, ROUTE), undefined);
  assert.deepEqual(calls, ['preload']);
});

test('a failing preload does not break play', async () => {
  const failing = withPreload(MLX_ID, () => Promise.reject(new Error('cold start failed')));
  assert.equal(prepareVoice([failing], PT_BR, ROUTE), undefined);
  await tick();
});

test('an English campaign does not preload the mlx voice', () => {
  const calls: string[] = [];
  const mlx = withPreload(MLX_ID, async () => void calls.push('preload'));
  prepareVoice([mlx], 'en', ROUTE);
  assert.deepEqual(calls, []);
});

test('a pt-BR campaign without the mlx voice gets the player notice', () => {
  assert.match(prepareVoice([provider('kokoro')], PT_BR, ROUTE) ?? '', /not available on this computer/);
});

test('rpg-42a.117 voice notices read in the interface language', async () => {
  assert.match(
    prepareVoice([provider('kokoro')], PT_BR, ROUTE, 'pt-BR') ?? '',
    /não estão disponíveis neste computador/,
  );
  const failing = withPreload(MLX_ID, () => Promise.reject(new Error('cold start failed')));
  prepareVoice([failing], PT_BR, ROUTE);
  await tick();
  assert.match(
    takePreloadFailureNotice([failing], PT_BR, ROUTE, 'pt-BR') ?? '',
    /não estão disponíveis neste computador/,
  );
});

test('dispose also disposes every provider', () => {
  const disposed: string[] = [];
  const hosted = { ...provider(MLX_ID), dispose: async () => void disposed.push(MLX_ID) };
  const runtime = createSpeechRuntime({
    providers: [provider('kokoro'), hosted],
    sink: { play: () => new Promise<void>(() => {}) },
  });
  runtime.dispose();
  assert.deepEqual(disposed, [MLX_ID]);
});

test('an unhealthy mlx voice is not preloaded', () => {
  const calls: string[] = [];
  const mlx = { ...withPreload(MLX_ID, async () => void calls.push('preload')), healthy: () => false };
  prepareVoice([mlx], PT_BR, ROUTE);
  assert.deepEqual(calls, []);
});

test('a failed preload yields the voice notice once, on a later turn', async () => {
  const failing = withPreload(MLX_ID, () => Promise.reject(new Error('cold start failed')));
  assert.equal(takePreloadFailureNotice([failing], PT_BR, ROUTE), undefined);
  prepareVoice([failing], PT_BR, ROUTE);
  await tick();
  assert.match(takePreloadFailureNotice([failing], PT_BR, ROUTE) ?? '', /not available on this computer/);
  assert.equal(takePreloadFailureNotice([failing], PT_BR, ROUTE), undefined);
});

test('a healthy preload yields no failure notice', async () => {
  const mlx = withPreload(MLX_ID, async () => undefined);
  prepareVoice([mlx], PT_BR, ROUTE);
  await tick();
  assert.equal(takePreloadFailureNotice([mlx], PT_BR, ROUTE), undefined);
});

const CACHE_BYTES = 1024 * 1024;
const countingProvider = (id: string, calls: string[]): TtsProvider => ({
  ...provider(id),
  async *synthesize(item, voiceId, signal) {
    calls.push(item.text);
    yield* provider(id).synthesize(item, voiceId, signal);
  },
});
const cacheOptions = (dir: string) => ({ cache: createFileAudioCache(dir, CACHE_BYTES) });

test('rpg-cm63.54 a live synthesis is stored so the next speak of the same line skips the provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-cache-'));
  const calls: string[] = [];
  const played: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const runtime = createSpeechRuntime({
      providers: [countingProvider(KOKORO_PROVIDER_ID, calls)],
      sink: sinkOf(played),
      ...cacheOptions(dir),
    });
    runtime.speech.hold('t', utterance(KOKORO_PROVIDER_ID));
    runtime.speech.commit('t');
    await runtime.speech.idle();
  }
  assert.deepEqual(calls, [SECRET]);
  assert.deepEqual(played, ['voice-1', 'voice-1']);
  rmSync(dir, { recursive: true, force: true });
});

test('rpg-cm63.54 the live cache entry is the one a replay of the same line looks up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-cache-'));
  const replayCache = createFileAudioCache(dir, CACHE_BYTES);
  const runtime = createSpeechRuntime({
    providers: [provider(KOKORO_PROVIDER_ID)],
    sink: sinkOf([]),
    ...cacheOptions(dir),
  });
  runtime.speech.hold('t', utterance(KOKORO_PROVIDER_ID));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  const key = audioCacheKey(KOKORO_PROVIDER_ID, 'voice-1', utterance(KOKORO_PROVIDER_ID), {
    modelVersion: KOKORO_MODEL_SOURCE,
    outputFormat: KOKORO_MIME_TYPE,
  });
  assert.equal(replayCache.get(key)?.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('rpg-cm63.54 a broken cache never stops speech', async () => {
  const played: string[] = [];
  const broken = {
    bytes: 0,
    get: () => {
      throw new Error('disk gone');
    },
    set: () => {
      throw new Error('disk full');
    },
  };
  const runtime = createSpeechRuntime({
    providers: [provider(KOKORO_PROVIDER_ID)],
    sink: sinkOf(played),
    cache: broken,
  });
  runtime.speech.hold('t', utterance(KOKORO_PROVIDER_ID));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  assert.deepEqual(played, ['voice-1']);
  assert.equal(runtime.takeFailureNotice(), undefined);
});

test('rpg-cm63.54 a synthesis aborted midway is not cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-cache-'));
  const cache = createFileAudioCache(dir, CACHE_BYTES);
  const aborting: TtsProvider = {
    ...provider(KOKORO_PROVIDER_ID),
    async *synthesize(item, voiceId, signal) {
      yield* provider(KOKORO_PROVIDER_ID).synthesize(item, voiceId, signal);
      runtime.speech.stop();
    },
  };
  const runtime = createSpeechRuntime({ providers: [aborting], sink: sinkOf([]), cache });
  runtime.speech.hold('t', utterance(KOKORO_PROVIDER_ID));
  runtime.speech.commit('t');
  await runtime.speech.idle();
  const key = audioCacheKey(KOKORO_PROVIDER_ID, 'voice-1', utterance(KOKORO_PROVIDER_ID), {
    modelVersion: KOKORO_MODEL_SOURCE,
    outputFormat: KOKORO_MIME_TYPE,
  });
  assert.equal(cache.get(key), undefined);
  rmSync(dir, { recursive: true, force: true });
});

const F5_ID = 'f5-tts';
const CHATTERBOX_ID = 'chatterbox';
const PT_BR_LANGUAGE = 'pt-BR';
const throwing = (id: string): TtsProvider => ({
  ...provider(id),
  synthesize: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('service down')) }) }),
});
const preferences = (speech: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-prefs-'));
  writeFileSync(join(dir, PREFERENCES_FILE), JSON.stringify({ speech }));
  return dir;
};
const spokenWithChoice = async (providers: TtsProvider[], providerId: string) => {
  const dir = preferences({ providerId, volume: 1, npcVoices: {} });
  const base = { ...profileWith(KOKORO_PROVIDER_ID), language: PT_BR_LANGUAGE };
  const chosen = withOptedInNarrator(base, optedInNarrator(dir, PT_BR_LANGUAGE));
  rmSync(dir, { recursive: true });
  const played: string[] = [];
  const runtime = createSpeechRuntime({ providers, sink: sinkOf(played) });
  runtime.speech.hold('t', { ...utterance(KOKORO_PROVIDER_ID), profile: chosen }, base);
  runtime.speech.commit('t');
  await runtime.speech.idle();
  return { played, chosen };
};

test('rpg-cm63.55 a saved f5-tts choice puts it first and keeps kokoro behind it', async () => {
  const { played, chosen } = await spokenWithChoice([provider(F5_ID), provider(KOKORO_PROVIDER_ID)], F5_ID);
  assert.deepEqual(
    chosen.fallbacks.map(({ providerId }) => providerId),
    [F5_ID, KOKORO_PROVIDER_ID],
  );
  assert.deepEqual(played, ['f5-pt-f1']);
});

for (const [name, providers] of [
  ['not installed', [provider(KOKORO_PROVIDER_ID)]],
  ['unhealthy', [provider(F5_ID, false), provider(KOKORO_PROVIDER_ID)]],
  ['failing', [throwing(F5_ID), provider(KOKORO_PROVIDER_ID)]],
] as const) {
  test(`rpg-cm63.55 a saved f5-tts choice that is ${name} still plays kokoro`, async () => {
    const { played } = await spokenWithChoice([...providers], F5_ID);
    assert.deepEqual(played, ['voice-1']);
  });
}

test('rpg-cm63.55 only the opt-in providers that speak the language are chosen from the saved preferences', () => {
  const choice = (speech: object, language = PT_BR_LANGUAGE) => optedInNarrator(preferences(speech), language);
  assert.deepEqual(choice({ providerId: CHATTERBOX_ID }), { providerId: CHATTERBOX_ID, voiceId: 'chatterbox-default' });
  assert.equal(choice({ providerId: F5_ID, narratorVoice: 'f5-pt-m2' })?.voiceId, 'f5-pt-m2');
  assert.equal(choice({ providerId: F5_ID, narratorVoice: 'unknown' })?.voiceId, 'f5-pt-f1');
  assert.equal(choice({ providerId: F5_ID }, 'en'), undefined);
  assert.equal(choice({ providerId: KOKORO_PROVIDER_ID }), undefined);
  assert.equal(choice({}), undefined);
  assert.equal(optedInNarrator('/missing', PT_BR_LANGUAGE), undefined);
});
