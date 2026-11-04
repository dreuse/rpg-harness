import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type ClientSession, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignEvent, CampaignState } from '../../../packages/domain/src/campaign.ts';
import { NARRATOR_SPEAKER, type VoiceProfile } from '../../../packages/domain/src/voice.ts';
import { loadState, type PlayerAction } from '../../../packages/engine/src/turn.ts';
import { setVoiceProfile, voiceProfileOf } from '../../../packages/engine/src/voice-profile.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import {
  createVoiceActionSubmitter,
  transcribeTurn,
  type VoiceActionCommand,
  voiceActionId,
} from '../../../packages/voice/src/fallback.ts';
import { routeSegments } from '../../../packages/voice/src/speaker-routing.ts';
import type { VoiceTurn } from '../../../packages/voice/src/turns.ts';
import type { AudioInputProvider, VoiceSettings } from '../../../packages/voice/src/voice.ts';
import { createEngineGateway, openClientSession, readCampaignState } from './engine-gateway.ts';

const TEMP_PREFIX = 'rpg-voice-restart-';
const CAMPAIGN = 'QuietTavern';
const DATABASE_FILE = `${CAMPAIGN}.sqlite`;
const NO_CHARACTER = async () => undefined;
const INNKEEPER_ID = 'npc-innkeeper';
const MONK_ID = 'npc-monk';
const NPC_KIND = 'npc' as const;
const PUBLIC = 'public' as const;
const STT_ID = 'fake-stt';
const TTS_ID = 'fake-tts';
const EN_GB = 'en-GB';
const PT_BR = 'pt-BR';
const PACE = 1;
const STYLE = 'calm';
const VOICE_PREFIX = 'voice-';
const SPOKEN_TURN_ID = 'turn-spoken';
const PUSH_TO_TALK = 'push-to-talk';
const FULL_OUTPUT = 'full';
const CONSENT_GRANTED_AT = '2026-11-04T00:00:00Z';
const LOCAL = 'local';
const NO_RETENTION = 'none';
const TRANSCRIPT = 'transcript';
const WORD_SEPARATOR = ' ';
const STT_SEGMENT_ID = 'seg-1';
const STT_START_MS = 0;
const STT_END_MS = 900;
const STT_CONFIDENCE = 0.95;
const SPOKEN = 'ask the monk about the shrine';
const TYPED = 'greet the innkeeper';
const TYPED_AFTER_RESTART = 'look out the window';
const NARRATOR_LINE = 'The tavern falls quiet.';
const INNKEEPER_LINE = 'Bem-vindo, viajante.';
const MONK_LINE = 'The shrine lies north.';
const NARRATOR_ACTION = 'voice-narrator';
const INNKEEPER_ACTION = 'voice-innkeeper';
const TYPED_ACTION = 'typed-1';
const TYPED_AFTER_RESTART_ACTION = 'typed-2';
const SET_VOICE_INTENT = 'set voice';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const profile = (id: string, language: string): VoiceProfile => ({
  id,
  language,
  pace: PACE,
  style: STYLE,
  pronunciations: {},
  fallbacks: [{ providerId: TTS_ID, voiceId: `${VOICE_PREFIX}${id}` }],
});

const NARRATOR_PROFILE = profile(NARRATOR_SPEAKER, EN_GB);
const INNKEEPER_PROFILE = profile(INNKEEPER_ID, PT_BR);

const SETTINGS: VoiceSettings = {
  microphone: PUSH_TO_TALK,
  spokenOutput: FULL_OUTPUT,
  consent: { granted: true, grantedAt: CONSENT_GRANTED_AT, providerIds: [STT_ID] },
};

const STT: AudioInputProvider = {
  id: STT_ID,
  locality: LOCAL,
  retention: NO_RETENTION,
  async *transcribe(audio) {
    const heard: Uint8Array[] = [];
    for await (const chunk of audio) heard.push(chunk);
    yield {
      id: STT_SEGMENT_ID,
      text: decoder.decode(heard[0]),
      startMs: STT_START_MS,
      endMs: STT_END_MS,
      confidence: STT_CONFIDENCE,
      final: true,
      locale: EN_GB,
    };
  },
};

const spokenTurn = (text: string): VoiceTurn => ({
  id: SPOKEN_TURN_ID,
  mode: PUSH_TO_TALK,
  chunks: [encoder.encode(text)],
  startedAt: STT_START_MS,
  endedAt: STT_END_MS,
});

const npc = (id: string, campaignId: string) => ({
  id,
  campaignId,
  kind: NPC_KIND,
  name: id,
  data: {},
  visibility: PUBLIC,
  actorId: null,
});

const withDatabase = <T>(dataDir: string, run: (path: string) => T): T => run(join(dataDir, DATABASE_FILE));

const inStores = <T>(
  dataDir: string,
  run: (stores: { store: ReturnType<typeof createCampaignStore>; entities: ReturnType<typeof createEntityStore> }) => T,
): T =>
  withDatabase(dataDir, (path) => {
    const connection = openDatabase(path);
    try {
      return run({
        store: createCampaignStore(connection.database),
        entities: createEntityStore(connection.database),
      });
    } finally {
      connection.close();
    }
  });

const inClient = <T>(dataDir: string, run: (session: ClientSession, campaignId: string) => T | Promise<T>) => {
  const opened = openClientSession(dataDir, CAMPAIGN);
  return Promise.resolve(run(opened.session, opened.campaignId)).finally(opened.close);
};

const commandFor = (session: ClientSession, campaignId: string, input: string): VoiceActionCommand => {
  const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.ok(snapshot.ok);
  const sceneId = snapshot.value.currentScene?.id;
  const actorId = snapshot.value.characters[0]?.id;
  assert.ok(sceneId && actorId);
  return {
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId,
    expectedRevision: snapshot.value.revision,
    sceneId,
    actorId,
    input,
  };
};

const assignmentFor = (
  store: ReturnType<typeof createCampaignStore>,
  campaignId: string,
  actionId: string,
): PlayerAction => {
  const state = loadState(store, campaignId);
  const sceneId = state.currentScene?.id;
  const actorId = state.characters[0]?.id;
  assert.ok(sceneId && actorId);
  return {
    campaignId,
    actionId,
    expectedRevision: state.revision,
    sceneId,
    actorId,
    input: SET_VOICE_INTENT,
    intent: SET_VOICE_INTENT,
  };
};

const speakTurn = async (session: ClientSession, campaignId: string) => {
  const heard = await transcribeTurn({
    settings: SETTINGS,
    providers: [STT],
    providerId: STT_ID,
    turn: spokenTurn(SPOKEN),
  });
  assert.equal(heard.kind, TRANSCRIPT);
  const input = heard.segments.map(({ text }) => text).join(WORD_SEPARATOR);
  return createVoiceActionSubmitter(session)(heard.turnId, commandFor(session, campaignId, input));
};

const profilesOf = (events: readonly CampaignEvent[]) => [
  voiceProfileOf(events, NARRATOR_SPEAKER),
  voiceProfileOf(events, INNKEEPER_ID),
  voiceProfileOf(events, MONK_ID),
];

const spokenTurnOf = ({ turns }: CampaignState) =>
  turns.find(({ actionId }) => actionId === voiceActionId(SPOKEN_TURN_ID));

const routedProfiles = (state: CampaignState) => {
  const { events } = state;
  const turnId = spokenTurnOf(state)?.id;
  const committed = { events: events.filter((event) => event.turnId === turnId) };
  const eventId = committed.events[0]?.id;
  const narrator = voiceProfileOf(events, NARRATOR_SPEAKER);
  assert.ok(eventId && narrator);
  return routeSegments({
    committed,
    segments: [
      { eventId, text: NARRATOR_LINE },
      { eventId, speakerId: INNKEEPER_ID, text: INNKEEPER_LINE },
      { eventId, speakerId: MONK_ID, text: MONK_LINE },
    ],
    narrator,
    profileOf: (speakerId) => voiceProfileOf(events, speakerId),
  }).map(({ speakerId, profile: routed }) => [speakerId, routed]);
};

test('voice profiles survive a restart of a mixed text and speech campaign on sqlite', async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;

  const innkeeperAssignment = inStores(dataDir, ({ store, entities }) => {
    entities.saveEntity(npc(INNKEEPER_ID, campaignId));
    entities.saveEntity(npc(MONK_ID, campaignId));
    setVoiceProfile(store, entities, {
      ...assignmentFor(store, campaignId, NARRATOR_ACTION),
      speakerId: NARRATOR_SPEAKER,
      profile: NARRATOR_PROFILE,
    });
    const assignment = {
      ...assignmentFor(store, campaignId, INNKEEPER_ACTION),
      speakerId: INNKEEPER_ID,
      profile: INNKEEPER_PROFILE,
    };
    setVoiceProfile(store, entities, assignment);
    return assignment;
  });

  const spoken = await inClient(dataDir, async (session) => {
    assert.ok(session.submitPlayerAction({ ...commandFor(session, campaignId, TYPED), actionId: TYPED_ACTION }).ok);
    const result = await speakTurn(session, campaignId);
    assert.ok(result.ok);
    return result.value;
  });

  const expected = [NARRATOR_PROFILE, INNKEEPER_PROFILE, undefined];
  const reloaded = readCampaignState(dataDir, CAMPAIGN);
  assert.deepEqual(profilesOf(reloaded.events), expected);
  assert.equal(spokenTurnOf(reloaded)?.input, SPOKEN);
  assert.deepEqual(routedProfiles(reloaded), [
    [NARRATOR_SPEAKER, NARRATOR_PROFILE],
    [INNKEEPER_ID, INNKEEPER_PROFILE],
    [MONK_ID, NARRATOR_PROFILE],
  ]);

  await inClient(dataDir, async (session) => {
    const replayed = await speakTurn(session, campaignId);
    assert.deepEqual(replayed, { ok: true, value: spoken });
    const typed = session.submitPlayerAction({
      ...commandFor(session, campaignId, TYPED_AFTER_RESTART),
      actionId: TYPED_AFTER_RESTART_ACTION,
    });
    assert.ok(typed.ok);
  });

  inStores(dataDir, ({ store, entities }) => {
    const revision = loadState(store, campaignId).revision;
    assert.equal(setVoiceProfile(store, entities, innkeeperAssignment).turn.actionId, INNKEEPER_ACTION);
    assert.equal(loadState(store, campaignId).revision, revision);
  });
  assert.deepEqual(profilesOf(readCampaignState(dataDir, CAMPAIGN).events), expected);
});
