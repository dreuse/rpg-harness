import type { CommittedUtterance, VoiceProfile } from './voice.ts';

export const NARRATOR_SPEAKER = 'narrator';

export interface OutputSegment {
  readonly eventId: string;
  readonly text: string;
  readonly speakerId?: string;
}

export interface SpeakerRouting {
  readonly committed: { readonly events: readonly { readonly id: string }[] };
  readonly segments: readonly OutputSegment[];
  readonly narrator: VoiceProfile;
  readonly profileOf: (speakerId: string) => VoiceProfile | undefined;
}

export class UncommittedSegmentError extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(`segment event ${eventId} is not part of the commit`);
    this.name = 'UncommittedSegmentError';
    this.eventId = eventId;
  }
}

export const routeSegments = ({
  committed,
  segments,
  narrator,
  profileOf,
}: SpeakerRouting): readonly CommittedUtterance[] => {
  const committedIds = new Set(committed.events.map((event) => event.id));
  const route = ({ eventId, text, speakerId = NARRATOR_SPEAKER }: OutputSegment): CommittedUtterance => {
    if (!committedIds.has(eventId)) throw new UncommittedSegmentError(eventId);
    const profile = (speakerId === NARRATOR_SPEAKER ? undefined : profileOf(speakerId)) ?? narrator;
    return Object.freeze({ text, speakerId, eventId, profile });
  };
  return Object.freeze(segments.map(route));
};
