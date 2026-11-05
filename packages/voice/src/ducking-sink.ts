import type { PlaybackSink } from './playback.ts';

export const DUCK_RELEASE_MS = 400;

export const duckingSink = (sink: PlaybackSink, onSpeaking: (active: boolean) => void): PlaybackSink => {
  let release: ReturnType<typeof setTimeout> | undefined;
  return {
    ...sink,
    play: async (chunk, speed, signal) => {
      clearTimeout(release);
      onSpeaking(true);
      try {
        await sink.play(chunk, speed, signal);
      } finally {
        release = setTimeout(() => onSpeaking(false), DUCK_RELEASE_MS);
        release.unref();
      }
    },
  };
};
