import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaybackSink } from '../../../packages/voice/src/playback.ts';
import type { SpeechChunk, TtsProvider } from '../../../packages/voice/src/tts.ts';
import type { CommittedUtterance, VoiceProfile } from '../../../packages/voice/src/voice.ts';
import {
  createLiveSpeechRuntime,
  createSpeechRuntime,
  liveProviders,
  prepareVoice,
  takePreloadFailureNotice,
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
  assert.deepEqual(ids('mlx'), ['kokoro', MLX_ID]);
  assert.deepEqual(ids('onnx'), ['kokoro', 'kokoro-onnx']);
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
