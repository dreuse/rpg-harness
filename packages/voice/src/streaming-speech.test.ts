import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStreamingSpeech, MIN_SEGMENT_CHARS, type SpeechMetrics, segmentDeltas } from './streaming-speech.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance, VoiceProfile } from './voice.ts';

const PROFILE: VoiceProfile = { id: 'n', language: 'en-GB', pace: 1, style: 'calm', pronunciations: {}, fallbacks: [] };
const SECRET = 'secret campaign words';
const SENTENCE = 'The door creaks open slowly. ';
const SHORT_FIRST = 'Hi. ';
const DEPTH_PLUS_ONE = 3;

const utterance = (eventId: string): CommittedUtterance => ({
  text: `${SECRET} ${eventId}`,
  speakerId: 'gm',
  eventId,
  profile: PROFILE,
});
const chunk = (eventId: string): SpeechChunk => ({
  utteranceEventId: eventId,
  sequence: 0,
  audio: new Uint8Array(1),
  mimeType: 'audio/wav',
  voiceId: 'v',
  final: true,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function* fakeStream(parts: readonly string[]) {
  for (const part of parts) yield part;
}
const collect = async (source: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const item of source) out.push(item);
  return out;
};

test('segmentDeltas emits a segment as soon as a sentence closes past the minimum length', async () => {
  const seen: string[] = [];
  const parts = [SENTENCE.slice(0, 10), SENTENCE.slice(10), 'Next one is here.'];
  for await (const segment of segmentDeltas(fakeStream(parts))) seen.push(segment);
  assert.deepEqual(seen, [SENTENCE.trim(), 'Next one is here.']);
});

test('segmentDeltas merges sentences shorter than the minimum and flushes the tail', async () => {
  const out = await collect(segmentDeltas(fakeStream([SHORT_FIRST, SENTENCE, 'tail'])));
  assert.equal(out.length, 2);
  assert.ok((out[0] ?? '').length >= MIN_SEGMENT_CHARS);
  assert.equal(out[1], 'tail');
});

const harness = () => {
  const played: string[] = [];
  const started: string[] = [];
  const metrics: SpeechMetrics[] = [];
  const gates = new Map<string, () => void>();
  let clock = 0;
  const speech = createStreamingSpeech({
    now: () => (clock += 10),
    synthesize: async function* (item, signal) {
      started.push(item.eventId);
      await new Promise<void>((resolve) => {
        gates.set(item.eventId, resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (!signal.aborted) yield chunk(item.eventId);
    },
    sink: {
      play: async (c, _speed, signal) => {
        played.push(c.utteranceEventId);
        await new Promise<void>((resolve) => {
          gates.set(`play-${c.utteranceEventId}`, resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    onMetrics: (m) => metrics.push(m),
  });
  return { speech, played, started, metrics, gates };
};

test('uncommitted segments are held; commit releases and prefetch overlaps playback', async () => {
  const { speech, started, played, gates } = harness();
  const turn = 't1';
  for (const id of ['a', 'b', 'c', 'd']) speech.hold(turn, utterance(id));
  await tick();
  assert.deepEqual(started, []);
  speech.commit(turn);
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  gates.get('a')?.();
  await tick();
  assert.deepEqual(played, ['a']);
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.ok(DEPTH_PLUS_ONE >= started.length);
  gates.get('b')?.();
  await tick();
  assert.deepEqual(played, ['a'], 'voices never overlap; b waits for a');
  gates.get('play-a')?.();
  await tick();
  assert.deepEqual(played, ['a', 'b']);
});

test('reject discards held segments so nothing is synthesised', async () => {
  const { speech, started } = harness();
  speech.hold('t', utterance('a'));
  speech.reject('t');
  speech.commit('t');
  await tick();
  assert.deepEqual(started, []);
});

test('stop cancels in-flight and queued work and drops stale audio via generation', async () => {
  const { speech, played, gates } = harness();
  const before = speech.generation();
  for (const id of ['a', 'b', 'c']) speech.hold('t', utterance(id));
  speech.commit('t');
  await tick();
  speech.stop();
  gates.get('a')?.();
  gates.get('b')?.();
  await tick();
  assert.deepEqual(played, []);
  assert.equal(speech.generation(), before + 1);
  assert.equal(speech.depth(), 0);
});

test('skip drops the current segment only; pause holds playback until resume', async () => {
  const { speech, played, gates } = harness();
  for (const id of ['a', 'b']) speech.hold('t', utterance(id));
  speech.commit('t');
  await tick();
  gates.get('a')?.();
  await tick();
  speech.skip();
  gates.get('b')?.();
  await tick();
  assert.deepEqual(played, ['a', 'b']);
  gates.get('play-b')?.();
  await tick();
  speech.pause();
  speech.hold('u', utterance('c'));
  speech.commit('u');
  await tick();
  gates.get('c')?.();
  await tick();
  assert.deepEqual(played, ['a', 'b']);
  speech.resume();
  await tick();
  assert.deepEqual(played, ['a', 'b', 'c']);
});

test('metrics record first audio, synthesis time and queue depth without campaign text', async () => {
  const { speech, metrics, gates } = harness();
  speech.hold('t', utterance('a'));
  speech.commit('t');
  await tick();
  gates.get('a')?.();
  await tick();
  const kinds = metrics.map((m) => m.kind);
  assert.ok(kinds.includes('queue-depth') && kinds.includes('synthesis') && kinds.includes('first-audio'));
  assert.ok(!JSON.stringify(metrics).includes(SECRET));
  const first = metrics.find((m) => m.kind === 'first-audio');
  assert.ok(first && first.ms > 0);
});

test('pause and resume are forwarded to a sink that can pause mid-play', async () => {
  const calls: string[] = [];
  const speech = createStreamingSpeech({
    now: () => 0,
    synthesize: async function* (item) {
      yield chunk(item.eventId);
    },
    sink: {
      play: () => new Promise<void>(() => {}),
      pause: () => void calls.push('pause'),
      resume: () => void calls.push('resume'),
    },
    onMetrics: () => {},
  });
  speech.hold('t', utterance('a'));
  speech.commit('t');
  await tick();
  speech.pause();
  speech.resume();
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('each turn gets its own first-audio metric', async () => {
  const { speech, metrics, gates } = harness();
  speech.hold('t1', utterance('a'));
  speech.commit('t1');
  await tick();
  speech.hold('t2', utterance('b'));
  speech.commit('t2');
  await tick();
  gates.get('a')?.();
  await tick();
  gates.get('play-a')?.();
  gates.get('b')?.();
  await tick();
  assert.equal(metrics.filter((m) => m.kind === 'first-audio').length, 2);
});

test('a failing synthesis emits an error metric without text', async () => {
  const metrics: SpeechMetrics[] = [];
  const speech = createStreamingSpeech({
    now: () => 0,
    synthesize: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error(SECRET)),
      }),
    }),
    sink: { play: async () => {} },
    onMetrics: (m) => metrics.push(m),
  });
  speech.hold('t', utterance('a'));
  speech.commit('t');
  await tick();
  assert.ok(metrics.some((m) => m.kind === 'error'));
  assert.ok(!JSON.stringify(metrics).includes(SECRET));
});
