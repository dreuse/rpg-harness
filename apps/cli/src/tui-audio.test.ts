import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import { createTuiAudio } from './tui-audio.ts';

const SUPPORTED_LOCALES = ['en-US'];
const NO_SCENE = 'No scene to act in yet.';
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

test('A18: tui supports appropriate audio controls when available', () => {
  const audio = createTuiAudio(session, SUPPORTED_LOCALES);
  const { acted, act } = recorder();
  assert.equal(audio.input('set output to narrator', act), 'Voice settings changed: spokenOutput narrator');
  assert.match(audio.status(), /output narrator/);
  assert.equal(audio.input('set speed to 9', act), 'Voice settings not changed: speed_out_of_range');
  assert.equal(audio.input('Turn to the bard.', act), undefined);
  assert.deepEqual(acted, ['Turn to the bard.']);
});

test('A18: tui keeps the action after a settings sentence', () => {
  const audio = createTuiAudio(session, SUPPORTED_LOCALES);
  const { acted, act } = recorder(NO_SCENE);
  assert.equal(audio.input('Set speed to 1.5. I wave.', act), `Voice settings changed: speed 1.5\n${NO_SCENE}`);
  assert.deepEqual(acted, ['I wave.']);
});
