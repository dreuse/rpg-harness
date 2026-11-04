import type { InterruptOptions, OutputQueue } from './playback.ts';

export const BARGE_IN_DEFAULTS: InterruptOptions = { dropPending: true };

export const createBargeIn =
  (queue: OutputQueue, options: InterruptOptions = BARGE_IN_DEFAULTS) =>
  (): void => {
    if (queue.playing()) queue.interrupt(options);
  };
