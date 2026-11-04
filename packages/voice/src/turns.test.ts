import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTurnDetector,
  DEFAULT_TURN_OPTIONS,
  type TurnDetector,
  type TurnOptions,
  type VoiceTurn,
} from './turns.ts';
import { DEFAULT_VOICE_SETTINGS, type MicrophoneMode, type VoiceSettings } from './voice.ts';

const SPEECH = new Uint8Array([9]);
const SILENCE = new Uint8Array([0]);
const OPTIONS: TurnOptions = { speechChunksToStart: 2, silenceChunksToEnd: 2, minTurnChunks: 1 };

const settingsFor = (microphone: MicrophoneMode): VoiceSettings => ({
  microphone,
  spokenOutput: 'off',
  consent: { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: ['local-stt'] },
});

interface Harness {
  readonly detector: TurnDetector;
  readonly turns: VoiceTurn[];
}

const harness = (settings: VoiceSettings, options: TurnOptions = OPTIONS): Harness => {
  const turns: VoiceTurn[] = [];
  let ids = 0;
  let clock = 0;
  const detector = createTurnDetector({
    settings,
    options,
    isSpeech: (chunk) => chunk[0] !== 0,
    nextId: () => `turn-${++ids}`,
    now: () => ++clock,
    onTurn: (turn) => turns.push(turn),
  });
  return { detector, turns };
};

const feed = (detector: TurnDetector, chunks: readonly Uint8Array[]): void => {
  for (const chunk of chunks) detector.push(chunk);
};

test('provide push-to-talk and optional hands-free VAD with clear boundaries', () => {
  assert.equal(DEFAULT_VOICE_SETTINGS.microphone, 'off');
  const off = harness(DEFAULT_VOICE_SETTINGS);
  assert.equal(off.detector.start('push-to-talk'), undefined);
  assert.equal(off.detector.start('hands-free'), undefined);
  off.detector.press();
  feed(off.detector, [SPEECH, SPEECH]);
  off.detector.release();
  assert.equal(off.turns.length, 0);

  const ptt = harness(settingsFor('push-to-talk'));
  assert.equal(ptt.detector.start('hands-free'), undefined);
  assert.equal(ptt.detector.start('push-to-talk'), 'push-to-talk');
  assert.equal(ptt.detector.mode(), 'push-to-talk');
  assert.equal(ptt.detector.state(), 'idle');
  ptt.detector.push(SPEECH);
  ptt.detector.press();
  assert.equal(ptt.detector.state(), 'listening');
  feed(ptt.detector, [SPEECH, SILENCE, SPEECH]);
  ptt.detector.release();
  assert.equal(ptt.detector.state(), 'idle');
  assert.deepEqual(ptt.turns, [
    { id: 'turn-1', mode: 'push-to-talk', chunks: [SPEECH, SILENCE, SPEECH], startedAt: 1, endedAt: 2 },
  ]);
  assert.ok(Object.isFrozen(ptt.turns[0]));

  const vad = harness(settingsFor('hands-free'));
  assert.equal(vad.detector.start('hands-free'), 'hands-free');
  feed(vad.detector, [SPEECH, SPEECH]);
  assert.equal(vad.detector.state(), 'listening');
  feed(vad.detector, [SPEECH, SILENCE, SILENCE]);
  assert.equal(vad.detector.state(), 'idle');
  assert.equal(vad.turns.length, 1);
  assert.equal(vad.turns[0]?.mode, 'hands-free');
  assert.deepEqual(vad.turns[0]?.chunks, [SPEECH, SPEECH, SPEECH, SILENCE, SILENCE]);

  assert.equal(vad.detector.start('push-to-talk'), 'push-to-talk');
  feed(vad.detector, [SPEECH, SPEECH, SPEECH]);
  assert.equal(vad.detector.state(), 'idle');
  vad.detector.press();
  vad.detector.push(SPEECH);
  vad.detector.stop();
  assert.equal(vad.detector.state(), 'idle');
  assert.equal(vad.detector.mode(), undefined);
  vad.detector.release();
  assert.equal(vad.turns.length, 1);

  assert.throws(
    () => harness(settingsFor('hands-free'), { ...DEFAULT_TURN_OPTIONS, speechChunksToStart: 0 }),
    RangeError,
  );
});

test('silence, noise and multiple rapid turns cannot duplicate game actions', () => {
  const vad = harness(settingsFor('hands-free'));
  vad.detector.start('hands-free');
  feed(vad.detector, [SILENCE, SILENCE, SILENCE, SILENCE]);
  feed(vad.detector, [SPEECH, SILENCE, SPEECH, SILENCE, SILENCE]);
  assert.equal(vad.turns.length, 0);

  feed(vad.detector, [SPEECH, SPEECH, SILENCE, SILENCE, SPEECH, SPEECH, SILENCE, SILENCE]);
  assert.deepEqual(
    vad.turns.map((turn) => turn.id),
    ['turn-1', 'turn-2'],
  );
  vad.detector.press();
  vad.detector.release();
  feed(vad.detector, [SPEECH, SPEECH, SPEECH]);
  vad.detector.release();
  vad.detector.stop();
  vad.detector.stop();
  assert.equal(vad.turns.length, 2);

  const ptt = harness(settingsFor('push-to-talk'));
  ptt.detector.start('push-to-talk');
  ptt.detector.release();
  ptt.detector.press();
  ptt.detector.release();
  assert.equal(ptt.turns.length, 0);

  ptt.detector.press();
  ptt.detector.push(SPEECH);
  ptt.detector.press();
  ptt.detector.push(SPEECH);
  ptt.detector.release();
  ptt.detector.release();
  ptt.detector.press();
  ptt.detector.push(SPEECH);
  ptt.detector.release();
  ptt.detector.stop();
  assert.deepEqual(
    ptt.turns.map((turn) => [turn.id, turn.chunks.length]),
    [
      ['turn-1', 2],
      ['turn-2', 1],
    ],
  );
  assert.equal(new Set(ptt.turns.map((turn) => turn.id)).size, ptt.turns.length);
});
