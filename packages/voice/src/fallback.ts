import type { Accepted, ClientSession, Result, SubmitPlayerAction } from '../../client-protocol/src/protocol.ts';
import type { PlaybackSink } from './playback.ts';
import type { ProviderKind } from './providers.ts';
import { type SttFallbackReason, startTranscription, type TranscriptionOptions } from './stt.ts';
import type { VoiceTurn } from './turns.ts';
import type { AudioInputProvider, TranscriptSegment } from './voice.ts';

export type AudioFailure = 'timeout' | 'missing-device' | 'provider-error';

export type RecoveryEvent =
  | {
      readonly kind: 'audio-failure';
      readonly channel: ProviderKind;
      readonly id: string;
      readonly attempt: number;
      readonly failure: AudioFailure;
      readonly next: 'retry' | 'text';
    }
  | { readonly kind: 'audio-recovered'; readonly channel: ProviderKind; readonly id: string; readonly attempt: number };

export interface RecoveryOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly onEvent?: (event: RecoveryEvent) => void;
}

export interface TurnTranscriptionOptions extends Omit<TranscriptionOptions, 'audio'>, RecoveryOptions {
  readonly turn: VoiceTurn;
}

export type TurnTranscription =
  | { readonly kind: 'transcript'; readonly turnId: string; readonly segments: readonly TranscriptSegment[] }
  | { readonly kind: 'typed-input-only'; readonly turnId: string; readonly reason: SttFallbackReason | AudioFailure };

export type VoiceActionCommand = Omit<SubmitPlayerAction, 'actionId'>;

export const DEFAULT_STT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const VOICE_ACTION_PREFIX = 'voice-turn:';

const FIRST_ATTEMPT = 1;
const STT: ProviderKind = 'stt';
const TTS: ProviderKind = 'tts';
const TIMEOUT_ERROR = 'TimeoutError';
const NOT_FOUND_ERROR = 'NotFoundError';
const TIMEOUT_MESSAGE = 'audio attempt timed out';
const RETRYABLE: ReadonlySet<AudioFailure> = new Set(['timeout', 'provider-error']);

export const classifyAudioFailure = (error: unknown): AudioFailure => {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  if (name === TIMEOUT_ERROR) return 'timeout';
  if (name === NOT_FOUND_ERROR) return 'missing-device';
  return 'provider-error';
};

const assertOptions = (timeoutMs: number, maxAttempts: number): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be a finite number > 0');
  if (!Number.isInteger(maxAttempts) || maxAttempts < FIRST_ATTEMPT) {
    throw new RangeError('maxAttempts must be an integer >= 1');
  }
};

const withTimeout = async <T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException(TIMEOUT_MESSAGE, TIMEOUT_ERROR);
      controller.abort(reason);
      reject(reason);
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

type Recovery<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: AudioFailure };

const recover = async <T>(
  channel: ProviderKind,
  id: string,
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  maxAttempts: number,
  onEvent: (event: RecoveryEvent) => void,
): Promise<Recovery<T>> => {
  for (let attempt = FIRST_ATTEMPT; ; attempt += 1) {
    try {
      const value = await withTimeout(task, timeoutMs);
      if (attempt > FIRST_ATTEMPT) onEvent({ kind: 'audio-recovered', channel, id, attempt });
      return { ok: true, value };
    } catch (error) {
      const failure = classifyAudioFailure(error);
      const retry = RETRYABLE.has(failure) && attempt < maxAttempts;
      onEvent({ kind: 'audio-failure', channel, id, attempt, failure, next: retry ? 'retry' : 'text' });
      if (!retry) return { ok: false, failure };
    }
  }
};

async function* replay(chunks: readonly Uint8Array[], signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    if (signal?.aborted) return;
    yield chunk;
  }
}

const watchErrors = (provider: AudioInputProvider, onError: (error: unknown) => void): AudioInputProvider => ({
  id: provider.id,
  locality: provider.locality,
  retention: provider.retention,
  async *transcribe(audio) {
    try {
      yield* provider.transcribe(audio);
    } catch (error) {
      onError(error);
      throw error;
    }
  },
});

const transcribeOnce =
  (options: TurnTranscriptionOptions) =>
  async (signal: AbortSignal): Promise<readonly TranscriptSegment[]> => {
    let failure: unknown;
    const session = startTranscription({
      ...options,
      providers: options.providers.map((provider) => watchErrors(provider, (error) => (failure = error))),
      audio: replay(options.turn.chunks, signal),
    });
    const segments: TranscriptSegment[] = [];
    for await (const segment of session.segments) segments.push(segment);
    if (session.status().kind === 'typed-input-only') throw failure;
    return segments;
  };

export const transcribeTurn = (options: TurnTranscriptionOptions): Promise<TurnTranscription> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  assertOptions(timeoutMs, maxAttempts);
  const turnId = options.turn.id;
  const gate = startTranscription({ ...options, audio: replay([]) }).status();
  if (gate.kind === 'typed-input-only') {
    return Promise.resolve({ kind: 'typed-input-only', turnId, reason: gate.reason });
  }
  const onEvent = options.onEvent ?? (() => {});
  return recover(STT, turnId, transcribeOnce(options), timeoutMs, maxAttempts, onEvent).then(
    (result): TurnTranscription =>
      result.ok
        ? { kind: 'transcript', turnId, segments: result.value }
        : { kind: 'typed-input-only', turnId, reason: result.failure },
  );
};

export const reportSinkFailures = (sink: PlaybackSink, onEvent: (event: RecoveryEvent) => void): PlaybackSink => ({
  ...(sink.pause && { pause: sink.pause.bind(sink) }),
  ...(sink.resume && { resume: sink.resume.bind(sink) }),
  play: async (chunk, speed, signal) => {
    try {
      await sink.play(chunk, speed, signal);
    } catch (error) {
      if (!signal.aborted) {
        const failure = classifyAudioFailure(error);
        onEvent({
          kind: 'audio-failure',
          channel: TTS,
          id: chunk.utteranceEventId,
          attempt: FIRST_ATTEMPT,
          failure,
          next: 'text',
        });
      }
      throw error;
    }
  },
});

export const voiceActionId = (turnId: string): string => `${VOICE_ACTION_PREFIX}${turnId}`;

export const createVoiceActionSubmitter = (session: Pick<ClientSession, 'submitPlayerAction'>) => {
  const accepted = new Map<string, Result<Accepted>>();
  return (turnId: string, command: VoiceActionCommand): Result<Accepted> => {
    const actionId = voiceActionId(turnId);
    const previous = accepted.get(actionId);
    if (previous) return previous;
    const result = session.submitPlayerAction({ ...command, actionId });
    if (result.ok) accepted.set(actionId, result);
    return result;
  };
};
