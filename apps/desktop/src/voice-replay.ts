import type { Delivery } from '../../../packages/voice/src/voice.ts';
import type { PreviewAudio, PreviewRequest } from './voice-host.ts';
import type { AudioOut } from './voice-setup.ts';

export type ReplaySegment = { readonly speakerId?: string; readonly text: string; readonly delivery?: Delivery };

const NO_STYLE = '';
const NO_PRONUNCIATIONS = {};

export type ReplayOptions = {
  readonly preview: (request: PreviewRequest) => Promise<PreviewAudio>;
  readonly stopLive: () => void;
  readonly audio: AudioOut;
  readonly provider: () => string | undefined;
  readonly voiceOf: (speakerId?: string) => string | undefined;
  readonly language: () => string;
  readonly speed: () => number;
  readonly volume: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly changed: () => void;
};

const NO_DURATION_MS = 0;

export const createReplay = ({
  preview,
  stopLive,
  audio,
  provider,
  voiceOf,
  language,
  speed,
  volume,
  wait,
  changed,
}: ReplayOptions) => {
  let run = 0;
  let current: string | undefined;

  const stop = () => {
    if (current === undefined) return;
    run += 1;
    current = undefined;
    audio.stop?.();
    changed();
  };

  const speak = async (segments: readonly ReplaySegment[], mine: number, providerId: string) => {
    for (const { speakerId, text, delivery } of segments) {
      const voiceId = voiceOf(speakerId);
      if (voiceId === undefined || run !== mine) return;
      const { chunks } = await preview({
        providerId,
        voiceId,
        language: language(),
        speed: speed(),
        text,
        style: NO_STYLE,
        pronunciations: NO_PRONUNCIATIONS,
        ...(delivery === undefined ? {} : { delivery }),
      });
      if (run !== mine) return;
      const { durationMs = NO_DURATION_MS } = await audio.play(chunks, volume());
      await wait(durationMs);
      if (run !== mine) return;
    }
  };

  const toggle = async (id: string, segments: readonly ReplaySegment[]) => {
    const wasPlaying = current === id;
    stop();
    const providerId = provider();
    if (wasPlaying || providerId === undefined) return;
    const mine = ++run;
    current = id;
    stopLive();
    changed();
    await speak(segments, mine, providerId).catch(() => undefined);
    if (run !== mine) return;
    current = undefined;
    changed();
  };

  return { toggle, stop, playing: () => current };
};
