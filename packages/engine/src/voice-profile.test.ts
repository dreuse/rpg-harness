import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CampaignStore } from '../../domain/src/campaign.ts';
import { NARRATOR_SPEAKER, type VoiceProfile } from '../../domain/src/voice.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore } from '../../persistence/src/entity-store.ts';
import { InvalidActionError, type PlayerAction } from './turn.ts';
import {
  setVoiceProfile,
  setVoiceTraits,
  VOICE_PROFILE_SET,
  VOICE_TRAITS_SET,
  voiceProfileOf,
} from './voice-profile.ts';

const TEMP_PREFIX = 'rpg-voice-profile-';
const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const WARDEN_ID = 'npc-warden';
const PIER_ID = 'location-pier';
const API_KEY = 'sk-live-do-not-leak';
const HIDDEN_PLAN = 'the warden plans to flood the vault';
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const SETUP_TURN = {
  id: 'turn-0',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'setup',
  actorId: MARA.id,
  input: 'Begin.',
  narration: 'A lantern sways at the end of the pier.',
};
const NARRATOR: VoiceProfile = {
  id: 'narrator-voice',
  language: 'pt-BR',
  pace: 0.9,
  style: 'warm and measured',
  pronunciations: { Aelric: 'AYL-rick' },
  fallbacks: [{ providerId: 'local-tts', voiceId: 'luna' }],
};
const WARDEN: VoiceProfile = {
  id: 'warden-voice',
  language: 'en-GB',
  pace: 1.1,
  style: 'gruff',
  pronunciations: {},
  fallbacks: [
    { providerId: 'cloud-tts', voiceId: 'baritone-2' },
    { providerId: 'local-tts', voiceId: 'stone' },
  ],
};

const entity = (id: string, kind: 'npc' | 'location') => ({
  id,
  campaignId: CAMPAIGN.id,
  kind,
  name: id,
  data: {},
  visibility: 'public' as const,
  actorId: null,
});

const withFile = (run: (path: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    run(join(directory, DATABASE_FILE));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const open = (path: string) => {
  const connection = openDatabase(path);
  return {
    store: createCampaignStore(connection.database),
    entities: createEntityStore(connection.database),
    close: () => connection.close(),
  };
};

const seed = (path: string) => {
  const { store, entities, close } = open(path);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [MARA], scenes: [SCENE], events: [] });
  entities.saveEntity(entity(WARDEN_ID, 'npc'));
  entities.saveEntity(entity(PIER_ID, 'location'));
  return { store, entities, close };
};

const actionFor = (store: CampaignStore, actionId: string): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
  sceneId: SCENE.id,
  actorId: MARA.id,
  input: `${actionId}.`,
  intent: `Mara sets the ${actionId} voice.`,
});

const eventsOf = (store: CampaignStore) => store.load(CAMPAIGN.id)?.events ?? [];

test('store voice identity, locale, pronunciation and preferred delivery across sessions', () =>
  withFile((path) => {
    const writer = seed(path);
    setVoiceProfile(writer.store, writer.entities, {
      ...actionFor(writer.store, 'narrator'),
      speakerId: NARRATOR_SPEAKER,
      profile: NARRATOR,
    });
    setVoiceProfile(writer.store, writer.entities, {
      ...actionFor(writer.store, 'warden'),
      speakerId: WARDEN_ID,
      profile: WARDEN,
    });
    writer.close();
    const reader = open(path);
    try {
      assert.deepEqual(voiceProfileOf(eventsOf(reader.store), NARRATOR_SPEAKER), NARRATOR);
      assert.deepEqual(voiceProfileOf(eventsOf(reader.store), WARDEN_ID), WARDEN);
      assert.equal(voiceProfileOf(eventsOf(reader.store), PIER_ID), undefined);
    } finally {
      reader.close();
    }
  }));

test('a later profile replaces the earlier one and a replayed action commits once', () =>
  withFile((path) => {
    const { store, entities, close } = seed(path);
    try {
      const first = { ...actionFor(store, 'warden'), speakerId: WARDEN_ID, profile: WARDEN };
      setVoiceProfile(store, entities, first);
      assert.deepEqual(setVoiceProfile(store, entities, first).turn.actionId, first.actionId);
      const slower = { ...WARDEN, pace: 0.8 };
      setVoiceProfile(store, entities, { ...actionFor(store, 'slower'), speakerId: WARDEN_ID, profile: slower });
      assert.equal(eventsOf(store).filter(({ type }) => type === VOICE_PROFILE_SET).length, 2);
      assert.deepEqual(voiceProfileOf(eventsOf(store), WARDEN_ID), slower);
    } finally {
      close();
    }
  }));

test('voice profile remains recognizable while secrets stay private', () =>
  withFile((path) => {
    const { store, entities, close } = seed(path);
    try {
      const leaky = {
        ...WARDEN,
        apiKey: API_KEY,
        credentials: { token: API_KEY },
        hiddenKnowledge: HIDDEN_PLAN,
        fallbacks: WARDEN.fallbacks.map((fallback) => ({ ...fallback, apiKey: API_KEY })),
      };
      setVoiceProfile(store, entities, { ...actionFor(store, 'warden'), speakerId: WARDEN_ID, profile: leaky });
      const stored = JSON.stringify(eventsOf(store));
      assert.equal(stored.includes(API_KEY), false);
      assert.equal(stored.includes(HIDDEN_PLAN), false);
      assert.deepEqual(voiceProfileOf(eventsOf(store), WARDEN_ID), WARDEN);
    } finally {
      close();
    }
  }));

test('reject a malformed profile or a speaker that is neither the narrator nor an npc', () =>
  withFile((path) => {
    const { store, entities, close } = seed(path);
    try {
      const invalid = [
        [WARDEN_ID, { ...WARDEN, language: 'not a locale!' }],
        [WARDEN_ID, { ...WARDEN, id: ' ' }],
        [WARDEN_ID, { ...WARDEN, pace: 0 }],
        [WARDEN_ID, { ...WARDEN, pronunciations: { Aelric: 1 } }],
        [WARDEN_ID, { ...WARDEN, fallbacks: [{ providerId: 'local-tts' }] }],
        [PIER_ID, WARDEN],
        ['npc-missing', WARDEN],
      ] as const;
      for (const [speakerId, profile] of invalid)
        assert.throws(
          () => setVoiceProfile(store, entities, { ...actionFor(store, 'bad'), speakerId, profile }),
          InvalidActionError,
        );
      assert.equal(eventsOf(store).filter(({ type }) => type === VOICE_PROFILE_SET).length, 0);
    } finally {
      close();
    }
  }));

test('voice traits are stored once in the npc entity data and replay commits once', () =>
  withFile((path) => {
    const { store, entities, close } = seed(path);
    try {
      const input = {
        ...actionFor(store, 'traits'),
        speakerId: WARDEN_ID,
        traits: { gender: 'female', age: 'old', manner: 'warm', volume: 11 },
      };
      const committed = setVoiceTraits(store, entities, input);
      assert.equal(setVoiceTraits(store, entities, input).turn.id, committed.turn.id);
      assert.deepEqual(entities.getEntity(CAMPAIGN.id, WARDEN_ID)?.data, {
        voiceTraits: { gender: 'female', age: 'old', manner: 'warm' },
      });
      assert.equal(eventsOf(store).filter(({ type }) => type === VOICE_TRAITS_SET).length, 1);
      assert.throws(
        () =>
          setVoiceTraits(store, entities, {
            ...actionFor(store, 'again'),
            speakerId: WARDEN_ID,
            traits: { gender: 'male' },
          }),
        InvalidActionError,
      );
    } finally {
      close();
    }
  }));

test('voice traits without a usable value or for a non-npc commit nothing', () =>
  withFile((path) => {
    const { store, entities, close } = seed(path);
    try {
      for (const [speakerId, traits] of [
        [WARDEN_ID, { gender: 'robot' }],
        [WARDEN_ID, 'female'],
        [PIER_ID, { gender: 'female' }],
        ['npc-missing', { gender: 'female' }],
      ] as const)
        assert.throws(
          () => setVoiceTraits(store, entities, { ...actionFor(store, 'bad'), speakerId, traits }),
          InvalidActionError,
        );
      assert.equal(eventsOf(store).filter(({ type }) => type === VOICE_TRAITS_SET).length, 0);
    } finally {
      close();
    }
  }));
