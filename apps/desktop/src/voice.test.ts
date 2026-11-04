import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failure, type Result, type SubmitPlayerAction } from '../../../packages/client-protocol/src/protocol.ts';
import type { MicrophoneState } from '../../../packages/voice/src/microphone.ts';
import type { VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import { renderVoice } from './view.ts';
import { browserMicrophone, createDesktopVoice } from './voice.ts';

const LOCALE = 'en';
const SUPPORTED_LOCALES = ['en-US'];
const SUBTITLE = { eventId: 'e1', speakerId: 'gm', text: 'The door creaks open.' };
const SPOKEN_ACTION = 'I step through the door';
const DENIED: MicrophoneState = { kind: 'typed-input-only', reason: 'permission-denied' };
const CONSENT = { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: ['local'] } as const;
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
});

const deferredMicrophone = () => {
  const starts: ((state: MicrophoneState) => void)[] = [];
  let stops = 0;
  const voice = (initial: VoiceSession = session) =>
    createDesktopVoice({
      session: initial,
      consent: CONSENT,
      supportedLocales: SUPPORTED_LOCALES,
      subtitles: { current: () => undefined },
      openMicrophone: () => ({
        start: () => new Promise<MicrophoneState>((resolve) => starts.push(resolve)),
        stop: () => {
          stops += 1;
        },
      }),
      submit: () => failure('Rejected', 'offline'),
    });
  return { starts, stops: () => stops, voice };
};

test('A18: turning the mic off clears the audio fallback', async () => {
  const mic = deferredMicrophone();
  const voice = mic.voice();
  const on = voice.say('set mic to push-to-talk');
  mic.starts[0]?.(DENIED);
  await on;
  assert.equal(voice.view().fallback, 'permission-denied');
  await voice.say('set mic to off');
  assert.equal(voice.view().fallback, undefined);
});

test('A18: a stale microphone start result is ignored', async () => {
  const mic = deferredMicrophone();
  const voice = mic.voice();
  const on = voice.say('set mic to push-to-talk');
  await voice.say('set mic to off');
  mic.starts[0]?.(DENIED);
  await on;
  assert.equal(mic.stops(), 1);
  assert.equal(voice.view().fallback, undefined);
});

test('A18: desktop opens the mic at startup when saved settings enable it', async () => {
  const mic = deferredMicrophone();
  await mic.voice().start();
  assert.equal(mic.starts.length, 0);
  const enabled = mic.voice({ ...session, preferences: { ...session.preferences, microphone: 'hands-free' } });
  const started = enabled.start();
  mic.starts[0]?.(DENIED);
  await started;
  assert.equal(enabled.view().fallback, 'permission-denied');
});

const CHUNK = [1, 2, 3];

const fakeMedia = (permission: boolean) => {
  const stopped: string[] = [];
  const listeners = new Set<() => void>();
  const stream = (id: string) => ({ getTracks: () => [{ stop: () => stopped.push(id) }] });
  const media = {
    getUserMedia: async ({ audio }: { audio: true | { deviceId: { exact: string } } }) => {
      if (!permission) throw new Error('NotAllowedError');
      return stream(audio === true ? 'probe' : audio.deviceId.exact);
    },
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Built-in' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
      { kind: 'audioinput', deviceId: 'usb', label: 'USB' },
    ],
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  class Recorder {
    readonly handlers = new Map<string, (event: { data: Blob }) => void>();
    addEventListener(type: string, handler: (event: { data: Blob }) => void) {
      this.handlers.set(type, handler);
    }
    start() {}
    stop() {
      this.handlers.get('dataavailable')?.({ data: new Blob([new Uint8Array(CHUNK)]) });
      this.handlers.get('stop')?.({ data: new Blob() });
    }
  }
  return {
    stopped,
    listeners,
    source: browserMicrophone(media as unknown as MediaDevices, Recorder as unknown as typeof MediaRecorder),
  };
};

test('A18: browser microphone source asks permission, lists inputs and streams chunks', async () => {
  assert.equal(await fakeMedia(false).source.requestPermission(), 'denied');
  const { source, stopped, listeners } = fakeMedia(true);
  assert.equal(await source.requestPermission(), 'granted');
  assert.deepEqual(await source.listDevices(), [
    { id: 'default', label: 'Built-in', isDefault: true },
    { id: 'usb', label: 'USB', isDefault: false },
  ]);
  const opened = await source.open('usb');
  opened.close();
  const chunks: number[][] = [];
  for await (const chunk of opened.chunks) chunks.push([...chunk]);
  assert.deepEqual(chunks, [CHUNK]);
  assert.deepEqual(stopped, ['probe', 'usb']);
  const unsubscribe = source.onDeviceChange(async () => {});
  assert.equal(listeners.size, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
});
