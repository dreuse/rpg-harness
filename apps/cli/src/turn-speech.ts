import { narratorFallback } from '../../../packages/voice/src/language-voices.ts';
import { NARRATOR_SPEAKER } from '../../../packages/voice/src/speaker-routing.ts';
import type { StreamingSpeech } from '../../../packages/voice/src/streaming-speech.ts';
import { spokenUtterance } from '../../../packages/voice/src/tts.ts';
import {
  type CommittedUtterance,
  DEFAULT_VOICE_SETTINGS,
  type SpokenOutputMode,
  type VoiceProfile,
} from '../../../packages/voice/src/voice.ts';
import type { GmSegment } from './gm-segments.ts';

const NARRATOR_PACE = 1;
const NO_STYLE = '';
const WHITESPACE = /\s+/;
const WORD_JOIN = ' ';
const STREAMING_MODES: readonly SpokenOutputMode[] = ['narrator', 'full', 'cinematic'];

export interface TurnSpeechOptions {
  readonly speech: Pick<StreamingSpeech, 'hold' | 'commit' | 'reject' | 'finish' | 'generation'>;
  readonly turnId: string;
  readonly mode: SpokenOutputMode;
  readonly utterancesOf: (segments: readonly GmSegment[]) => readonly CommittedUtterance[];
}

export interface TurnSpeech {
  readonly streams: boolean;
  heard(segment: string): void;
  settle(reply: { readonly narration: string; readonly segments: readonly GmSegment[] }): void;
  abandon(): void;
}

export const narratorProfileOf = (language: string): VoiceProfile => {
  const fallback = narratorFallback(language);
  return {
    id: NARRATOR_SPEAKER,
    language,
    pace: NARRATOR_PACE,
    style: NO_STYLE,
    pronunciations: {},
    fallbacks: fallback === undefined ? [] : [fallback],
  };
};

export const spokenIn = (mode: SpokenOutputMode, { speakerId }: CommittedUtterance): boolean => {
  if (mode === 'narrator') return speakerId === NARRATOR_SPEAKER;
  if (mode === 'dialogue') return speakerId !== NARRATOR_SPEAKER;
  return mode !== 'off';
};

const sameWords = (left: string, right: string) =>
  left.trim().split(WHITESPACE).join(WORD_JOIN) === right.trim().split(WHITESPACE).join(WORD_JOIN);

export const createTurnSpeech = ({ speech, turnId, mode, utterancesOf }: TurnSpeechOptions): TurnSpeech => {
  const heard: string[] = [];
  const born = speech.generation();
  const stopped = () => speech.generation() !== born;
  const settings = { ...DEFAULT_VOICE_SETTINGS, spokenOutput: mode };
  const spoken = (segments: readonly GmSegment[]) =>
    utterancesOf(segments)
      .filter((utterance) => spokenIn(mode, utterance))
      .map((utterance) => spokenUtterance(utterance, settings));

  const discard = () => {
    speech.reject(turnId);
    speech.finish(turnId);
  };

  const guarded =
    <Args extends unknown[]>(run: (...args: Args) => void) =>
    (...args: Args) => {
      try {
        run(...args);
      } catch {
        discard();
      }
    };

  return {
    streams: STREAMING_MODES.includes(mode),
    heard: guarded((segment: string) => {
      if (stopped()) return;
      if (heard.length === 0) speech.commit(turnId);
      heard.push(segment);
      for (const utterance of spoken([{ text: segment }])) speech.hold(turnId, utterance);
    }),
    settle: guarded(({ narration, segments }) => {
      if (stopped()) return speech.finish(turnId);
      if (heard.length > 0) {
        if (sameWords(heard.join(WORD_JOIN), narration)) speech.finish(turnId);
        else discard();
        return;
      }
      for (const utterance of spoken(segments)) speech.hold(turnId, utterance);
      speech.commit(turnId);
      speech.finish(turnId);
    }),
    abandon: guarded(discard),
  };
};
