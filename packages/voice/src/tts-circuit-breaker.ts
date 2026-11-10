import type { SpeechChunk, TtsProvider } from './tts.ts';

export const TTS_MAX_RETRIES = 1;
export const TTS_FAILURE_THRESHOLD = 3;
export const TTS_COOL_DOWN_MS = 30_000;

export interface CircuitBreakerOptions {
  readonly maxRetries?: number;
  readonly failureThreshold?: number;
  readonly coolDownMs?: number;
  readonly now?: () => number;
}

export const withCircuitBreaker = <P extends Pick<TtsProvider, 'synthesize' | 'healthy'>>(
  provider: P,
  {
    maxRetries = TTS_MAX_RETRIES,
    failureThreshold = TTS_FAILURE_THRESHOLD,
    coolDownMs = TTS_COOL_DOWN_MS,
    now = Date.now,
  }: CircuitBreakerOptions = {},
): P => {
  let failures = 0;
  let openUntil = Number.NEGATIVE_INFINITY;

  const recordFailure = (): void => {
    failures += 1;
    if (failures >= failureThreshold) openUntil = now() + coolDownMs;
  };

  const healthy = (): boolean => now() >= openUntil && provider.healthy?.() !== false;

  async function* synthesize(
    ...args: Parameters<TtsProvider['synthesize']>
  ): AsyncGenerator<SpeechChunk, void, undefined> {
    const signal = args[2];
    if (!healthy()) return;
    for (let attempt = 0; ; attempt += 1) {
      const iterator = provider.synthesize(...args)[Symbol.asyncIterator]();
      let first: IteratorResult<SpeechChunk>;
      try {
        first = await iterator.next();
      } catch (error) {
        if (signal.aborted) throw error;
        if (attempt < maxRetries) continue;
        recordFailure();
        throw error;
      }
      if (first.done) return;
      failures = 0;
      try {
        yield first.value;
        yield* { [Symbol.asyncIterator]: () => iterator };
      } catch (error) {
        if (!signal.aborted) recordFailure();
        throw error;
      }
      return;
    }
  }

  return { ...provider, healthy, synthesize };
};
