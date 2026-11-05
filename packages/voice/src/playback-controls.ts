import type { StreamingSpeech } from './streaming-speech.ts';

export const PLAYBACK_COMMANDS = ['pause', 'resume', 'skip', 'stop'] as const;
export type PlaybackCommand = (typeof PLAYBACK_COMMANDS)[number];
export type PlaybackControl = Pick<StreamingSpeech, PlaybackCommand>;

export const isPlaybackCommand = (value: unknown): value is PlaybackCommand =>
  typeof value === 'string' && (PLAYBACK_COMMANDS as readonly string[]).includes(value);

export const applyPlaybackCommand = (control: PlaybackControl, command: unknown): command is PlaybackCommand => {
  if (!isPlaybackCommand(command)) return false;
  control[command]();
  return true;
};
