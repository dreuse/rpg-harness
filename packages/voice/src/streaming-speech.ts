import type { PlaybackSink } from './playback.ts';
import type { SpeechChunk } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

export const MIN_SEGMENT_CHARS = 24;
export const PREFETCH_DEPTH = 2;
const SENTENCE_END = /[.!?…]["')\]]*\s/;
const SPEED = 1;

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
  readonly now: () => number;
}

export interface StreamingSpeech {
  hold(turnId: string, utterance: CommittedUtterance): void;
  commit(turnId: string): void;
  reject(turnId: string): void;
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
  const waiting: Entry[] = [];
  const jobs: Job[] = [];
  let generation = 0;
  let paused = false;
  let wake = () => {};
  let skipController: AbortController | undefined;
  let draining: Promise<void> | undefined;
  const startedAt = new Map<string, number>();

  const depth = () => waiting.length + jobs.length;

  const startJob = ({ utterance, turnId }: Entry): Job => {
    const controller = new AbortController();
    const begun = deps.now();
    const collect = async (): Promise<SpeechChunk[]> => {
      const out: SpeechChunk[] = [];
      try {
        for await (const item of deps.synthesize(utterance, controller.signal)) out.push(item);
      } catch {
        deps.onMetrics({ kind: 'error' });
        return [];
      }
      deps.onMetrics({ kind: 'synthesis', ms: deps.now() - begun });
      return out;
    };
    return { turnId, utterance, controller, chunks: collect() };
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
        if (mine !== generation) continue;
        jobs.shift();
        fill();
        const controller = new AbortController();
        skipController = controller;
        for (const item of chunks) {
          await untilResumed();
          if (mine !== generation || controller.signal.aborted) break;
          const began = startedAt.get(job.turnId);
          if (began !== undefined) {
            deps.onMetrics({ kind: 'first-audio', ms: deps.now() - began });
            startedAt.delete(job.turnId);
          }
          await deps.sink.play(item, SPEED, controller.signal).catch(() => undefined);
        }
      }
    } finally {
      skipController = undefined;
      draining = undefined;
    }
  };

  return {
    hold(turnId, utterance) {
      held.set(turnId, [...(held.get(turnId) ?? []), utterance]);
    },
    commit(turnId) {
      const items = held.get(turnId) ?? [];
      held.delete(turnId);
      if (items.length === 0) return;
      startedAt.set(turnId, deps.now());
      waiting.push(...items.map((utterance) => ({ utterance, turnId })));
      deps.onMetrics({ kind: 'queue-depth', depth: depth() });
      draining ??= drain();
    },
    reject(turnId) {
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
      paused = false;
      wake();
    },
    generation: () => generation,
    depth,
    idle: () => draining ?? Promise.resolve(),
  };
};
