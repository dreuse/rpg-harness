import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { SavedVoiceSettings } from '../../../packages/client-protocol/src/protocol.ts';
import type { VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import { createEngineGateway, openClientSession } from './engine-gateway.ts';
import { createTuiAudio, defaultTuiAudio } from './tui-audio.ts';

const SUPPORTED_LOCALES = ['en-US'];
const NO_SCENE = 'No scene to act in yet.';
const TEMP_PREFIX = 'rpg-tui-audio-';
const CAMPAIGN = 'Ember';
const NO_CHARACTER = async () => undefined;
const session: VoiceSession = {
  campaignId: 'c1',
  turn: 0,
  pendingInput: [],
  preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
};

const recorder = (notice?: string) => {
  const acted: string[] = [];
  const act = (text: string) => {
    acted.push(text);
    return notice;
  };
  return { acted, act };
};

const saver = () => {
  const saved: SavedVoiceSettings[] = [];
  return { saved, save: (settings: SavedVoiceSettings) => void saved.push(settings) };
};

test('A18: tui supports appropriate audio controls when available', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save);
  const { acted, act } = recorder();
  assert.equal(audio.input('set output to narrator', act), 'Voice settings changed: spokenOutput narrator');
  assert.match(audio.status(), /output narrator/);
  assert.equal(audio.input('set speed to 9', act), 'Voice settings not changed: speed_out_of_range');
  assert.equal(audio.input('Turn to the bard.', act), undefined);
  assert.deepEqual(acted, ['Turn to the bard.']);
  assert.deepEqual(saved, [{ ...session.preferences, spokenOutput: 'narrator' }]);
});

test('A18: tui keeps the action after a settings sentence', () => {
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, saver().save);
  const { acted, act } = recorder(NO_SCENE);
  assert.equal(audio.input('Set speed to 1.5. I wave.', act), `Voice settings changed: speed 1.5\n${NO_SCENE}`);
  assert.deepEqual(acted, ['I wave.']);
});

test('A21: tui asks for microphone consent and declining keeps text play', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save);
  const { acted, act } = recorder();
  assert.match(audio.input('set mic to push-to-talk', act) ?? '', /Allow microphone capture.*yes or no/);
  assert.deepEqual(saved, []);
  assert.match(audio.status(), /mic off/);
  assert.match(audio.input('no', act) ?? '', /Microphone stays off/);
  assert.match(audio.status(), /mic off/);
  assert.deepEqual(saved, [session.preferences]);
  assert.equal(audio.input('I wave.', act), undefined);
  assert.deepEqual(acted, ['I wave.']);
});

test('A21: tui saves the microphone only after consent', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save);
  const { act } = recorder();
  audio.input('set mic to hands-free', act);
  assert.match(audio.input('yes', act) ?? '', /Microphone allowed\.\nVoice settings changed: microphone hands-free/);
  assert.match(audio.status(), /mic hands-free/);
  assert.equal(saved.at(-1)?.microphone, 'hands-free');
  assert.ok(saved.at(-1)?.consentGrantedAt);
  audio.input('set mic to off', act);
  assert.equal(audio.input('set mic to push-to-talk', act), 'Voice settings changed: microphone push-to-talk');
});

test('A21: tui voice settings survive a restart through the engine', async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const { act } = recorder();
  const first = openClientSession(dataDir, CAMPAIGN);
  const audio = defaultTuiAudio(first.session, first.campaignId);
  assert.match(audio.status(), /^Voice: mic off, output off, /);
  audio.input('set speed to 1.5 and output to full', act);
  audio.input('set mic to push-to-talk', act);
  audio.input('yes', act);
  first.close();
  const second = openClientSession(dataDir, CAMPAIGN);
  try {
    const reopened = defaultTuiAudio(second.session, second.campaignId);
    assert.match(reopened.status(), /^Voice: mic push-to-talk, output full, .*, 1\.5x$/);
    assert.equal(reopened.input('set mic to hands-free', act), 'Voice settings changed: microphone hands-free');
  } finally {
    second.close();
  }
});

test('rpg-cm63.5 tui binds pause, resume, skip and stop to the playback control', () => {
  const calls: string[] = [];
  const playback = {
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    skip: () => void calls.push('skip'),
    stop: () => void calls.push('stop'),
  };
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, saver().save, undefined, playback);
  const { acted, act } = recorder();
  for (const name of ['pause', 'resume', 'skip', 'stop'])
    assert.equal(audio.input(`/${name}`, act), `Playback: ${name}`);
  assert.deepEqual(calls, ['pause', 'resume', 'skip', 'stop']);
  assert.deepEqual(acted, []);
  assert.equal(audio.input('/dance', act), undefined);
});
