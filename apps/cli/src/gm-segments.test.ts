import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NARRATOR_SPEAKER,
  outputSegmentsOf,
  routeSegments,
  UncommittedSegmentError,
  unspoken,
} from '../../../packages/voice/src/speaker-routing.ts';
import type { VoiceProfile } from '../../../packages/voice/src/voice.ts';
import { FAKE_GM_REPLY } from './engine-gateway.ts';
import {
  MAX_SPEAKER_ID_LENGTH,
  NEUTRAL_EMOTION,
  narrationOf,
  narratorSegments,
  SEGMENTS_SCHEMA,
  segmentsOf,
} from './gm-segments.ts';

const NPC_ID = 'npc-innkeeper';
const EVENT_ID = 'ev-turn';
const OTHER_EVENT_ID = 'ev-other';
const NARRATOR_LINE = 'The innkeeper wipes a mug.';
const NPC_LINE = 'You look like trouble.';

const profile = (id: string): VoiceProfile => ({
  id,
  language: 'en-GB',
  pace: 1,
  style: 'plain',
  pronunciations: {},
  fallbacks: [{ providerId: 'a', voiceId: `${id}-voice` }],
});

const reply = (segments: unknown) => ({ segments });

describe('rpg-cm63.3 GM narration segments', () => {
  it('parses ordered narrator and speaker segments with delivery', () => {
    const segments = segmentsOf(
      reply([
        { text: ` ${NARRATOR_LINE} ` },
        { speakerId: NPC_ID, text: NPC_LINE, delivery: { emotion: 'angry', intensity: 0.5, pace: 1.1 } },
        { speakerId: NARRATOR_SPEAKER, text: 'Rain.' },
      ]),
    );
    assert.deepEqual(segments, [
      { text: NARRATOR_LINE },
      { speakerId: NPC_ID, text: NPC_LINE, delivery: { emotion: 'angry', intensity: 0.5, pace: 1.1 } },
      { text: 'Rain.' },
    ]);
    assert.equal(narrationOf(segments ?? []), `${NARRATOR_LINE} ${NPC_LINE} Rain.`);
  });

  it('keeps the important hint only when it is the boolean true', () => {
    const segments = segmentsOf(
      reply([
        { speakerId: NPC_ID, text: NPC_LINE, important: true },
        { speakerId: NPC_ID, text: NPC_LINE, important: 'yes' },
        { speakerId: NPC_ID, text: NPC_LINE, important: false },
      ]),
    );
    assert.deepEqual(segments, [
      { speakerId: NPC_ID, text: NPC_LINE, important: true },
      { speakerId: NPC_ID, text: NPC_LINE },
      { speakerId: NPC_ID, text: NPC_LINE },
    ]);
    assert.equal(SEGMENTS_SCHEMA.properties.segments.items.properties.important.type, 'boolean');
  });

  it('rejects malformed output so the caller falls back to one narrator segment', () => {
    for (const value of [undefined, null, 'text', [], {}, reply('x'), reply([]), reply([{ text: ' ' }, 7])])
      assert.equal(segmentsOf(value), undefined);
    assert.deepEqual(narratorSegments(FAKE_GM_REPLY), [{ text: FAKE_GM_REPLY }]);
    assert.equal(narrationOf(narratorSegments(FAKE_GM_REPLY)), FAKE_GM_REPLY);
  });

  it('drops invalid segments and fields and degrades unknown emotions to neutral', () => {
    const segments = segmentsOf(
      reply([
        { text: 42 },
        { speakerId: 7, text: NARRATOR_LINE, delivery: { emotion: 'smug', intensity: 9, pace: 'fast' } },
        { speakerId: 'x'.repeat(500), text: NPC_LINE, delivery: 'loud' },
        { text: 'Go.', delivery: { emotion: { evil: true }, pace: Number.NaN } },
      ]),
    );
    assert.deepEqual(segments, [
      { text: NARRATOR_LINE, delivery: { emotion: NEUTRAL_EMOTION } },
      { text: NPC_LINE },
      { text: 'Go.', delivery: { emotion: NEUTRAL_EMOTION } },
    ]);
  });

  it('trims a speaker id before the narrator and length checks', () => {
    const padded = ` ${'y'.repeat(MAX_SPEAKER_ID_LENGTH)} `;
    assert.deepEqual(
      segmentsOf(
        reply([
          { speakerId: ` ${NARRATOR_SPEAKER} `, text: NARRATOR_LINE },
          { speakerId: padded, text: NPC_LINE },
        ]),
      ),
      [{ text: NARRATOR_LINE }, { speakerId: padded.trim(), text: NPC_LINE }],
    );
  });

  it('never lets delivery change the narrative text', () => {
    const plain = segmentsOf(reply([{ speakerId: NPC_ID, text: NPC_LINE }])) ?? [];
    const delivered = segmentsOf(reply([{ speakerId: NPC_ID, text: NPC_LINE, delivery: { emotion: 'happy' } }])) ?? [];
    assert.equal(narrationOf(delivered), narrationOf(plain));
  });

  it('describes the segment shape as a JSON schema object', () => {
    assert.equal(SEGMENTS_SCHEMA.type, 'object');
    assert.deepEqual(SEGMENTS_SCHEMA.required, ['segments']);
  });

  it('feeds committed segments to routeSegments once per event id', () => {
    const segments = [{ text: NARRATOR_LINE }, { speakerId: NPC_ID, text: NPC_LINE }];
    const spoken = new Set<string>();
    const route = (eventId: string, events: readonly string[]) =>
      unspoken(
        spoken,
        routeSegments({
          committed: { events: events.map((id) => ({ id })) },
          segments: outputSegmentsOf(eventId, segments),
          narrator: profile(NARRATOR_SPEAKER),
          profileOf: (speakerId) => (speakerId === NPC_ID ? profile(NPC_ID) : undefined),
        }),
      );
    assert.throws(() => route(OTHER_EVENT_ID, [EVENT_ID]), UncommittedSegmentError);
    assert.deepEqual(
      route(EVENT_ID, [EVENT_ID]).map(({ eventId, speakerId, profile: { id } }) => [eventId, speakerId, id]),
      [
        [EVENT_ID, NARRATOR_SPEAKER, NARRATOR_SPEAKER],
        [EVENT_ID, NPC_ID, NPC_ID],
      ],
    );
    assert.deepEqual(route(EVENT_ID, [EVENT_ID]), []);
    assert.equal(route(OTHER_EVENT_ID, [EVENT_ID, OTHER_EVENT_ID]).length, segments.length);
  });
});
