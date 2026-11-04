import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failure, type Result, type SubmitPlayerAction } from '../../../packages/client-protocol/src/protocol.ts';
import type { MicrophoneState } from '../../../packages/voice/src/microphone.ts';
import type { VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import { createTuiAudio } from '../../cli/src/tui-audio.ts';
import { renderVoice } from './view.ts';
import { createDesktopVoice } from './voice.ts';

const LOCALE = 'en';
const SUPPORTED_LOCALES = ['en-US'];
const SUBTITLE = { eventId: 'e1', speakerId: 'gm', text: 'The door creaks open.' };
const SPOKEN_ACTION = 'I step through the door';
const DENIED: MicrophoneState = { kind: 'typed-input-only', reason: 'permission-denied' };
const session: VoiceSession = {
  campaignId: 'c1',
  turn: 0,
  pendingInput: [],
  preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
};

test('A18: desktop supports full voice; tui supports appropriate audio controls when available', async () => {
  const submitted: string[] = [];
  const microphone = { starts: 0, stops: 0 };
  const voice = createDesktopVoice({
    session,
    consent: { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: ['local'] },
    supportedLocales: SUPPORTED_LOCALES,
    subtitles: { current: () => SUBTITLE },
    openMicrophone: (settings) => ({
      start: async () => {
        microphone.starts += 1;
        assert.equal(settings.microphone, 'push-to-talk');
        return DENIED;
      },
      stop: () => {
        microphone.stops += 1;
      },
    }),
    submit: (input): Result<SubmitPlayerAction> => {
      submitted.push(input);
      return failure('Rejected', 'offline');
    },
  });
  assert.deepEqual(voice.view().mode, { kind: 'typed-input-only' });

  const changed = await voice.say('set mic to push-to-talk and output to full');
  assert.equal(changed.kind, 'settings');
  assert.deepEqual(voice.view().mode, { kind: 'voice', microphone: 'push-to-talk', spokenOutput: 'full' });
  assert.equal(microphone.starts, 1);
  assert.equal(voice.view().fallback, 'permission-denied');

  await voice.heard({
    kind: 'transcript',
    turnId: 't1',
    segments: [
      { id: 's1', text: 'I step', startMs: 0, endMs: 1, confidence: 1, final: false, locale: 'en-US' },
      { id: 's2', text: SPOKEN_ACTION, startMs: 0, endMs: 2, confidence: 1, final: true, locale: 'en-US' },
    ],
  });
  assert.deepEqual(submitted, [SPOKEN_ACTION]);
  assert.equal(voice.view().fallback, undefined);

  await voice.heard({ kind: 'typed-input-only', turnId: 't2', reason: 'timeout' });
  await voice.say('set speed to 9');
  const html = renderVoice(voice.view(), LOCALE);
  assert.match(html, /Microphone push-to-talk, spoken output full/);
  assert.match(html, /<p aria-live="polite">The door creaks open\.<\/p>/);
  assert.match(html, /role="alert">Audio unavailable \(timeout\); type instead/);
  assert.match(html, /Voice settings not changed: speed_out_of_range/);

  await voice.say('set mic to off');
  assert.equal(microphone.stops, 1);
  assert.deepEqual(submitted, [SPOKEN_ACTION]);

  const audio = createTuiAudio(session, SUPPORTED_LOCALES);
  const acted: string[] = [];
  const act = (text: string) => {
    acted.push(text);
    return undefined;
  };
  assert.equal(audio.input('set output to narrator', act), 'Voice settings changed: spokenOutput narrator');
  assert.match(audio.status(), /output narrator/);
  assert.equal(audio.input('Turn to the bard.', act), undefined);
  assert.deepEqual(acted, ['Turn to the bard.']);
});
