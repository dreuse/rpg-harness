import { type SpeakOptions, type SpeechChunk, speakOrText, type TextFallbackReason } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

export const MIN_PLAYBACK_SPEED = 0.5;
export const MAX_PLAYBACK_SPEED = 2;
export const DEFAULT_PLAYBACK_SPEED = 1;

export interface PlaybackSink {
  play(chunk: SpeechChunk, speed: number, signal: AbortSignal): Promise<void>;
}

interface SubtitleFields {
  readonly kind: 'subtitle';
  readonly utteranceEventId: string;
  readonly speakerId: string;
  readonly text: string;
}

export type PlaybackEvent =
  | (SubtitleFields & { readonly state: 'start' | 'end' })
  | (SubtitleFields & { readonly state: 'text-only'; readonly reason: TextFallbackReason })
  | { readonly kind: 'interrupted'; readonly utteranceEventId: string | undefined; readonly dropped: number };

export interface OutputQueueDeps {
  readonly sink: PlaybackSink;
  readonly speech: Omit<SpeakOptions, 'utterance' | 'signal'>;
  readonly onEvent: (event: PlaybackEvent) => void;
}

export interface InterruptOptions {
  readonly dropPending?: boolean;
}

export interface OutputQueue {
  enqueue(utterance: CommittedUtterance): void;
  setSpeed(speed: number): void;
  speed(): number;
  interrupt(options?: InterruptOptions): void;
  playing(): boolean;
  idle(): Promise<void>;
}

interface Current {
  readonly utterance: CommittedUtterance;
  readonly controller: AbortController;
}

const assertSpeed = (speed: number): void => {
  if (!Number.isFinite(speed) || speed < MIN_PLAYBACK_SPEED || speed > MAX_PLAYBACK_SPEED) {
    throw new RangeError(`speed must be a finite number in [${MIN_PLAYBACK_SPEED}, ${MAX_PLAYBACK_SPEED}]`);
  }
};

const subtitle = (utterance: CommittedUtterance): SubtitleFields => ({
  kind: 'subtitle',
  utteranceEventId: utterance.eventId,
  speakerId: utterance.speakerId,
  text: utterance.text,
});

export const createOutputQueue = (deps: OutputQueueDeps): OutputQueue => {
  const pending: CommittedUtterance[] = [];
  let speed = DEFAULT_PLAYBACK_SPEED;
  let current: Current | undefined;
  let draining: Promise<void> | undefined;

  const playOne = async (utterance: CommittedUtterance, signal: AbortSignal): Promise<void> => {
    const outcome = await speakOrText({ ...deps.speech, utterance, signal });
    if (outcome.kind === 'text') {
      deps.onEvent({ ...subtitle(utterance), state: 'text-only', reason: outcome.reason });
      return;
    }
    deps.onEvent({ ...subtitle(utterance), state: 'start' });
    try {
      for await (const chunk of outcome.chunks) {
        if (signal.aborted) break;
        await deps.sink.play(chunk, speed, signal);
      }
    } catch {
    } finally {
      deps.onEvent({ ...subtitle(utterance), state: 'end' });
    }
  };

  const drain = async (): Promise<void> => {
    try {
      for (let next = pending.shift(); next; next = pending.shift()) {
        current = { utterance: next, controller: new AbortController() };
        await playOne(next, current.controller.signal).catch(() => undefined);
      }
    } finally {
      current = undefined;
      draining = undefined;
    }
  };

  return {
    enqueue(utterance) {
      pending.push(utterance);
      draining ??= drain();
    },
    setSpeed(next) {
      assertSpeed(next);
      speed = next;
    },
    speed: () => speed,
    interrupt(options = {}) {
      const dropped = options.dropPending ? pending.splice(0).length : 0;
      current?.controller.abort();
      deps.onEvent({ kind: 'interrupted', utteranceEventId: current?.utterance.eventId, dropped });
    },
    playing: () => current !== undefined,
    idle: () => draining ?? Promise.resolve(),
  };
};
