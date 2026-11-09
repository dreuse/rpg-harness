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

const failingFor = (failures: readonly string[], tried: string[]) => ({
  synthesize: async function* (item: CommittedUtterance): AsyncGenerator<SpeechChunk> {
    tried.push(item.profile.id);
    if (failures.includes(item.profile.id)) throw new Error(SECRET);
    yield chunk(item.eventId);
  },
});
const BACKUP: VoiceProfile = { ...PROFILE, id: 'backup' };

test('rpg-42a.98: a failed synthesis retries once with the same voice and then plays', async () => {
  const tried: string[] = [];
  const played: string[] = [];
  const metrics: SpeechMetrics[] = [];
  let attempts = 0;
  const speech = createStreamingSpeech({
    now: () => 0,
    synthesize: async function* (item) {
      attempts += 1;
      tried.push(item.profile.id);
      if (attempts === 1) throw new Error(SECRET);
      yield chunk(item.eventId);
    },
    sink: { play: async (c) => void played.push(c.utteranceEventId) },
    onMetrics: (m) => metrics.push(m),
  });
  speech.hold('t', utterance('a'), BACKUP);
  speech.commit('t');
  await speech.idle();
  assert.deepEqual(tried, ['n', 'n']);
  assert.deepEqual(played, ['a']);
  assert.ok(!metrics.some((m) => m.kind === 'error'));
});

test('rpg-42a.98: a voice that fails twice falls back to the backup profile', async () => {
  const tried: string[] = [];
  const played: string[] = [];
  const failed: string[] = [];
  const speech = createStreamingSpeech({
    now: () => 0,
    ...failingFor(['n'], tried),
    sink: { play: async (c) => void played.push(c.utteranceEventId) },
    onMetrics: () => {},
    onFailure: (item) => void failed.push(item.eventId),
  });
  speech.hold('t', utterance('a'), BACKUP);
  speech.commit('t');
  await speech.idle();
  assert.deepEqual(tried, ['n', 'n', 'backup']);
  assert.deepEqual(played, ['a']);
  assert.deepEqual(failed, []);
});

test('rpg-42a.98: when the backup voice fails too the failure is reported once and the queue goes on', async () => {
  const tried: string[] = [];
  const played: string[] = [];
  const failed: string[] = [];
  const metrics: SpeechMetrics[] = [];
  const speech = createStreamingSpeech({
    now: () => 0,
    ...failingFor(['n', 'backup'], tried),
    sink: { play: async (c) => void played.push(c.utteranceEventId) },
    onMetrics: (m) => metrics.push(m),
    onFailure: (item) => void failed.push(item.eventId),
  });
  speech.hold('t', utterance('a'), BACKUP);
  speech.hold('t', { ...utterance('b'), profile: { ...PROFILE, id: 'ok' } });
  speech.commit('t');
  await speech.idle();
  assert.deepEqual(
    tried.filter((id) => id !== 'ok'),
    ['n', 'n', 'backup'],
  );
  assert.deepEqual(played, ['b']);
  assert.deepEqual(failed, ['a']);
  assert.equal(metrics.filter((m) => m.kind === 'error').length, 1);
  assert.ok(!JSON.stringify(metrics).includes(SECRET));
});

test('segments held after commit start synthesis at once and record one first-audio per turn', async () => {
  const { speech, started, metrics, gates } = harness();
  speech.commit('t');
  speech.hold('t', utterance('a'));
  await tick();
  assert.deepEqual(started, ['a']);
  gates.get('a')?.();
  await tick();
  speech.hold('t', utterance('b'));
  await tick();
  gates.get('b')?.();
  gates.get('play-a')?.();
  await tick();
  assert.equal(metrics.filter((m) => m.kind === 'first-audio').length, 1);
});

test('reject after commit discards queued and in-flight audio of that turn and aborts what is playing', async () => {
  const { speech, started, played, gates } = harness();
  speech.commit('bad');
  for (const id of ['a', 'b', 'c']) speech.hold('bad', utterance(id));
  speech.commit('good');
  speech.hold('good', utterance('g'));
  await tick();
  gates.get('a')?.();
  await tick();
  assert.deepEqual(played, ['a']);
  speech.reject('bad');
  gates.get('b')?.();
  await tick();
  assert.ok(!played.includes('b') && !played.includes('c'));
  assert.ok(started.includes('g'));
  gates.get('g')?.();
  await tick();
  assert.deepEqual(played, ['a', 'g']);
});

test('segments held for a rejected turn are dropped and a later commit does nothing', async () => {
  const { speech, started } = harness();
  speech.reject('t');
  speech.hold('t', utterance('a'));
  speech.commit('t');
  speech.hold('t', utterance('b'));
  await tick();
  assert.deepEqual(started, []);
  assert.equal(speech.depth(), 0);
});

test('finish forgets the turn so its id can be held again', async () => {
  const { speech, started } = harness();
  speech.reject('t');
  speech.finish('t');
  speech.hold('t', utterance('a'));
  await tick();
  assert.deepEqual(started, []);
  speech.commit('t');
  await tick();
  assert.deepEqual(started, ['a']);
});

const EMPTY_PROFILE: VoiceProfile = { ...PROFILE, id: 'empty' };
const OTHER_PROFILE: VoiceProfile = { ...PROFILE, id: 'other' };

const silentHarness = (silentProfiles: readonly string[]) => {
  const played: string[] = [];
  const attempts: string[] = [];
  const metrics: SpeechMetrics[] = [];
  const failed: string[] = [];
  const speech = createStreamingSpeech({
    now: () => 0,
    synthesize: async function* (item) {
      attempts.push(item.profile.id);
      if (!silentProfiles.includes(item.profile.id)) yield chunk(item.eventId);
    },
    sink: { play: async (c) => void played.push(c.utteranceEventId) },
    onMetrics: (m) => metrics.push(m),
    onFailure: (item) => void failed.push(item.eventId),
  });
  return { speech, played, attempts, metrics, failed };
};

test('an attempt that yields no audio is retried and then falls back to the fallback profile', async () => {
  const { speech, played, attempts, failed } = silentHarness([EMPTY_PROFILE.id]);
  speech.hold('t', { ...utterance('a'), profile: EMPTY_PROFILE }, OTHER_PROFILE);
  speech.commit('t');
  await speech.idle();
  assert.deepEqual(attempts, [EMPTY_PROFILE.id, EMPTY_PROFILE.id, OTHER_PROFILE.id]);
  assert.deepEqual(played, ['a']);
  assert.deepEqual(failed, []);
});

test('an utterance that never yields audio reports an error and a failure instead of vanishing', async () => {
  const { speech, played, metrics, failed } = silentHarness([EMPTY_PROFILE.id, OTHER_PROFILE.id]);
  speech.hold('t', { ...utterance('a'), profile: EMPTY_PROFILE }, OTHER_PROFILE);
  speech.commit('t');
  await speech.idle();
  assert.deepEqual(played, []);
  assert.deepEqual(failed, ['a']);
  assert.ok(metrics.some(({ kind }) => kind === 'error'));
});

test('an aborted silent attempt is not a failure', async () => {
  const { speech, failed, metrics } = silentHarness([PROFILE.id]);
  speech.hold('t', utterance('a'));
  speech.commit('t');
  speech.reject('t');
  await speech.idle();
  assert.deepEqual(failed, []);
  assert.ok(!metrics.some(({ kind }) => kind === 'error'));
});

test('empty and whitespace-only text is never held', async () => {
  const { speech, attempts, failed } = silentHarness([]);
  speech.hold('t', { ...utterance('a'), text: '' });
  speech.hold('t', { ...utterance('b'), text: '  \n\t ' });
  speech.commit('t');
  await speech.idle();
  assert.deepEqual(attempts, []);
  assert.deepEqual(failed, []);
  assert.equal(speech.depth(), 0);
});
