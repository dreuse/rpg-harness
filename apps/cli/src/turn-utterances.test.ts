import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { playTurns } from '../../../packages/engine/src/character.ts';
import { loadState } from '../../../packages/engine/src/turn.ts';
import { VOICE_PROFILE_SET, voiceProfileOf } from '../../../packages/engine/src/voice-profile.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import type { VoiceProfile } from '../../../packages/voice/src/voice.ts';
import { createEngineGateway, FAKE_GAME_MASTER, openClientSession, readCampaignState } from './engine-gateway.ts';
import { assignedNpcVoices, utterancesFor } from './turn-utterances.ts';

const TEMP_PREFIX = 'rpg-turn-utterances-';
const CAMPAIGN = 'QuietTavern';
const NO_CHARACTER = async () => undefined;
const MONK_ID = 'npc-monk';
const GUARD_ID = 'npc-guard';
const GHOST_ID = 'npc-ghost';
const MONK_LINE = 'The shrine lies north.';
const GUARD_LINE = 'Move along.';
const NARRATOR_LINE = 'Rain taps the window.';
const SECOND_ACTION = 'look around';
const SECOND_ACTION_ID = 'typed-2';
const FAST = 1.5;
const WHISPER = { emotion: 'whisper', intensity: 0.4 };

const NARRATOR: VoiceProfile = {
  id: 'narrator',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [{ providerId: 'fake-tts', voiceId: 'narrator-voice' }],
};
const GUARD_PROFILE: VoiceProfile = {
  ...NARRATOR,
  id: GUARD_ID,
  fallbacks: [{ providerId: 'fake-tts', voiceId: 'guard' }],
};

const npc = (id: string, campaignId: string) => ({
  id,
  campaignId,
  kind: 'npc' as const,
  name: id,
  data: {},
  visibility: 'public' as const,
  actorId: null,
});

const setup = async (t: TestContext, narrator: VoiceProfile = NARRATOR) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  t.after(() => connection.close());
  const store = createCampaignStore(connection.database);
  const entities = createEntityStore(connection.database);
  entities.saveEntity(npc(MONK_ID, campaignId));
  entities.saveEntity(npc(GUARD_ID, campaignId));
  const stateOf = () => loadState(store, campaignId);
  const lastTurnId = () => stateOf().turns.at(-1)?.id ?? '';
  const guardCalls: string[] = [];
  const npcVoices = {
    profileOf: (speakerId: string) => {
      guardCalls.push(speakerId);
      return speakerId === GUARD_ID ? GUARD_PROFILE : undefined;
    },
  };
  const speak = (segments: Parameters<typeof utterancesFor>[0]['segments'], important?: ReadonlySet<string>) =>
    utterancesFor({
      store,
      entities,
      campaignId,
      turnId: lastTurnId(),
      segments,
      narrator,
      npcVoices,
      important,
    });
  const profileSets = (speakerId: string) =>
    stateOf().events.filter((event) => event.type === VOICE_PROFILE_SET && event.payload.speakerId === speakerId);
  const playSecondTurn = () => {
    const opened = openClientSession(dataDir, CAMPAIGN);
    try {
      const snapshot = opened.session.getSnapshot({
        version: PROTOCOL_VERSION,
        type: 'GetCampaignSnapshot',
        campaignId,
      });
      assert.ok(snapshot.ok);
      const submitted = opened.session.submitPlayerAction({
        version: PROTOCOL_VERSION,
        type: 'SubmitPlayerAction',
        campaignId,
        actionId: SECOND_ACTION_ID,
        expectedRevision: snapshot.value.revision,
        sceneId: snapshot.value.currentScene?.id ?? '',
        actorId: snapshot.value.characters[0]?.id ?? '',
        input: SECOND_ACTION,
      });
      assert.ok(submitted.ok);
    } finally {
      opened.close();
    }
  };
  const narrateAfterVoice = async () => {
    let requests = 0;
    const gm = {
      request: async () => {
        requests += 1;
        return { narration: MONK_LINE, segments: [{ text: MONK_LINE }] };
      },
      summarizer: FAKE_GAME_MASTER.summarizer,
    };
    const opened = openClientSession(dataDir, CAMPAIGN, gm);
    try {
      await opened.narrate();
      const snapshot = opened.session.getSnapshot({
        version: PROTOCOL_VERSION,
        type: 'GetCampaignSnapshot',
        campaignId,
      });
      assert.ok(snapshot.ok);
      return { turnCount: snapshot.value.turns.length, requests };
    } finally {
      opened.close();
    }
  };
  return {
    speak,
    narrateAfterVoice,
    stateOf,
    profileSets,
    playSecondTurn,
    guardCalls,
    store,
    entities,
    campaignId,
    lastTurnId,
  };
};

test('an important npc voice is persisted once and reused on the next turn', async (t: TestContext) => {
  const { speak, stateOf, profileSets, playSecondTurn } = await setup(t);
  const [first] = speak([{ speakerId: MONK_ID, text: MONK_LINE, important: true }]);
  assert.equal(profileSets(MONK_ID).length, 1);
  assert.deepEqual(first?.profile, voiceProfileOf(stateOf().events, MONK_ID));
  assert.equal(first?.profile.id, MONK_ID);
  assert.notDeepEqual(first?.profile, NARRATOR);

  playSecondTurn();
  const revision = stateOf().revision;
  const [second] = speak([{ speakerId: MONK_ID, text: MONK_LINE }], new Set([MONK_ID]));
  assert.deepEqual(second?.profile, first?.profile);
  assert.equal(profileSets(MONK_ID).length, 1);
  assert.equal(stateOf().revision, revision);
});

test('the saved speed paces an important npc without being persisted in its voice', async (t: TestContext) => {
  const { speak, stateOf } = await setup(t, { ...NARRATOR, pace: FAST });
  const [utterance] = speak([{ speakerId: MONK_ID, text: MONK_LINE, important: true }]);
  assert.equal(utterance?.profile.pace, FAST);
  assert.equal(voiceProfileOf(stateOf().events, MONK_ID)?.pace, NARRATOR.pace);
});

test('persisting a voice adds no play turn, snapshot turn or GM narration', async (t: TestContext) => {
  const { speak, stateOf, profileSets, narrateAfterVoice } = await setup(t);
  const before = playTurns(stateOf()).length;
  speak([{ speakerId: MONK_ID, text: MONK_LINE, important: true }]);
  assert.equal(profileSets(MONK_ID).length, 1);
  assert.equal(playTurns(stateOf()).length, before);
  assert.deepEqual(await narrateAfterVoice(), { turnCount: before, requests: 0 });
});

test('a rejected save keeps the regular voice path', async (t: TestContext) => {
  const { speak, guardCalls } = await setup(t);
  const [utterance] = speak([{ speakerId: GHOST_ID, text: MONK_LINE, important: true }]);
  assert.equal(utterance?.profile, NARRATOR);
  assert.deepEqual(guardCalls, [GHOST_ID]);
});

test('delivery from the GM segment reaches the utterance', async (t: TestContext) => {
  const { speak } = await setup(t);
  const [narrated, spoken] = speak([
    { text: NARRATOR_LINE },
    { speakerId: MONK_ID, text: MONK_LINE, important: true, delivery: WHISPER },
  ]);
  assert.equal(narrated?.delivery, undefined);
  assert.deepEqual(spoken?.delivery, WHISPER);
  assert.equal(narrated?.profile, NARRATOR);
});

test('a non-important npc keeps the regular voice path and persists nothing', async (t: TestContext) => {
  const { speak, profileSets, guardCalls } = await setup(t);
  const [utterance] = speak([{ speakerId: GUARD_ID, text: GUARD_LINE }]);
  assert.equal(utterance?.profile, GUARD_PROFILE);
  assert.deepEqual(guardCalls, [GUARD_ID]);
  assert.equal(profileSets(GUARD_ID).length, 0);
});

test('a player-chosen important set marks an npc without a GM hint', async (t: TestContext) => {
  const { speak, profileSets, guardCalls } = await setup(t);
  speak([{ speakerId: MONK_ID, text: MONK_LINE }], new Set([MONK_ID]));
  assert.equal(profileSets(MONK_ID).length, 1);
  assert.deepEqual(guardCalls, [MONK_ID]);
});

test('an important speaker that is not an npc speaks with the narrator voice and does not crash the turn', async (t: TestContext) => {
  const { speak, stateOf } = await setup(t);
  const revision = stateOf().revision;
  const utterances = speak([
    { speakerId: GHOST_ID, text: MONK_LINE, important: true },
    { speakerId: MONK_ID, text: GUARD_LINE, important: true },
  ]);
  assert.equal(utterances[0]?.profile, NARRATOR);
  assert.equal(utterances[0]?.speakerId, GHOST_ID);
  assert.equal(utterances[1]?.profile.id, MONK_ID);
  assert.equal(stateOf().revision, revision + 1);
});

test('rpg-cm63.18: an assigned character voice is used when that npc speaks', async (t: TestContext) => {
  const { store, entities, campaignId, lastTurnId } = await setup(t);
  const assigned = { providerId: 'fake-tts', voiceId: 'assigned' };
  const npcVoices = assignedNpcVoices({ entities, campaignId, narrator: NARRATOR, assigned: { [GUARD_ID]: assigned } });
  assert.deepEqual(npcVoices.profileOf(GUARD_ID), {
    ...NARRATOR,
    id: GUARD_ID,
    fallbacks: [assigned, ...NARRATOR.fallbacks],
  });
  assert.equal(npcVoices.profileOf(MONK_ID), undefined);
  assert.equal(npcVoices.profileOf('missing'), undefined);
  const spoken = utterancesFor({
    store,
    entities,
    campaignId,
    turnId: lastTurnId(),
    segments: [
      { speakerId: GUARD_ID, text: GUARD_LINE },
      { speakerId: MONK_ID, text: MONK_LINE },
    ],
    narrator: NARRATOR,
    npcVoices,
  });
  assert.equal(spoken.find(({ text }) => text === GUARD_LINE)?.profile.fallbacks[0]?.voiceId, 'assigned');
  assert.notEqual(spoken.find(({ text }) => text === MONK_LINE)?.profile.fallbacks[0]?.voiceId, 'assigned');
});

const FEMALE_VOICE = { providerId: 'fake-tts', voiceId: 'af_quiet' };
const MALE_VOICE = { providerId: 'fake-tts', voiceId: 'am_gruff' };
const INSTALLED = [FEMALE_VOICE, MALE_VOICE];

const autoSpeech = async (t: TestContext, installed: readonly (typeof FEMALE_VOICE)[] = INSTALLED) => {
  const base = await setup(t);
  const { store, entities, campaignId, lastTurnId } = base;
  const speakAuto = (
    segments: Parameters<typeof utterancesFor>[0]['segments'],
    assigned: Parameters<typeof assignedNpcVoices>[0]['assigned'] = {},
  ) =>
    utterancesFor({
      store,
      entities,
      campaignId,
      turnId: lastTurnId(),
      segments,
      narrator: NARRATOR,
      npcVoices: assignedNpcVoices({ entities, campaignId, narrator: NARRATOR, assigned }),
      installed: () => installed,
    });
  return { ...base, speakAuto };
};

test('rpg-cm63.27: an unassigned npc gets a deterministic installed voice that is stored', async (t: TestContext) => {
  const { speakAuto, stateOf, profileSets } = await autoSpeech(t);
  const [utterance] = speakAuto([{ speakerId: GUARD_ID, text: GUARD_LINE }]);
  assert.equal(utterance?.profile.id, GUARD_ID);
  assert.ok(INSTALLED.some((voice) => voice.voiceId === utterance?.profile.fallbacks[0]?.voiceId));
  assert.equal(profileSets(GUARD_ID).length, 1);
  assert.deepEqual(voiceProfileOf(stateOf().events, GUARD_ID), utterance?.profile);
});

test('rpg-cm63.27: the next turn reuses the stored npc voice without a new event', async (t: TestContext) => {
  const { speakAuto, stateOf, profileSets, playSecondTurn } = await autoSpeech(t);
  const [first] = speakAuto([{ speakerId: GUARD_ID, text: GUARD_LINE }]);
  playSecondTurn();
  const revision = stateOf().revision;
  const [second] = speakAuto([{ speakerId: GUARD_ID, text: GUARD_LINE }]);
  assert.deepEqual(second?.profile, first?.profile);
  assert.equal(profileSets(GUARD_ID).length, 1);
  assert.equal(stateOf().revision, revision);
});

test('rpg-cm63.27: a player-assigned name wins over the automatic pick', async (t: TestContext) => {
  const { speakAuto, profileSets } = await autoSpeech(t);
  const assigned = { providerId: 'fake-tts', voiceId: 'chosen' };
  const [utterance] = speakAuto([{ speakerId: GUARD_ID, text: GUARD_LINE }], { [GUARD_ID]: assigned });
  assert.equal(utterance?.profile.fallbacks[0]?.voiceId, 'chosen');
  assert.equal(profileSets(GUARD_ID).length, 0);
});

test('rpg-cm63.27: without installed voices the narrator voice is used and nothing is stored', async (t: TestContext) => {
  const { speakAuto, profileSets, stateOf } = await autoSpeech(t, []);
  const revision = stateOf().revision;
  const [utterance] = speakAuto([{ speakerId: GUARD_ID, text: GUARD_LINE }]);
  assert.equal(utterance?.profile, NARRATOR);
  assert.equal(profileSets(GUARD_ID).length, 0);
  assert.equal(stateOf().revision, revision);
});

test('rpg-cm63.27: the narrator and non-npc speakers never get a pick', async (t: TestContext) => {
  const { speakAuto, profileSets, stateOf } = await autoSpeech(t);
  const revision = stateOf().revision;
  const utterances = speakAuto([
    { speakerId: 'narrator', text: NARRATOR_LINE },
    { speakerId: GHOST_ID, text: MONK_LINE },
  ]);
  assert.ok(utterances.every(({ profile }) => profile === NARRATOR));
  assert.equal(profileSets('narrator').length + profileSets(GHOST_ID).length, 0);
  assert.equal(stateOf().revision, revision);
});

test('rpg-cm63.27: an entity gender narrows the automatic pick', async (t: TestContext) => {
  const { speakAuto, entities, campaignId } = await autoSpeech(t);
  entities.saveEntity({ ...npc(MONK_ID, campaignId), data: { gender: 'male' } });
  const [utterance] = speakAuto([{ speakerId: MONK_ID, text: MONK_LINE }]);
  assert.deepEqual(utterance?.profile.fallbacks, [MALE_VOICE]);
});

test('rpg-cm63.27: an important npc keeps the cinematic voice over the automatic pick', async (t: TestContext) => {
  const { speakAuto, stateOf } = await autoSpeech(t);
  const [utterance] = speakAuto([{ speakerId: MONK_ID, text: MONK_LINE, important: true }]);
  assert.deepEqual(utterance?.profile, voiceProfileOf(stateOf().events, MONK_ID));
  assert.equal(stateOf().events.filter((event) => event.type === VOICE_PROFILE_SET).length, 1);
});

test('rpg-cm63.27: the saved speed paces an automatic npc voice without being persisted', async (t: TestContext) => {
  const { store, entities, campaignId, lastTurnId, stateOf } = await autoSpeech(t);
  const [utterance] = utterancesFor({
    store,
    entities,
    campaignId,
    turnId: lastTurnId(),
    segments: [{ speakerId: GUARD_ID, text: GUARD_LINE }],
    narrator: { ...NARRATOR, pace: FAST },
    npcVoices: assignedNpcVoices({ entities, campaignId, narrator: NARRATOR, assigned: {} }),
    installed: () => INSTALLED,
  });
  assert.equal(utterance?.profile.pace, FAST);
  assert.equal(voiceProfileOf(stateOf().events, GUARD_ID)?.pace, NARRATOR.pace);
});
