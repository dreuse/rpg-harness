import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAudioCache, createUsageLedger } from './audio-budget.ts';
import { createFileAudioCache } from './audio-cache-store.ts';
import { createBargeIn } from './barge-in.ts';
import { KOKORO_CAPABILITIES, KOKORO_PROVIDER_ID } from './kokoro-provider.ts';
import { voicesFor } from './language-voices.ts';
import { createNpcVoices, installedVoices } from './npc-voice.ts';
import { createOutputQueue, type PlaybackEvent, type PlaybackSink } from './playback.ts';
import { routeSegments } from './speaker-routing.ts';
import { TEST_AUDIO_FORMAT } from './test-audio-format.ts';
import type { SpeakOptions, SpeechChunk, TtsProvider } from './tts.ts';
import { TTS_FAILURE_THRESHOLD, withCircuitBreaker } from './tts-circuit-breaker.ts';
import type { CommittedUtterance, VoiceProfile, VoiceSettings } from './voice.ts';

const PRIMARY = 'primary';
const BACKUP = 'backup';
const SEGMENT_COUNT = 500;
const CACHE_LIMIT_BYTES = 64;
const CHUNK_BYTES = 8;
const HEAP_GROWTH_LIMIT_BYTES = 8 * 1024 * 1024;
const INTERRUPTION_COUNT = 50;
const SWITCH_AT = 5;
const FREE_RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 1_000_000;
const CLOCK_MS = 0;
const PERSISTED_CACHE_BYTES = 1024 * 1024;
const TEMP_PREFIX = 'rpg-reliability-';

const ENABLED: VoiceSettings = {
  microphone: 'off',
  spokenOutput: 'narrator',
  consent: { granted: true, grantedAt: '2026-11-05T00:00:00Z', providerIds: [PRIMARY, BACKUP, KOKORO_PROVIDER_ID] },
};
const DISABLED: VoiceSettings = { ...ENABLED, spokenOutput: 'off' };

const deepFreeze = <T extends object>(value: T): T => {
  for (const child of Object.values(value)) if (typeof child === 'object' && child !== null) deepFreeze(child);
  return Object.freeze(value);
};

const CAMPAIGN_STATE = deepFreeze({
  campaignId: 'camp-1',
  revision: 42,
  events: [{ id: 'ev-1' }, { id: 'ev-2' }, { id: 'ev-3' }],
  entities: { 'npc-guard': { name: 'Guard', gender: 'm' }, hero: { name: 'Hero', hp: 11 } },
  inventory: ['torch', 'sword'],
});
const CAMPAIGN_SNAPSHOT = JSON.stringify(CAMPAIGN_STATE);
const assertCampaignUnchanged = (): void => assert.equal(JSON.stringify(CAMPAIGN_STATE), CAMPAIGN_SNAPSHOT);

const profileFor = (...providerIds: string[]): VoiceProfile => ({
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: providerIds.map((providerId) => ({ providerId, voiceId: `${providerId}-voice` })),
});

const line = (eventId: string, profile: VoiceProfile, text = `line ${eventId}`): CommittedUtterance =>
  Object.freeze({ text, speakerId: 'gm', eventId, profile });

const audioFor = (item: CommittedUtterance, voiceId: string, sequence: number, final: boolean): SpeechChunk => ({
  utteranceEventId: item.eventId,
  sequence,
  audio: new Uint8Array(CHUNK_BYTES).fill(sequence + 1),
  mimeType: 'audio/wav',
  voiceId,
  final,
});

interface FakeTts extends TtsProvider {
  calls: number;
  healthyNow: boolean;
  mode: 'ok' | 'crash-before-audio' | 'crash-mid-segment' | 'hang';
}

const fakeTts = (id: string, mode: FakeTts['mode'] = 'ok'): FakeTts => {
  const provider: FakeTts = {
    id,
    locality: 'local',
    retention: 'none',
    calls: 0,
    healthyNow: true,
    mode,
    healthy: () => provider.healthyNow,
    async *synthesize(item, voiceId, signal) {
      provider.calls += 1;
      if (provider.mode === 'crash-before-audio') throw new Error('provider crashed');
      yield audioFor(item, voiceId, 0, false);
      if (provider.mode === 'crash-mid-segment') throw new Error('provider crashed mid segment');
      if (provider.mode === 'hang') await new Promise((resolve) => signal.addEventListener('abort', resolve));
      yield audioFor(item, voiceId, 1, true);
    },
  };
  return provider;
};

type MutableSpeech = { -readonly [K in keyof Omit<SpeakOptions, 'utterance' | 'signal'>]: SpeakOptions[K] };

const harness = (providers: readonly TtsProvider[], settings: VoiceSettings = ENABLED) => {
  const played: SpeechChunk[] = [];
  const events: PlaybackEvent[] = [];
  const cache = createAudioCache(CACHE_LIMIT_BYTES);
  const ledger = createUsageLedger({ rate: FREE_RATE });
  const speech: MutableSpeech = { settings, providers, rate: FREE_RATE, budget: BUDGET };
  let onPlay: (chunk: SpeechChunk) => void = () => {};
  const sink: PlaybackSink = {
    play: async (chunk) => {
      played.push(chunk);
      assert.ok(cache.bytes <= CACHE_LIMIT_BYTES);
      onPlay(chunk);
    },
  };
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink,
    speech,
    onEvent: (event) => events.push(event),
    ledger,
    cache,
  });
  return {
    sink,
    queue,
    played,
    events,
    cache,
    ledger,
    speech,
    onPlay: (listener: (chunk: SpeechChunk) => void) => {
      onPlay = listener;
    },
  };
};

const finalIds = (played: readonly SpeechChunk[]): string[] =>
  played.filter(({ final }) => final).map(({ utteranceEventId }) => utteranceEventId);

test('a 500 segment session keeps cache, ledger and heap bounded and never writes campaign state', async () => {
  const { queue, played, events, cache, ledger } = harness([fakeTts(PRIMARY)]);
  const profile = profileFor(PRIMARY);
  const heapBefore = process.memoryUsage().heapUsed;
  const ledgerSizes = new Set<number>();
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    queue.enqueue(line(`ev-${index}`, profile, `segment ${index}`));
    await queue.idle();
    ledgerSizes.add(ledger.report().entries.length);
    assert.ok(cache.bytes <= CACHE_LIMIT_BYTES);
  }
  assert.equal(finalIds(played).length, SEGMENT_COUNT);
  assert.equal(queue.playing(), false);
  assert.deepEqual([...ledgerSizes], [1]);
  assert.equal(events.filter(({ kind }) => kind === 'subtitle').length, SEGMENT_COUNT * 2);
  assert.ok(process.memoryUsage().heapUsed - heapBefore < HEAP_GROWTH_LIMIT_BYTES);
  assertCampaignUnchanged();
});

test('rapid interruptions leave the queue idle, drop pending lines and keep campaign state', async () => {
  const hanging = fakeTts(PRIMARY, 'hang');
  const { queue, played, events, onPlay } = harness([hanging]);
  const bargeIn = createBargeIn(queue);
  const profile = profileFor(PRIMARY);
  let started: () => void = () => {};
  onPlay(() => started());
  for (let index = 0; index < INTERRUPTION_COUNT; index += 1) {
    const playing = new Promise<void>((resolve) => {
      started = resolve;
    });
    queue.enqueue(line(`ev-${index}`, profile));
    queue.enqueue(line(`dropped-${index}`, profile));
    await playing;
    bargeIn();
    bargeIn();
    await queue.idle();
    assert.equal(queue.playing(), false);
  }
  assert.equal(played.length, INTERRUPTION_COUNT);
  assert.ok(played.every(({ utteranceEventId }) => utteranceEventId.startsWith('ev-')));
  assert.equal(hanging.calls, INTERRUPTION_COUNT);
  assert.ok(events.some((event) => event.kind === 'interrupted' && event.dropped === 1));
  hanging.mode = 'ok';
  queue.enqueue(line('after', profile));
  await queue.idle();
  assert.deepEqual(finalIds(played), ['after']);
  assertCampaignUnchanged();
});

test('a provider crashing before audio falls back, and the circuit breaker stops retrying it', async () => {
  const primary = fakeTts(PRIMARY, 'crash-before-audio');
  const backup = fakeTts(BACKUP);
  const protectedPrimary = withCircuitBreaker(primary, { now: () => CLOCK_MS });
  const { queue, played } = harness([protectedPrimary, backup]);
  const profile = profileFor(PRIMARY, BACKUP);
  for (let index = 0; index < TTS_FAILURE_THRESHOLD + 3; index += 1) {
    queue.enqueue(line(`ev-${index}`, profile));
    await queue.idle();
  }
  assert.equal(finalIds(played).length, TTS_FAILURE_THRESHOLD + 3);
  assert.ok(played.every(({ voiceId }) => voiceId === `${BACKUP}-voice`));
  const callsAtOpen = primary.calls;
  queue.enqueue(line('later', profile));
  await queue.idle();
  assert.equal(primary.calls, callsAtOpen);
  assertCampaignUnchanged();
});

test('a provider crashing mid segment ends that segment and the next one still plays', async () => {
  const primary = fakeTts(PRIMARY, 'crash-mid-segment');
  const { queue, played, events } = harness([primary]);
  const profile = profileFor(PRIMARY);
  queue.enqueue(line('ev-crash', profile));
  await queue.idle();
  primary.mode = 'ok';
  queue.enqueue(line('ev-next', profile));
  await queue.idle();
  assert.deepEqual(finalIds(played), ['ev-next']);
  assert.deepEqual(
    events.filter((event) => event.kind === 'subtitle' && event.state === 'end').map((event) => event.utteranceEventId),
    ['ev-crash', 'ev-next'],
  );
  assert.equal(queue.playing(), false);
  assertCampaignUnchanged();
});

test('switching provider mid session changes only the voice used', async () => {
  const primary = fakeTts(PRIMARY);
  const backup = fakeTts(BACKUP);
  const { queue, played } = harness([primary, backup]);
  const profile = profileFor(PRIMARY, BACKUP);
  for (let index = 0; index < SWITCH_AT * 2; index += 1) {
    if (index === SWITCH_AT) primary.healthyNow = false;
    queue.enqueue(line(`ev-${index}`, profile, `segment ${index}`));
    await queue.idle();
  }
  const voices = played.filter(({ final }) => final).map(({ voiceId }) => voiceId);
  assert.deepEqual(voices.slice(0, SWITCH_AT), Array(SWITCH_AT).fill(`${PRIMARY}-voice`));
  assert.deepEqual(voices.slice(SWITCH_AT), Array(SWITCH_AT).fill(`${BACKUP}-voice`));
  assertCampaignUnchanged();
});

const guardSession = () => {
  const kokoro = Object.assign(fakeTts(KOKORO_PROVIDER_ID), { capabilities: KOKORO_CAPABILITIES });
  const narrator = voicesFor('en')?.narrator ?? KOKORO_CAPABILITIES.voices[0] ?? '';
  const narratorProfile: VoiceProfile = {
    ...profileFor(KOKORO_PROVIDER_ID),
    fallbacks: [{ providerId: KOKORO_PROVIDER_ID, voiceId: narrator }],
  };
  const assigned = new Map<string, VoiceProfile>();
  const { campaignId, entities } = CAMPAIGN_STATE;
  const npcVoices = createNpcVoices({
    campaignId,
    language: narratorProfile.language,
    base: narratorProfile,
    installed: () => installedVoices([kokoro], narratorProfile.language),
    stored: (speakerId) => assigned.get(speakerId),
    assign: (speakerId, profile) => assigned.set(speakerId, profile),
    hintOf: (speakerId) => {
      const entity = entities[speakerId as keyof typeof entities];
      return entity !== undefined && 'gender' in entity ? { gender: entity.gender } : undefined;
    },
    notify: () => {},
  });
  const route = (segments: readonly { eventId: string; text: string; speakerId?: string }[]) =>
    routeSegments({
      committed: CAMPAIGN_STATE,
      segments,
      narrator: narratorProfile,
      profileOf: npcVoices.profileOf,
    });
  return { kokoro, narrator, route };
};

const SEGMENTS = [
  { eventId: 'ev-1', text: 'You descend into the torchlit dungeon.' },
  { eventId: 'ev-2', text: 'Halt! Who goes there?', speakerId: 'npc-guard' },
  { eventId: 'ev-3', text: 'State your business.', speakerId: 'npc-guard' },
];

const playAll = async (session: ReturnType<typeof guardSession>) => {
  const run = harness([session.kokoro]);
  for (const utterance of session.route(SEGMENTS)) run.queue.enqueue(utterance);
  await run.queue.idle();
  return run;
};

test('campaign reload rebuilds the session with the same voices and unchanged state', async () => {
  const first = await playAll(guardSession());
  const reloaded = await playAll(guardSession());
  const voicesOf = (played: readonly SpeechChunk[]) =>
    played.filter(({ final }) => final).map(({ voiceId }) => voiceId);
  assert.deepEqual(voicesOf(reloaded.played), voicesOf(first.played));
  assert.deepEqual(finalIds(reloaded.played), ['ev-1', 'ev-2', 'ev-3']);
  assertCampaignUnchanged();
});

test('concurrent enqueues and speed changes never duplicate or reorder lines', async () => {
  const provider = fakeTts(PRIMARY);
  const first = harness([provider]);
  const second = harness([provider]);
  const profile = profileFor(PRIMARY);
  const ids = Array.from({ length: 20 }, (_, index) => `ev-${index}`);
  await Promise.all(
    ids.flatMap((id) => [
      Promise.resolve().then(() => first.queue.enqueue(line(id, profile))),
      Promise.resolve().then(() => second.queue.enqueue(line(id, profile))),
      Promise.resolve().then(() => first.queue.setSpeed(1.5)),
    ]),
  );
  await Promise.all([first.queue.idle(), second.queue.idle()]);
  assert.deepEqual(finalIds(first.played), ids);
  assert.deepEqual(finalIds(second.played), ids);
  assert.equal(first.queue.speed(), 1.5);
  assertCampaignUnchanged();
});

test('mvp demo: narration, a guard with a different voice, the same voice again, then voice off and play continues', async () => {
  const session = guardSession();
  const { queue, played, events, speech } = harness([session.kokoro]);
  const [narration, guardFirst, guardSecond] = session.route(SEGMENTS) as [
    CommittedUtterance,
    CommittedUtterance,
    CommittedUtterance,
  ];
  for (const utterance of [narration, guardFirst, guardSecond]) queue.enqueue(utterance);
  await queue.idle();
  const voices = played.filter(({ final }) => final).map(({ voiceId }) => voiceId);
  assert.equal(voices[0], session.narrator);
  assert.notEqual(voices[1], session.narrator);
  assert.equal(voices[2], voices[1]);

  speech.settings = DISABLED;
  const playedBefore = played.length;
  queue.enqueue(line('ev-4', narration.profile, 'The guard waves you through.'));
  queue.enqueue(line('ev-5', narration.profile, 'You walk on.'));
  await queue.idle();
  assert.equal(played.length, playedBefore);
  assert.deepEqual(
    events.flatMap((event) =>
      event.kind === 'subtitle' && event.state === 'text-only' ? [event.utteranceEventId] : [],
    ),
    ['ev-4', 'ev-5'],
  );
  assertCampaignUnchanged();
});

test('a queue over a reopened file cache replays audio without calling the provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const provider = fakeTts(PRIMARY);
    const profile = profileFor(PRIMARY);
    const playThrough = async () => {
      const run = harness([provider]);
      const cache = createFileAudioCache(dir, PERSISTED_CACHE_BYTES);
      const queue = createOutputQueue({
        audioFormat: TEST_AUDIO_FORMAT,
        sink: run.sink,
        speech: run.speech,
        onEvent: () => {},
        ledger: run.ledger,
        cache,
      });
      queue.enqueue(line('ev-same', profile, 'same words'));
      await queue.idle();
      return run.played;
    };
    const first = await playThrough();
    const callsAfterFirst = provider.calls;
    const second = await playThrough();
    assert.equal(provider.calls, callsAfterFirst);
    assert.deepEqual(
      second.map(({ audio }) => audio),
      first.map(({ audio }) => audio),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
