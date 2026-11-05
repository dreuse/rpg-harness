const RATE_LIMIT_CODE = 'sound-rate-limited';
const RATE_LIMIT_PATTERN = /sound-rate-limited: retry after (\d+) seconds/;
const SECONDS_PER_MINUTE = 60;

export const DEFAULT_RETRY_AFTER_SECONDS = 600;

export class SoundRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`${RATE_LIMIT_CODE}: retry after ${retryAfterSeconds} seconds`);
    this.name = 'SoundRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const parseRateLimited = (message: string): number | undefined => {
  const seconds = RATE_LIMIT_PATTERN.exec(message)?.[1];
  return seconds === undefined ? undefined : Number(seconds);
};

export const retryMinutes = (seconds: number): number => Math.ceil(seconds / SECONDS_PER_MINUTE);
