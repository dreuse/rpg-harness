import {
  type CommittedUtterance,
  estimateCost,
  type PrivacyDisclosure,
  resolveVoiceMode,
  type SpokenOutputMode,
  type UsageRate,
  type VoiceProfile,
  type VoiceSettings,
} from './voice.ts';

export interface SpeechChunk {
  readonly utteranceEventId: string;
  readonly sequence: number;
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly voiceId: string;
  readonly final: boolean;
}

export interface TtsProvider extends PrivacyDisclosure {
  healthy?(): boolean;
  synthesize(utterance: CommittedUtterance, voiceId: string, signal: AbortSignal): AsyncIterable<SpeechChunk>;
}

export type TextFallbackReason =
  | 'voice-off'
  | 'provider-unavailable'
  | 'over-budget'
  | 'cancelled'
  | 'timeout'
  | 'provider-error';

export type SpeechOutcome =
  | { readonly kind: 'speech'; readonly chunks: AsyncIterable<SpeechChunk> }
  | { readonly kind: 'text'; readonly reason: TextFallbackReason };

export interface SpeakOptions {
  readonly utterance: CommittedUtterance;
  readonly settings: VoiceSettings;
  readonly providers: readonly TtsProvider[];
  readonly rate: UsageRate;
  readonly budget: number;
  readonly firstChunkTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 5000;

const CANCELLED: SpeechOutcome = { kind: 'text', reason: 'cancelled' };
const TIMED_OUT = Symbol('timed-out');
const ABORTED = Symbol('aborted');

const CINEMATIC: SpokenOutputMode = 'cinematic';

export const spokenUtterance = (utterance: CommittedUtterance, settings: VoiceSettings): CommittedUtterance => {
  if (settings.spokenOutput === CINEMATIC || utterance.delivery === undefined) return utterance;
  const { delivery: _delivery, ...plain } = utterance;
  return plain;
};

export const selectVoiceId = (profile: VoiceProfile, providerId: string): string | undefined =>
  profile.fallbacks.find((fallback) => fallback.providerId === providerId)?.voiceId;

interface AbortWatch {
  readonly promise: Promise<typeof ABORTED>;
  readonly dispose: () => void;
}

const watchAbort = (signal: AbortSignal): AbortWatch => {
  let listener = () => {};
  const promise = new Promise<typeof ABORTED>((resolve) => {
    listener = () => resolve(ABORTED);
    if (signal.aborted) resolve(ABORTED);
    else signal.addEventListener('abort', listener, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener('abort', listener) };
};

const raceFirst = async <T>(
  pending: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T | typeof TIMED_OUT | typeof ABORTED> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const watch = watchAbort(signal);
  try {
    return await Promise.race([pending, timeout, watch.promise]);
  } finally {
    clearTimeout(timer);
    watch.dispose();
  }
};

const closeIterator = (iterator: AsyncIterator<SpeechChunk> | undefined): void => {
  void Promise.resolve(iterator?.return?.()).catch(() => undefined);
};

async function* pump(
  first: SpeechChunk,
  iterator: AsyncIterator<SpeechChunk>,
  signal: AbortSignal,
  close: () => void,
): AsyncGenerator<SpeechChunk> {
  const watch = watchAbort(signal);
  try {
    if (signal.aborted) return;
    yield first;
    while (!signal.aborted) {
      const next = await Promise.race([iterator.next(), watch.promise]);
      if (next === ABORTED || next.done || signal.aborted) return;
      yield next.value;
    }
  } finally {
    watch.dispose();
    close();
  }
}

const tryStart = async (
  provider: TtsProvider,
  voiceId: string,
  options: SpeakOptions,
  timeoutMs: number,
): Promise<AsyncIterable<SpeechChunk> | TextFallbackReason> => {
  const controller = new AbortController();
  const relay = () => controller.abort();
  options.signal?.addEventListener('abort', relay, { once: true });
  let iterator: AsyncIterator<SpeechChunk> | undefined;
  const close = () => {
    options.signal?.removeEventListener('abort', relay);
    controller.abort();
    closeIterator(iterator);
  };
  try {
    iterator = provider.synthesize(options.utterance, voiceId, controller.signal)[Symbol.asyncIterator]();
    const first = await raceFirst(iterator.next(), timeoutMs, controller.signal);
    if (first === TIMED_OUT || first === ABORTED || first.done) {
      close();
      return first === TIMED_OUT ? 'timeout' : 'provider-error';
    }
    const generator = pump(first.value, iterator, controller.signal, close);
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => generator.next(),
          return: async () => {
            close();
            return generator.return(undefined);
          },
        };
      },
    };
  } catch {
    close();
    return 'provider-error';
  }
};

const assertTimeout = (timeoutMs: number): void => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('firstChunkTimeoutMs must be a finite number > 0');
  }
};

export const speakOrText = async (options: SpeakOptions): Promise<SpeechOutcome> => {
  const timeoutMs = options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;
  assertTimeout(timeoutMs);
  const mode = resolveVoiceMode(options.settings);
  if (mode.kind !== 'voice' || mode.spokenOutput === 'off') return { kind: 'text', reason: 'voice-off' };
  const utterance = spokenUtterance(options.utterance, options.settings);
  const consent = options.settings.consent;
  const consented = consent.granted ? consent.providerIds : [];
  const cost = estimateCost(options.rate, utterance.text.length).amount;
  let reason: TextFallbackReason = 'provider-unavailable';
  for (const { providerId, voiceId } of utterance.profile.fallbacks) {
    if (options.signal?.aborted) return CANCELLED;
    const provider = options.providers.find((candidate) => candidate.id === providerId);
    if (!provider || !consented.includes(providerId) || provider.healthy?.() === false) continue;
    if (cost > options.budget) {
      reason = 'over-budget';
      continue;
    }
    const started = await tryStart(provider, voiceId, { ...options, utterance }, timeoutMs);
    if (typeof started !== 'string') return { kind: 'speech', chunks: started };
    reason = started;
  }
  if (options.signal?.aborted) return CANCELLED;
  return { kind: 'text', reason };
};
