import type { PlaybackEvent } from './playback.ts';
import { fold } from './transcript.ts';
import type { TextFallbackReason } from './tts.ts';
import type { CommittedUtterance } from './voice.ts';

export type TranscriptStatus = 'spoken' | 'text-only' | 'interrupted' | 'pending';

export interface LiveSubtitle {
  readonly eventId: string;
  readonly speakerId: string;
  readonly text: string;
  readonly reason?: TextFallbackReason;
}

export interface TranscriptEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly speakerId: string;
  readonly text: string;
  readonly status: TranscriptStatus;
  readonly reason?: TextFallbackReason;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface TranscriptQuery {
  readonly text?: string;
  readonly speakerId?: string;
}

export interface SubtitleTranscriptDeps {
  readonly now?: () => number;
}

export interface SubtitleTranscript {
  commit(utterance: CommittedUtterance): void;
  onPlayback(event: PlaybackEvent): void;
  current(): LiveSubtitle | undefined;
  entries(): readonly TranscriptEntry[];
  search(query: TranscriptQuery): readonly TranscriptEntry[];
}

type MutableEntry = { -readonly [K in keyof TranscriptEntry]: TranscriptEntry[K] };

export const createSubtitleTranscript = (deps: SubtitleTranscriptDeps = {}): SubtitleTranscript => {
  const now = deps.now ?? Date.now;
  const history: MutableEntry[] = [];
  const byEventId = new Map<string, MutableEntry>();
  let live: LiveSubtitle | undefined;

  const show = (entry: MutableEntry, reason?: TextFallbackReason): void => {
    const { eventId, speakerId, text } = entry;
    live = reason ? { eventId, speakerId, text, reason } : { eventId, speakerId, text };
  };

  const finish = (entry: MutableEntry, status: TranscriptStatus): void => {
    if (entry.endedAt !== undefined) return;
    entry.status = status;
    entry.endedAt = now();
  };

  const onPlayback = (event: PlaybackEvent): void => {
    const entry = event.utteranceEventId === undefined ? undefined : byEventId.get(event.utteranceEventId);
    if (event.kind === 'interrupted') {
      live = undefined;
      if (entry) finish(entry, 'interrupted');
      return;
    }
    if (!entry) return;
    if (event.state === 'text-only') {
      if (entry.endedAt !== undefined) return;
      show(entry, event.reason);
      entry.startedAt ??= now();
      entry.reason = event.reason;
      finish(entry, 'text-only');
      return;
    }
    if (event.state === 'start') {
      entry.startedAt ??= now();
      show(entry);
      return;
    }
    if (live?.eventId === entry.eventId) live = undefined;
    finish(entry, 'spoken');
  };

  const snapshot = (entry: MutableEntry): TranscriptEntry => ({ ...entry });

  return {
    commit(utterance) {
      if (byEventId.has(utterance.eventId)) return;
      const { eventId, speakerId, text } = utterance;
      const entry: MutableEntry = { sequence: history.length, eventId, speakerId, text, status: 'pending' };
      history.push(entry);
      byEventId.set(eventId, entry);
    },
    onPlayback,
    current: () => live,
    entries: () => history.map(snapshot),
    search({ text, speakerId }) {
      const needle = text === undefined ? undefined : fold(text);
      return history
        .filter((entry) => speakerId === undefined || entry.speakerId === speakerId)
        .filter((entry) => needle === undefined || fold(entry.text).includes(needle))
        .map(snapshot);
    },
  };
};
