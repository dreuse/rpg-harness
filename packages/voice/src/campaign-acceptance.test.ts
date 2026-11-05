import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION, type Result, type SubmitPlayerAction } from '../../client-protocol/src/protocol.ts';
import { createVoiceActionSubmitter, type RecoveryEvent, transcribeTurn } from './fallback.ts';
import { createOutputQueue } from './playback.ts';
import { NARRATOR_SPEAKER, type OutputSegment, routeSegments } from './speaker-routing.ts';
import { createSubtitleTranscript, type SubtitleTranscript } from './subtitles.ts';
import { TEST_AUDIO_FORMAT } from './test-audio-format.ts';
import type { TtsProvider } from './tts.ts';
import { createTurnDetector, type TurnOptions, type VoiceTurn } from './turns.ts';
import type { AudioInputProvider, VoiceProfile, VoiceSettings } from './voice.ts';
import { type RequestSource, routeVoiceInput, type VoicePreferences, type VoiceSession } from './voice-settings.ts';

const STT_ID = 'fake-stt';
const TTS_ID = 'fake-tts';
const CAMPAIGN_ID = 'c1';
const SCENE_ID = 'scene-1';
const HERO_ID = 'hero-1';
const INNKEEPER = 'npc-innkeeper';
const MONK = 'npc-monk';
const EVENT_PREFIX = 'ev-';
const TURN_PREFIX = 'turn-';
const EMPTY_LOG = '[]';
const PLAYER_ACTED = 'PlayerActed';
const NARRATED = 'Narrated';
const VOICE_PROFILE_SET = 'VoiceProfileSet';
const EN_GB = 'en-GB';
const PT_BR = 'pt-BR';
const JA_JP = 'ja-JP';
const LOCALES = [EN_GB, PT_BR, JA_JP];
const TURN_OPTIONS: TurnOptions = { speechChunksToStart: 2, silenceChunksToEnd: 2, minTurnChunks: 2 };
const SPEECH_CHUNKS = 2;
const STT_CONFIDENCE = 0.95;
const STT_END_MS = 900;
const RATE = { unit: 'char', currency: 'USD', pricePerUnit: 0 };
const BUDGET = 10;
const TTS_OUTAGE = 'tts provider down';
const STT_OUTAGE = 'stt provider down';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GREET = 'greet the innkeeper';
const ASK_MONK = 'ask the monk about the shrine';
const LOOK = 'look out the window';
const FOLLOW = 'follow the monk';
const VOICE_OFF = 'set mic to off and output to off';
const VOICE_ON = 'set mic to push-to-talk and output to full';
const FALLBACK_NARRATION = 'Nothing happens.';

const SCRIPT: Readonly<Record<string, readonly Omit<OutputSegment, 'eventId'>[]>> = {
  [GREET]: [{ text: 'The tavern falls quiet.' }, { speakerId: INNKEEPER, text: 'Bem-vindo, viajante.' }],
  [ASK_MONK]: [{ text: 'The monk looks up.' }, { speakerId: MONK, text: '神社は北にあります。' }],
  [LOOK]: [{ text: 'Rain taps the shutters.' }, { speakerId: INNKEEPER, text: 'Mais vinho?' }],
  [FOLLOW]: [
    { speakerId: MONK, text: 'ついて来てください。' },
    { speakerId: INNKEEPER, text: 'Boa sorte!' },
  ],
};

const profile = (id: string, language: string): VoiceProfile => ({
  id,
  language,
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: TTS_ID, voiceId: `voice-${id}` }],
});

const NARRATOR_PROFILE = profile(NARRATOR_SPEAKER, EN_GB);
const INNKEEPER_PROFILE = profile(INNKEEPER, PT_BR);
const MONK_PROFILE = profile(MONK, JA_JP);

const CONSENT: VoiceSettings['consent'] = {
  granted: true,
  grantedAt: '2026-11-04T00:00:00Z',
  providerIds: [STT_ID, TTS_ID],
};

const VOICE_ENABLED: VoicePreferences = { microphone: 'push-to-talk', spokenOutput: 'full', locale: EN_GB, speed: 1 };
const VOICE_DISABLED: VoicePreferences = { ...VOICE_ENABLED, microphone: 'off', spokenOutput: 'off' };

interface CanonicalEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface Committed {
  readonly events: readonly CanonicalEvent[];
  readonly segments: readonly OutputSegment[];
}

const openCampaign = (persisted = EMPTY_LOG) => {
  const events = JSON.parse(persisted) as CanonicalEvent[];
  const append = (type: string, payload: CanonicalEvent['payload']): CanonicalEvent => {
    const event = { id: `${EVENT_PREFIX}${events.length}`, type, payload };
    events.push(event);
    return event;
  };
  return {
    assignVoice: (speakerId: string, voice: VoiceProfile) =>
      void append(VOICE_PROFILE_SET, { speakerId, profile: voice }),
    profileOf: (speakerId: string) =>
      events.findLast((event) => event.type === VOICE_PROFILE_SET && event.payload.speakerId === speakerId)?.payload
        .profile as VoiceProfile | undefined,
    act: (input: string): Committed => {
      const first = events.length;
      append(PLAYER_ACTED, { actorId: HERO_ID, input });
      const reply = SCRIPT[input] ?? [{ text: FALLBACK_NARRATION }];
      const segments = reply.map((segment) => ({ ...segment, eventId: append(NARRATED, segment).id }));
      return { events: events.slice(first), segments };
    },
    revision: () => events.length,
    persist: () => JSON.stringify(events),
  };
};

type Campaign = ReturnType<typeof openCampaign>;

const startCampaign = (): Campaign => {
  const campaign = openCampaign();
  campaign.assignVoice(INNKEEPER, INNKEEPER_PROFILE);
  campaign.assignVoice(MONK, MONK_PROFILE);
  return campaign;
};

type Voiced = readonly [speakerId: string, language: string, voiceId: string];

const createDevices = (voiced: Voiced[]) => {
  const outage = { active: false };
  const stt: AudioInputProvider = {
    id: STT_ID,
    locality: 'local',
    retention: 'none',
    async *transcribe(audio) {
      const heard: Uint8Array[] = [];
      for await (const chunk of audio) heard.push(chunk);
      if (outage.active) throw new Error(STT_OUTAGE);
      const text = decoder.decode(heard[0]);
      yield {
        id: 'seg-1',
        text,
        startMs: 0,
        endMs: STT_END_MS,
        confidence: STT_CONFIDENCE,
        final: true,
        locale: EN_GB,
      };
    },
  };
  const tts: TtsProvider = {
    id: TTS_ID,
    locality: 'local',
    retention: 'none',
    async *synthesize(item, voiceId) {
      if (outage.active) throw new Error(TTS_OUTAGE);
      voiced.push([item.speakerId, item.profile.language, voiceId]);
      yield {
        utteranceEventId: item.eventId,
        sequence: 0,
        audio: encoder.encode(item.text),
        mimeType: 'audio/mpeg',
        voiceId,
        final: true,
      };
    },
  };
  return {
    stt,
    tts,
    failAll: () => {
      outage.active = true;
    },
  };
};

type Devices = ReturnType<typeof createDevices>;

const settingsOf = ({ microphone, spokenOutput }: VoicePreferences): VoiceSettings => ({
  microphone,
  spokenOutput,
  consent: CONSENT,
});

const capture = (settings: VoiceSettings, turnId: string, text: string): VoiceTurn | undefined => {
  const turns: VoiceTurn[] = [];
  const detector = createTurnDetector({
    settings,
    options: TURN_OPTIONS,
    isSpeech: (chunk) => chunk.length > 0,
    nextId: () => turnId,
    now: () => 0,
    onTurn: (turn) => turns.push(turn),
  });
  detector.start('push-to-talk');
  detector.press();
  for (let pushed = 0; pushed < SPEECH_CHUNKS; pushed += 1) detector.push(encoder.encode(text));
  detector.release();
  return turns[0];
};

const speak = async (
  committed: Committed,
  campaign: Campaign,
  settings: VoiceSettings,
  devices: Devices,
  transcript: SubtitleTranscript,
) => {
  const queue = createOutputQueue({
    audioFormat: TEST_AUDIO_FORMAT,
    sink: { play: async () => {} },
    speech: { settings, providers: [devices.tts], rate: RATE, budget: BUDGET },
    onEvent: (event) => transcript.onPlayback(event),
  });
  const routed = routeSegments({
    committed,
    segments: committed.segments,
    narrator: NARRATOR_PROFILE,
    profileOf: campaign.profileOf,
  });
  for (const line of routed) {
    transcript.commit(line);
    queue.enqueue(line);
  }
  await queue.idle();
};

type Step =
  | { readonly kind: 'typed' | 'spoken'; readonly text: string }
  | { readonly kind: 'outage' }
  | { readonly kind: 'restart' };

const typed = (text: string): Step => ({ kind: 'typed', text });
const spoken = (text: string): Step => ({ kind: 'spoken', text });
const OUTAGE: Step = { kind: 'outage' };
const RESTART: Step = { kind: 'restart' };

const runCampaign = async (steps: readonly Step[], preferences: VoicePreferences) => {
  const voiced: Voiced[] = [];
  const actions: [RequestSource, string][] = [];
  const failures: RecoveryEvent[] = [];
  const transcript = createSubtitleTranscript();
  let campaign = startCampaign();
  let devices = createDevices(voiced);
  let session: VoiceSession = { campaignId: CAMPAIGN_ID, turn: 0, pendingInput: [], preferences };
  const pending: Committed[] = [];
  const act = (source: RequestSource, input: string) => {
    actions.push([source, input]);
    pending.push(campaign.act(input));
    return campaign.revision();
  };
  const connect = () =>
    createVoiceActionSubmitter({
      submitPlayerAction: (command: SubmitPlayerAction): Result<{ revision: number }> => ({
        ok: true,
        value: { revision: act('spoken', command.input) },
      }),
    });
  let submitVoice = connect();

  for (const [index, step] of steps.entries()) {
    if (step.kind === 'restart') {
      campaign = openCampaign(campaign.persist());
      devices = createDevices(voiced);
      submitVoice = connect();
      continue;
    }
    if (step.kind === 'outage') {
      devices.failAll();
      continue;
    }
    const settings = settingsOf(session.preferences);
    const turn = step.kind === 'spoken' ? capture(settings, `${TURN_PREFIX}${index}`, step.text) : undefined;
    const heard = turn
      ? await transcribeTurn({
          settings,
          providers: [devices.stt],
          providerId: STT_ID,
          turn,
          onEvent: (event) => failures.push(event),
        })
      : undefined;
    const route =
      heard?.kind === 'transcript'
        ? routeVoiceInput(
            session,
            { source: 'spoken', text: heard.segments.map(({ text }) => text).join(' ') },
            LOCALES,
            (input) =>
              submitVoice(heard.turnId, {
                version: PROTOCOL_VERSION,
                type: 'SubmitPlayerAction',
                campaignId: CAMPAIGN_ID,
                expectedRevision: campaign.revision(),
                sceneId: SCENE_ID,
                actorId: HERO_ID,
                input,
              }),
          )
        : routeVoiceInput(session, { source: 'typed', text: step.text }, LOCALES, (input) => act('typed', input));
    if (route.kind === 'settings') session = route.session;
    for (const committed of pending.splice(0)) {
      await speak(committed, campaign, settingsOf(session.preferences), devices, transcript);
    }
  }
  return { persisted: campaign.persist(), voiced, actions, failures, transcript };
};

const narratedIds = (persisted: string): string[] =>
  (JSON.parse(persisted) as CanonicalEvent[]).filter(({ type }) => type === NARRATED).map(({ id }) => id);

test('run mixed text/speech campaign with narrator, persistent npc voices and resume', async () => {
  const steps = [typed(GREET), spoken(ASK_MONK), RESTART, spoken(FOLLOW)];
  const voiceOn = await runCampaign(steps, VOICE_ENABLED);
  const voiceOff = await runCampaign(steps, VOICE_DISABLED);

  const narrator: Voiced = [NARRATOR_SPEAKER, EN_GB, 'voice-narrator'];
  const innkeeper: Voiced = [INNKEEPER, PT_BR, `voice-${INNKEEPER}`];
  const monk: Voiced = [MONK, JA_JP, `voice-${MONK}`];
  assert.deepEqual(voiceOn.voiced, [narrator, innkeeper, narrator, monk, monk, innkeeper]);
  assert.deepEqual(voiceOn.actions, [
    ['typed', GREET],
    ['spoken', ASK_MONK],
    ['spoken', FOLLOW],
  ]);
  assert.deepEqual(
    voiceOn.transcript.entries().map(({ eventId, status }) => [eventId, status]),
    narratedIds(voiceOn.persisted).map((id) => [id, 'spoken']),
  );

  const log = JSON.parse(voiceOn.persisted) as CanonicalEvent[];
  assert.deepEqual(
    log.filter(({ type }) => type === PLAYER_ACTED).map(({ payload }) => payload.input),
    [GREET, ASK_MONK, FOLLOW],
  );
  assert.deepEqual(
    log.map(({ id }) => id),
    log.map((_, index) => `${EVENT_PREFIX}${index}`),
  );

  assert.deepEqual(voiceOff.voiced, []);
  assert.deepEqual(voiceOff.actions, [
    ['typed', GREET],
    ['typed', ASK_MONK],
    ['typed', FOLLOW],
  ]);
  assert.equal(voiceOn.persisted, voiceOff.persisted);
});

test('voice toggle, provider failure and game restart preserve canonical state', async () => {
  const steps = [
    spoken(GREET),
    typed(VOICE_OFF),
    spoken(ASK_MONK),
    typed(VOICE_ON),
    OUTAGE,
    spoken(LOOK),
    RESTART,
    spoken(FOLLOW),
  ];
  const toggles = new Set([VOICE_OFF, VOICE_ON]);
  const voiceOn = await runCampaign(steps, VOICE_ENABLED);
  const voiceOff = await runCampaign(
    steps.filter((step) => !('text' in step && toggles.has(step.text))),
    VOICE_DISABLED,
  );

  assert.equal(voiceOn.persisted, voiceOff.persisted);
  assert.deepEqual(voiceOn.actions, [
    ['spoken', GREET],
    ['typed', ASK_MONK],
    ['typed', LOOK],
    ['spoken', FOLLOW],
  ]);
  assert.deepEqual(
    voiceOn.failures.map((event) => event.kind === 'audio-failure' && [event.channel, event.attempt, event.next]),
    [
      ['stt', 1, 'retry'],
      ['stt', 2, 'text'],
    ],
  );

  const [greet, askMonk, look, follow] = [GREET, ASK_MONK, LOOK, FOLLOW].map((input) =>
    (SCRIPT[input] ?? []).map(({ text }) => text),
  );
  const outcome = (status: string, reason?: string) => (text: string) => [text, status, reason];
  assert.deepEqual(
    voiceOn.transcript.entries().map(({ text, status, reason }) => [text, status, reason]),
    [
      ...(greet ?? []).map(outcome('spoken')),
      ...(askMonk ?? []).map(outcome('text-only', 'voice-off')),
      ...(look ?? []).map(outcome('text-only', 'provider-error')),
      ...(follow ?? []).map(outcome('spoken')),
    ],
  );
  for (const run of [voiceOn, voiceOff]) {
    assert.deepEqual(
      run.transcript.entries().map(({ eventId }) => eventId),
      narratedIds(run.persisted),
    );
  }
  assert.deepEqual(
    voiceOff.transcript.entries().map(({ status, reason }) => [status, reason]),
    narratedIds(voiceOff.persisted).map(() => ['text-only', 'voice-off']),
  );
});
