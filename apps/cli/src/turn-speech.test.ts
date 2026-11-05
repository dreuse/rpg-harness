import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import type { CommittedUtterance, VoiceProfile } from '../../../packages/voice/src/voice.ts';
import { createTurnSpeech, narratorProfileOf, spokenIn, type TurnSpeechOptions } from './turn-speech.ts';

const PROFILE: VoiceProfile = { id: 'narrator', language: 'en', pace: 1, style: '', pronunciations: {}, fallbacks: [] };
const TURN = 'turn-1';
const FIRST = 'The door creaks open slowly.';
const SECOND = 'Dust falls from the beams.';

const utteranceOf = (text: string, speakerId = 'narrator'): CommittedUtterance => ({
  text,
  speakerId,
  eventId: 'event-1',
  profile: PROFILE,
});

const harness = (mode: Parameters<typeof createTurnSpeech>[0]['mode'] = 'full') => {
  const calls: string[] = [];
  const generation = { current: 0 };
  const speech = {
    hold: (turn, utterance) => void calls.push(`hold:${turn}:${utterance.text}`),
    commit: (turn) => void calls.push(`commit:${turn}`),
    reject: (turn) => void calls.push(`reject:${turn}`),
    finish: (turn) => void calls.push(`finish:${turn}`),
    generation: () => generation.current,
  } as TurnSpeechOptions['speech'];
  const turn = createTurnSpeech({
    speech,
    turnId: TURN,
    mode,
    utterancesOf: (segments) => segments.map(({ text, speakerId }) => utteranceOf(text, speakerId)),
  });
  return { turn, calls, generation };
};

test('the first streamed sentence opens the turn and is held before the reply ends', () => {
  const { turn, calls } = harness();
  turn.heard(FIRST);
  assert.deepEqual(calls, [`commit:${TURN}`, `hold:${TURN}:${FIRST}`]);
  turn.heard(SECOND);
  assert.deepEqual(calls.slice(2), [`hold:${TURN}:${SECOND}`]);
});

test('a streamed reply that matches the recorded narration is kept', () => {
  const { turn, calls } = harness();
  turn.heard(FIRST);
  turn.heard(SECOND);
  turn.settle({ narration: `${FIRST}\n\n${SECOND}`, segments: [{ text: `${FIRST} ${SECOND}` }] });
  assert.ok(!calls.some((call) => call.startsWith('reject')));
  assert.equal(calls.at(-1), `finish:${TURN}`);
});

test('a streamed reply replaced by a different narration discards the queued audio', () => {
  const { turn, calls } = harness();
  turn.heard(FIRST);
  turn.settle({
    narration: 'The game master is unavailable.',
    segments: [{ text: 'The game master is unavailable.' }],
  });
  assert.deepEqual(calls.slice(-2), [`reject:${TURN}`, `finish:${TURN}`]);
});

test('abandon discards the queued audio of a failed stream', () => {
  const { turn, calls } = harness();
  turn.heard(FIRST);
  turn.abandon();
  assert.deepEqual(calls.slice(-2), [`reject:${TURN}`, `finish:${TURN}`]);
});

test('a reply that did not stream is held per segment then committed with its speaker tags', () => {
  const { turn, calls } = harness();
  turn.settle({
    narration: `${FIRST} Sit.`,
    segments: [{ text: FIRST }, { speakerId: 'npc-stranger', text: 'Sit.' }],
  });
  assert.deepEqual(calls, [`hold:${TURN}:${FIRST}`, `hold:${TURN}:Sit.`, `commit:${TURN}`, `finish:${TURN}`]);
});

test('spoken output modes pick which speakers are read', () => {
  const narrator = utteranceOf(FIRST);
  const npc = utteranceOf('Sit.', 'npc-stranger');
  assert.deepEqual(
    [narrator, npc].filter((item) => spokenIn('narrator', item)),
    [narrator],
  );
  assert.deepEqual(
    [narrator, npc].filter((item) => spokenIn('dialogue', item)),
    [npc],
  );
  assert.deepEqual(
    [narrator, npc].filter((item) => spokenIn('full', item)),
    [narrator, npc],
  );
  assert.deepEqual(
    [narrator, npc].filter((item) => spokenIn('cinematic', item)),
    [narrator, npc],
  );
});

test('dialogue mode never streams and only holds dialogue lines', () => {
  const { turn, calls } = harness('dialogue');
  assert.equal(turn.streams, false);
  turn.settle({
    narration: `${FIRST} Sit.`,
    segments: [{ text: FIRST }, { speakerId: 'npc-stranger', text: 'Sit.' }],
  });
  assert.deepEqual(calls, [`hold:${TURN}:Sit.`, `commit:${TURN}`, `finish:${TURN}`]);
});

test('the narrator profile uses the saved locale and its default voice', () => {
  const profile = narratorProfileOf('en-GB');
  assert.equal(profile.id, 'narrator');
  assert.equal(profile.language, 'en-GB');
  assert.equal(profile.fallbacks[0]?.providerId, 'kokoro');
  assert.deepEqual(narratorProfileOf('xx-YY').fallbacks, []);
});

test('a stop during the turn drops its remaining streamed and recorded speech', () => {
  const { turn, calls, generation } = harness();
  turn.heard(FIRST);
  generation.current += 1;
  turn.heard(SECOND);
  turn.settle({ narration: `${FIRST} ${SECOND}`, segments: [{ text: `${FIRST} ${SECOND}` }] });
  assert.deepEqual(calls, [`commit:${TURN}`, `hold:${TURN}:${FIRST}`, `finish:${TURN}`]);
});

test('a failing utterance builder never breaks the turn and discards its audio', () => {
  const calls: string[] = [];
  const speech = {
    hold: () => {},
    commit: (turn) => void calls.push(`commit:${turn}`),
    reject: (turn) => void calls.push(`reject:${turn}`),
    finish: (turn) => void calls.push(`finish:${turn}`),
    generation: () => 0,
  } as TurnSpeechOptions['speech'];
  const turn = createTurnSpeech({
    speech,
    turnId: TURN,
    mode: 'full',
    utterancesOf: () => {
      throw new Error('no profile');
    },
  });
  assert.doesNotThrow(() => turn.heard(FIRST));
  assert.doesNotThrow(() => turn.settle({ narration: FIRST, segments: [{ text: FIRST }] }));
  assert.ok(calls.includes(`reject:${TURN}`));
});

const FAST = 1.5;

test('the narrator profile pace follows the saved speed and defaults to normal', () => {
  assert.equal(narratorProfileOf('en', FAST).pace, FAST);
  assert.equal(narratorProfileOf('en').pace, DEFAULT_PLAYBACK_SPEED);
});

test('an utterance held for speech carries the saved speed as its profile pace in every mode', () => {
  for (const mode of ['narrator', 'full', 'cinematic'] as const) {
    const held: CommittedUtterance[] = [];
    const turn = createTurnSpeech({
      speech: {
        hold: (_turn, utterance) => void held.push(utterance),
        commit: () => {},
        reject: () => {},
        finish: () => {},
        generation: () => 0,
      },
      turnId: TURN,
      mode,
      utterancesOf: (segments) =>
        segments.map(({ text }) => ({ ...utteranceOf(text), profile: narratorProfileOf('en', FAST) })),
    });
    turn.heard(FIRST);
    assert.equal(held[0]?.profile.pace, FAST, mode);
  }
});
