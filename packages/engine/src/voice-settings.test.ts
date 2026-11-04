import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CampaignStore, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import type { SavedVoiceSettings } from '../../domain/src/voice.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEventStore } from '../../persistence/src/event-store.ts';
import { createEngine } from './engine.ts';
import { InvalidActionError } from './turn.ts';
import { VOICE_SETTINGS_SAVED, voiceSettingsOf } from './voice-settings.ts';

const TEMP_PREFIX = 'rpg-voice-settings-';
const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
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
const CONSENTED: SavedVoiceSettings = {
  microphone: 'push-to-talk',
  spokenOutput: 'narrator',
  locale: 'pt-BR',
  speed: 1.5,
  consentGrantedAt: '2026-11-04T00:00:00Z',
};
const TEXT_ONLY: SavedVoiceSettings = { microphone: 'off', spokenOutput: 'full', locale: 'en-US', speed: 1 };

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
  const store = createCampaignStore(connection.database);
  const events = () => createEventStore(connection.database).list(CAMPAIGN.id, MAIN_BRANCH);
  return { store, events, engine: createEngine(store), close: () => connection.close() };
};

const seed = (path: string) => {
  const opened = open(path);
  opened.store.createCampaign(CAMPAIGN, CREATED_EVENT);
  opened.store.commitTurn({ expectedRevision: 0, turn: SETUP_TURN, characters: [MARA], scenes: [SCENE], events: [] });
  return opened;
};

const actionFor = (store: CampaignStore, actionId: string) => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
});

test('A21: voice settings saved through the engine survive a reopened store', () =>
  withFile((path) => {
    const writer = seed(path);
    assert.equal(voiceSettingsOf(writer.events()), undefined);
    writer.engine.saveVoiceSettings({ ...actionFor(writer.store, 'first'), settings: TEXT_ONLY });
    writer.engine.saveVoiceSettings({ ...actionFor(writer.store, 'second'), settings: CONSENTED });
    writer.close();
    const reader = open(path);
    try {
      assert.deepEqual(voiceSettingsOf(reader.events()), CONSENTED);
      assert.equal(reader.events().filter(({ type }) => type === VOICE_SETTINGS_SAVED).length, 2);
      assert.equal(reader.store.load(CAMPAIGN.id)?.turns.length, 1);
    } finally {
      reader.close();
    }
  }));

test('A21: the engine refuses a microphone without consent and malformed settings', () =>
  withFile((path) => {
    const { store, events, engine, close } = seed(path);
    try {
      const invalid = [
        { ...TEXT_ONLY, microphone: 'hands-free' },
        { ...TEXT_ONLY, microphone: 'loud' },
        { ...TEXT_ONLY, spokenOutput: 'shout' },
        { ...TEXT_ONLY, locale: 'not a locale!' },
        { ...TEXT_ONLY, speed: 9 },
        { ...CONSENTED, consentGrantedAt: ' ' },
      ];
      for (const settings of invalid)
        assert.throws(() => engine.saveVoiceSettings({ ...actionFor(store, 'bad'), settings }), InvalidActionError);
      assert.equal(voiceSettingsOf(events()), undefined);
    } finally {
      close();
    }
  }));

test('A21: stored settings keep only the known fields', () =>
  withFile((path) => {
    const { store, events, engine, close } = seed(path);
    try {
      engine.saveVoiceSettings({ ...actionFor(store, 'leaky'), settings: { ...TEXT_ONLY, apiKey: 'sk-live' } });
      assert.equal(JSON.stringify(events()).includes('sk-live'), false);
      assert.deepEqual(voiceSettingsOf(events()), TEXT_ONLY);
    } finally {
      close();
    }
  }));
