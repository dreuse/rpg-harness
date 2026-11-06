import type { PlaybackSink } from './playback.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance, VoiceProfile } from './voice.ts';

export const MIN_SEGMENT_CHARS = 24;
export const PREFETCH_DEPTH = 2;
const SENTENCE_END = /[.!?…]["')\]]*\s/;
const SPEED = 1;
type TurnState = 'open' | 'rejected';

export type SpeechMetrics =
  | { readonly kind: 'first-audio'; readonly ms: number }
  | { readonly kind: 'synthesis'; readonly ms: number }
  | { readonly kind: 'queue-depth'; readonly depth: number }
  | { readonly kind: 'error' };

export async function* segmentDeltas(deltas: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const delta of deltas) {
    buffer += delta;
    for (;;) {
      const closed = findClose(buffer);
      if (closed === undefined) break;
      yield buffer.slice(0, closed).trim();
      buffer = buffer.slice(closed);
    }
  }
  const tail = buffer.trim();
  if (tail !== '') yield tail;
}

const findClose = (buffer: string): number | undefined => {
  let offset = 0;
  for (;;) {
    const match = SENTENCE_END.exec(buffer.slice(offset));
    if (!match) return undefined;
    const end = offset + match.index + match[0].length;
    if (buffer.slice(0, end).trim().length >= MIN_SEGMENT_CHARS) return end;
    offset = end;
  }
};

export interface StreamingSpeechDeps {
  readonly synthesize: (utterance: CommittedUtterance, signal: AbortSignal) => AsyncIterable<SpeechChunk>;
  readonly sink: PlaybackSink;
  readonly onMetrics: (metrics: SpeechMetrics) => void;
  readonly onFailure?: (utterance: CommittedUtterance) => void;
  readonly now: () => number;
}

export interface StreamingSpeech {
  hold(turnId: string, utterance: CommittedUtterance, fallback?: VoiceProfile): void;
  commit(turnId: string): void;
  reject(turnId: string): void;
  finish(turnId: string): void;
  pause(): void;
  resume(): void;
  skip(): void;
  stop(): void;
  generation(): number;
  depth(): number;
  idle(): Promise<void>;
}

interface Entry {
  readonly utterance: CommittedUtterance;
  readonly turnId: string;
}

interface Job {
  readonly turnId: string;
  readonly utterance: CommittedUtterance;
  readonly controller: AbortController;
  readonly chunks: Promise<SpeechChunk[]>;
}

export const createStreamingSpeech = (deps: StreamingSpeechDeps): StreamingSpeech => {
  const held = new Map<string, CommittedUtterance[]>();
  const fallbacks = new WeakMap<CommittedUtterance, VoiceProfile>();
  const waiting: Entry[] = [];
  const jobs: Job[] = [];
  let generation = 0;
  let paused = false;
  let wake = () => {};
  let skipController: AbortController | undefined;
  let draining: Promise<void> | undefined;
  const startedAt = new Map<string, number>();
  const turns = new Map<string, TurnState>();
  const timed = new Set<string>();
  let playing: { readonly turnId: string; readonly controller: AbortController } | undefined;

  const depth = () => waiting.length + jobs.length;

  const startJob = ({ utterance, turnId }: Entry): Job => {
    const controller = new AbortController();
    const begun = deps.now();
    const fallback = fallbacks.get(utterance);
    const attempts = [utterance, utterance, ...(fallback === undefined ? [] : [{ ...utterance, profile: fallback }])];
    const collect = async (): Promise<SpeechChunk[]> => {
      for (const attempt of attempts) {
        const out: SpeechChunk[] = [];
        try {
          for await (const item of deps.synthesize(attempt, controller.signal)) out.push(item);
          deps.onMetrics({ kind: 'synthesis', ms: deps.now() - begun });
          return out;
        } catch {
          if (controller.signal.aborted) return [];
        }
      }
      deps.onMetrics({ kind: 'error' });
      deps.onFailure?.(utterance);
      return [];
    };
    return { turnId, utterance, controller, chunks: collect() };
  };

  const enqueue = (turnId: string, items: readonly CommittedUtterance[]) => {
    if (items.length === 0) return;
    if (!timed.has(turnId) && !startedAt.has(turnId)) startedAt.set(turnId, deps.now());
    waiting.push(...items.map((utterance) => ({ utterance, turnId })));
    deps.onMetrics({ kind: 'queue-depth', depth: depth() });
    draining ??= drain();
  };

  const fill = () => {
    while (jobs.length < PREFETCH_DEPTH && waiting.length > 0) jobs.push(startJob(waiting.shift() as Entry));
  };

  const untilResumed = async () => {
    while (paused) await new Promise<void>((resolve) => (wake = resolve));
  };

  const drain = async (): Promise<void> => {
    try {
      for (fill(); jobs.length > 0; fill()) {
        const job = jobs[0] as Job;
        const mine = generation;
        const chunks = await job.chunks;
        if (mine !== generation || jobs[0] !== job) continue;
        jobs.shift();
        fill();
        const controller = new AbortController();
        skipController = controller;
        playing = { turnId: job.turnId, controller };
        for (const item of chunks) {
          await untilResumed();
          if (mine !== generation || controller.signal.aborted) break;
          const began = startedAt.get(job.turnId);
          if (began !== undefined) {
            deps.onMetrics({ kind: 'first-audio', ms: deps.now() - began });
            startedAt.delete(job.turnId);
            if (turns.has(job.turnId)) timed.add(job.turnId);
          }
          await deps.sink.play(item, SPEED, controller.signal).catch(() => undefined);
        }
      }
    } finally {
      playing = undefined;
      skipController = undefined;
      draining = undefined;
    }
  };

  return {
    hold(turnId, utterance, fallback) {
      if (fallback !== undefined) fallbacks.set(utterance, fallback);
      const state = turns.get(turnId);
      if (state === 'rejected') return;
      if (state === 'open') return enqueue(turnId, [utterance]);
      held.set(turnId, [...(held.get(turnId) ?? []), utterance]);
    },
    commit(turnId) {
      if (turns.get(turnId) === 'rejected') return;
      turns.set(turnId, 'open');
      const items = held.get(turnId) ?? [];
      held.delete(turnId);
      enqueue(turnId, items);
    },
    reject(turnId) {
      turns.set(turnId, 'rejected');
      held.delete(turnId);
      startedAt.delete(turnId);
      for (let at = waiting.length - 1; at >= 0; at -= 1) if (waiting[at]?.turnId === turnId) waiting.splice(at, 1);
      for (let at = jobs.length - 1; at >= 0; at -= 1) {
        if (jobs[at]?.turnId !== turnId) continue;
        jobs[at]?.controller.abort();
        jobs.splice(at, 1);
      }
      if (playing?.turnId === turnId) playing.controller.abort();
    },
    finish(turnId) {
      turns.delete(turnId);
      timed.delete(turnId);
      held.delete(turnId);
    },
    pause() {
      paused = true;
      deps.sink.pause?.();
    },
    resume() {
      paused = false;
      deps.sink.resume?.();
      wake();
    },
    skip() {
      skipController?.abort();
    },
    stop() {
      generation += 1;
      held.clear();
      waiting.length = 0;
      for (const job of jobs.splice(0)) job.controller.abort();
      skipController?.abort();
      startedAt.clear();
      for (const turnId of turns.keys()) turns.set(turnId, 'rejected');
      paused = false;
      wake();
    },
    generation: () => generation,
    depth,
    idle: () => draining ?? Promise.resolve(),
  };
};
