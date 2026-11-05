import type { Delivery } from '../../../packages/voice/src/voice.ts';

export const NEUTRAL_EMOTION = 'neutral';
const NARRATOR_ID = 'narrator';
const MIN_PACE = 0.5;
const MAX_PACE = 2;
export const DELIVERY_EMOTIONS = [
  NEUTRAL_EMOTION,
  'calm',
  'sad',
  'tender',
  'whisper',
  'happy',
  'angry',
  'fearful',
  'excited',
] as const;
export const MAX_SEGMENTS = 32;
export const MAX_SPEAKER_ID_LENGTH = 128;

const MIN_INTENSITY = 0;
const MAX_INTENSITY = 1;
const SEGMENT_SEPARATOR = ' ';

export const SEGMENTS_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_SEGMENTS,
      items: {
        type: 'object',
        properties: {
          speakerId: { type: 'string', maxLength: MAX_SPEAKER_ID_LENGTH },
          text: { type: 'string' },
          delivery: {
            type: 'object',
            properties: {
              emotion: { type: 'string', enum: DELIVERY_EMOTIONS },
              intensity: { type: 'number', minimum: MIN_INTENSITY, maximum: MAX_INTENSITY },
              pace: { type: 'number', minimum: MIN_PACE, maximum: MAX_PACE },
            },
            additionalProperties: false,
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  required: ['segments'],
  additionalProperties: false,
} as const;

export type GmSegment = { readonly speakerId?: string; readonly text: string; readonly delivery?: Delivery };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberIn = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && value >= min && value <= max ? value : undefined;

const emotionOf = (value: unknown) =>
  value === undefined ? undefined : (DELIVERY_EMOTIONS.find((emotion) => emotion === value) ?? NEUTRAL_EMOTION);

const deliveryOf = (value: unknown): Delivery | undefined => {
  if (!isRecord(value)) return undefined;
  const fields = Object.entries({
    emotion: emotionOf(value.emotion),
    intensity: numberIn(value.intensity, MIN_INTENSITY, MAX_INTENSITY),
    pace: numberIn(value.pace, MIN_PACE, MAX_PACE),
  }).filter(([, field]) => field !== undefined);
  return fields.length === 0 ? undefined : Object.fromEntries(fields);
};

const speakerOf = (value: unknown) => {
  const speakerId = typeof value === 'string' ? value.trim() : '';
  return speakerId === '' || speakerId === NARRATOR_ID || speakerId.length > MAX_SPEAKER_ID_LENGTH
    ? undefined
    : speakerId;
};

const segmentOf = (value: unknown): GmSegment[] => {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.trim() === '') return [];
  const speakerId = speakerOf(value.speakerId);
  const delivery = deliveryOf(value.delivery);
  return [
    {
      ...(speakerId === undefined ? {} : { speakerId }),
      text: value.text.trim(),
      ...(delivery === undefined ? {} : { delivery }),
    },
  ];
};

export const segmentsOf = (value: unknown): readonly GmSegment[] | undefined => {
  const listed = isRecord(value) ? value.segments : undefined;
  const segments = Array.isArray(listed) ? listed.slice(0, MAX_SEGMENTS).flatMap(segmentOf) : [];
  return segments.length === 0 ? undefined : segments;
};

export const narratorSegments = (text: string): readonly GmSegment[] => [{ text }];

export const narrationOf = (segments: readonly GmSegment[]): string =>
  segments.map(({ text }) => text).join(SEGMENT_SEPARATOR);
