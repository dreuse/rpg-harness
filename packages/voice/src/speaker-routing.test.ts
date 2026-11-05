import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOutputQueue, type PlaybackEvent } from './playback.ts';
import { NARRATOR_SPEAKER, type OutputSegment, routeSegments, UncommittedSegmentError } from './speaker-routing.ts';
import type { SpeechChunk, TtsProvider } from './tts.ts';
import type { VoiceProfile, VoiceSettings } from './voice.ts';

const PROVIDER_ID = 'a';
const NPC_ID = 'npc-mira';
const UNKNOWN_NPC_ID = 'npc-stranger';
const HANGING_EVENT = 'ev-dialogue';

const profile = (id: string, voiceId: string): VoiceProfile => ({
  id,
  language: 'en-GB',
  pace: 1,
  style: 'plain',
  pronunciations: {},
  fallbacks: [{ providerId: PROVIDER_ID, voiceId }],
});

const NARRATOR_PROFILE = profile('narrator', 'narrator-voice');
const NPC_PROFILE = profile('mira', 'mira-voice');
const RECAST_PROFILE = profile('mira-recast', 'recast-voice');

const committedEvent = (id: string) => ({ id });

const COMMITTED = { events: [committedEvent('ev-narration'), committedEvent(HANGING_EVENT)] };

const SEGMENTS: readonly OutputSegment[] = [
  { eventId: 'ev-narration', text: 'Rain hammers the roof.' },
  { eventId: HANGING_EVENT, speakerId: NPC_ID, text: 'You are late.' },
];

const profilesOf = (entries: Record<string, VoiceProfile>) => (speakerId: string) => entries[speakerId];

test('route segments to narration or correct npc voice after valid commit', () => {
  const routed = routeSegments({
    committed: COMMITTED,
    segments: SEGMENTS,
    narrator: NARRATOR_PROFILE,
    profileOf: profilesOf({ [NPC_ID]: NPC_PROFILE }),
  });

  assert.deepEqual(
    routed.map(({ eventId, speakerId, profile: { id } }) => [eventId, speakerId, id]),
    [
      ['ev-narration', NARRATOR_SPEAKER, NARRATOR_PROFILE.id],
      [HANGING_EVENT, NPC_ID, NPC_PROFILE.id],
    ],
  );
});

test('route passes the segment delivery into the utterance', () => {
  const delivery = { emotion: 'angry', intensity: 1 };
  const [plain, delivered] = routeSegments({
    committed: COMMITTED,
    segments: [
      SEGMENTS[0] ?? { eventId: 'ev-narration', text: '' },
      { ...SEGMENTS[1], eventId: HANGING_EVENT, text: 'Go.', delivery },
    ],
    narrator: NARRATOR_PROFILE,
    profileOf: profilesOf({ [NPC_ID]: NPC_PROFILE }),
  });
  assert.equal(plain?.delivery, undefined);
  assert.equal(plain !== undefined && 'delivery' in plain, false);
  assert.deepEqual(delivered?.delivery, delivery);
});

test('reject a segment whose event is not in the commit', () => {
  assert.throws(
    () =>
      routeSegments({
        committed: COMMITTED,
        segments: [{ eventId: 'ev-draft', text: 'Not yet true.' }],
        narrator: NARRATOR_PROFILE,
        profileOf: profilesOf({}),
      }),
    UncommittedSegmentError,
  );
});

test('fall back to the narrator voice for an npc without a profile and keep the npc as speaker', () => {
  const [routed] = routeSegments({
    committed: COMMITTED,
    segments: [{ eventId: HANGING_EVENT, speakerId: UNKNOWN_NPC_ID, text: 'Who asks?' }],
    narrator: NARRATOR_PROFILE,
    profileOf: profilesOf({}),
  });

  assert.equal(routed?.speakerId, UNKNOWN_NPC_ID);
  assert.equal(routed?.profile.id, NARRATOR_PROFILE.id);
});

const SETTINGS: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'full',
  consent: { granted: true, grantedAt: '2026-01-01T00:00:00Z', providerIds: [PROVIDER_ID] },
};

const hangingProvider = (): { provider: TtsProvider; hang: { enabled: boolean } } => {
  const hang = { enabled: true };
  const provider: TtsProvider = {
    id: PROVIDER_ID,
    locality: 'local',
    retention: 'none',
    async *synthesize(spoken, voiceId, signal): AsyncGenerator<SpeechChunk> {
      yield {
        utteranceEventId: spoken.eventId,
        sequence: 0,
        audio: new Uint8Array(),
        mimeType: 'audio/mpeg',
        voiceId,
        final: true,
      };
      if (hang.enabled && spoken.eventId === HANGING_EVENT) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      }
    },
  };
  return { provider, hang };
};

test('no speaker attribution changes during interrupted output', async () => {
  const profiles: Record<string, VoiceProfile> = { [NPC_ID]: NPC_PROFILE };
  const routed = routeSegments({
    committed: COMMITTED,
    segments: SEGMENTS,
    narrator: NARRATOR_PROFILE,
    profileOf: profilesOf(profiles),
  });
  const { provider, hang } = hangingProvider();
  const events: PlaybackEvent[] = [];
  const voices: string[] = [];
  const queue = createOutputQueue({
    sink: {
      async play(chunk) {
        voices.push(`${chunk.utteranceEventId}:${chunk.voiceId}`);
      },
    },
    speech: {
      settings: SETTINGS,
      providers: [provider],
      rate: { unit: 'char', currency: 'USD', pricePerUnit: 0 },
      budget: 1,
    },
    onEvent: (event) => events.push(event),
  });

  for (const utterance of routed) queue.enqueue(utterance);
  while (voices.length < SEGMENTS.length) await new Promise((resolve) => setImmediate(resolve));
  queue.interrupt();
  await queue.idle();
  profiles[NPC_ID] = RECAST_PROFILE;
  hang.enabled = false;
  for (const utterance of routed) queue.enqueue(utterance);
  await queue.idle();

  assert.ok(Object.isFrozen(routed) && routed.every(Object.isFrozen));
  assert.deepEqual(voices, [
    'ev-narration:narrator-voice',
    `${HANGING_EVENT}:mira-voice`,
    'ev-narration:narrator-voice',
    `${HANGING_EVENT}:mira-voice`,
  ]);
  const speakers = events.flatMap((event) =>
    event.kind === 'subtitle' && event.state === 'start' ? [`${event.utteranceEventId}:${event.speakerId}`] : [],
  );
  assert.deepEqual(speakers, [
    `ev-narration:${NARRATOR_SPEAKER}`,
    `${HANGING_EVENT}:${NPC_ID}`,
    `ev-narration:${NARRATOR_SPEAKER}`,
    `${HANGING_EVENT}:${NPC_ID}`,
  ]);
});
