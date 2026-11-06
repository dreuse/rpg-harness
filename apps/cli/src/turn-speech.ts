import { narratorFallback } from '../../../packages/voice/src/language-voices.ts';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
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

const NO_STYLE = '';
const WHITESPACE = /\s+/;
const WORD_JOIN = ' ';
const STREAMING_MODES: readonly SpokenOutputMode[] = ['narrator', 'full', 'cinematic'];

export interface TurnSpeechOptions {
  readonly speech: Pick<StreamingSpeech, 'hold' | 'commit' | 'reject' | 'finish' | 'generation'>;
  readonly turnId: string;
  readonly mode: SpokenOutputMode;
  readonly narrator: VoiceProfile;
  readonly utterancesOf: (segments: readonly GmSegment[]) => readonly CommittedUtterance[];
}

export interface TurnSpeech {
  readonly streams: boolean;
  heard(segment: GmSegment): void;
  restart(): void;
  settle(reply: { readonly narration: string; readonly segments: readonly GmSegment[] }): void;
  abandon(): void;
}

export const narratorProfileOf = (language: string, speed = DEFAULT_PLAYBACK_SPEED): VoiceProfile => {
  const fallback = narratorFallback(language);
  return {
    id: NARRATOR_SPEAKER,
    language,
    pace: speed,
    style: NO_STYLE,
    pronunciations: {},
    fallbacks: fallback === undefined ? [] : [fallback],
  };
};

export const spokenIn = (mode: SpokenOutputMode, { speakerId }: CommittedUtterance): boolean => {
  if (mode === 'dialogue') return speakerId !== NARRATOR_SPEAKER;
  return mode !== 'off';
};

const sameWords = (left: string, right: string) =>
  left.trim().split(WHITESPACE).join(WORD_JOIN) === right.trim().split(WHITESPACE).join(WORD_JOIN);

const unheardOf = (segments: readonly GmSegment[], heardText: string): readonly GmSegment[] | undefined => {
  let consumed = '';
  for (let at = 0; ; at += 1) {
    if (sameWords(consumed, heardText)) return segments.slice(at);
    const next = segments[at];
    if (next === undefined) return undefined;
    consumed = `${consumed}${WORD_JOIN}${next.text}`;
  }
};

export const createTurnSpeech = ({ speech, turnId, mode, narrator, utterancesOf }: TurnSpeechOptions): TurnSpeech => {
  const heard: string[] = [];
  const born = speech.generation();
  const stopped = () => speech.generation() !== born;
  const settings = { ...DEFAULT_VOICE_SETTINGS, spokenOutput: mode };
  const readByNarrator = (utterance: CommittedUtterance): CommittedUtterance =>
    mode === 'narrator' ? { ...utterance, speakerId: NARRATOR_SPEAKER, profile: narrator } : utterance;
  const holdSpoken = (segments: readonly GmSegment[]) => {
    for (const utterance of utterancesOf(segments).filter((item) => spokenIn(mode, item))) {
      const voiced = spokenUtterance(readByNarrator(utterance), settings);
      speech.hold(turnId, voiced, voiced.speakerId === NARRATOR_SPEAKER ? undefined : narrator);
    }
  };

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
    heard: guarded((segment: GmSegment) => {
      if (stopped()) return;
      if (heard.length === 0) speech.commit(turnId);
      heard.push(segment.text);
      holdSpoken([segment]);
    }),
    restart: guarded(() => {
      if (heard.length === 0) return;
      heard.length = 0;
      discard();
    }),
    settle: guarded(({ segments }) => {
      if (stopped()) return speech.finish(turnId);
      const unheard = heard.length === 0 ? segments : unheardOf(segments, heard.join(WORD_JOIN));
      if (unheard === undefined) discard();
      holdSpoken(unheard ?? segments);
      speech.commit(turnId);
      speech.finish(turnId);
    }),
    abandon: guarded(discard),
  };
};
