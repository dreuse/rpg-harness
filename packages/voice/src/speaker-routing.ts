import type { CommittedUtterance, Delivery, VoiceProfile } from './voice.ts';

export const NARRATOR_SPEAKER = 'narrator';

export interface OutputSegment {
  readonly eventId: string;
  readonly text: string;
  readonly speakerId?: string;
  readonly delivery?: Delivery;
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
  const route = ({ eventId, text, speakerId = NARRATOR_SPEAKER, delivery }: OutputSegment): CommittedUtterance => {
    if (!committedIds.has(eventId)) throw new UncommittedSegmentError(eventId);
    const profile = (speakerId === NARRATOR_SPEAKER ? undefined : profileOf(speakerId)) ?? narrator;
    return Object.freeze({ text, speakerId, eventId, profile, ...(delivery === undefined ? {} : { delivery }) });
  };
  return Object.freeze(segments.map(route));
};

export const outputSegmentsOf = (
  eventId: string,
  segments: readonly Omit<OutputSegment, 'eventId'>[],
): readonly OutputSegment[] => segments.map((segment) => ({ eventId, ...segment }));

export const unspoken = (
  spoken: Set<string>,
  utterances: readonly CommittedUtterance[],
): readonly CommittedUtterance[] => {
  const fresh = utterances.filter(({ eventId }) => !spoken.has(eventId));
  for (const { eventId } of fresh) spoken.add(eventId);
  return fresh;
};
