import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHATTERBOX_CAPABILITIES, CHATTERBOX_PROVIDER_ID } from '../../../packages/voice/src/chatterbox-engine.ts';
import { type KokoroCapabilities, MLX_KOKORO_CAPABILITIES } from '../../../packages/voice/src/kokoro-provider.ts';
import { MLX_KOKORO_PROVIDER_ID } from '../../../packages/voice/src/mlx-audio-engine.ts';
import { DEFAULT_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import type { CommittedUtterance, VoiceProfile } from '../../../packages/voice/src/voice.ts';
import { createTurnSpeech, narratorProfileOf, spokenIn, type TurnSpeechOptions } from './turn-speech.ts';

const PROFILE: VoiceProfile = { id: 'narrator', language: 'en', pace: 1, style: '', pronunciations: {}, fallbacks: [] };
const TURN = 'turn-1';
const ROUTE = 'mlx';
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
    narrator: PROFILE,
    utterancesOf: (segments) => segments.map(({ text, speakerId }) => utteranceOf(text, speakerId)),
  });
  return { turn, calls, generation };
};

test('the first streamed sentence opens the turn and is held before the reply ends', () => {
  const { turn, calls } = harness();
  turn.heard({ text: FIRST });
  assert.deepEqual(calls, [`commit:${TURN}`, `hold:${TURN}:${FIRST}`]);
  turn.heard({ text: SECOND });
  assert.deepEqual(calls.slice(2), [`hold:${TURN}:${SECOND}`]);
});

const NPC_LINE = { speakerId: 'old-tam', text: 'Sit down, stranger.' };
const NPC_PROFILE: VoiceProfile = { ...PROFILE, id: 'old-tam' };

const speakersHeldBy = (mode: Parameters<typeof createTurnSpeech>[0]['mode']) => {
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
    narrator: PROFILE,
    utterancesOf: (segments) =>
      segments.map(({ text, speakerId }) => ({ ...utteranceOf(text, speakerId), profile: NPC_PROFILE })),
  });
  turn.heard({ text: FIRST });
  turn.heard(NPC_LINE);
  return held.map(({ text, speakerId, profile }) => [text, speakerId, profile.id]);
};

test('rpg-42a.98: narrator mode reads NPC lines in the narrator voice, full and cinematic keep NPC voices and give the narrator its own profile', () => {
  assert.deepEqual(speakersHeldBy('narrator'), [
    [FIRST, 'narrator', 'narrator'],
    [NPC_LINE.text, 'narrator', 'narrator'],
  ]);
  for (const mode of ['full', 'cinematic'] as const) {
    assert.deepEqual(speakersHeldBy(mode), [
      [FIRST, 'narrator', 'narrator'],
      [NPC_LINE.text, 'old-tam', 'old-tam'],
    ]);
  }
});

test('rpg-42a.98: an NPC voice is held with the narrator profile as its synthesis fallback', () => {
  const fallbacks: unknown[] = [];
  const turn = createTurnSpeech({
    speech: {
      hold: (_turn, _utterance, fallback) => void fallbacks.push(fallback),
      commit: () => {},
      reject: () => {},
      finish: () => {},
      generation: () => 0,
    },
    turnId: TURN,
    mode: 'full',
    narrator: PROFILE,
    utterancesOf: (segments) =>
      segments.map(({ text, speakerId }) => ({ ...utteranceOf(text, speakerId), profile: NPC_PROFILE })),
  });
  turn.heard({ text: FIRST });
  turn.heard(NPC_LINE);
  assert.deepEqual(fallbacks, [undefined, PROFILE]);
});

test('a streamed reply that matches the recorded narration is kept', () => {
  const { turn, calls } = harness();
  turn.heard({ text: FIRST });
  turn.heard({ text: SECOND });
  turn.settle({ narration: `${FIRST}\n\n${SECOND}`, segments: [{ text: `${FIRST} ${SECOND}` }] });
  assert.ok(!calls.some((call) => call.startsWith('reject')));
  assert.equal(calls.at(-1), `finish:${TURN}`);
});

test('rpg-42a.98: a streamed reply replaced by a different narration drops the stale audio and speaks the final one', () => {
  const { turn, calls } = harness();
  const replacement = 'The game master is unavailable.';
  turn.heard({ text: FIRST });
  turn.settle({ narration: replacement, segments: [{ text: replacement }] });
  assert.deepEqual(calls.slice(-5), [
    `reject:${TURN}`,
    `finish:${TURN}`,
    `hold:${TURN}:${replacement}`,
    `commit:${TURN}`,
    `finish:${TURN}`,
  ]);
});

test('rpg-42a.98: settle speaks only the final paragraphs that were not streamed yet', () => {
  const { turn, calls } = harness();
  turn.heard({ text: FIRST });
  turn.settle({
    narration: `${FIRST}\n\n${SECOND}`,
    segments: [{ text: FIRST }, { speakerId: 'npc-stranger', text: SECOND }],
  });
  assert.deepEqual(calls, [
    `commit:${TURN}`,
    `hold:${TURN}:${FIRST}`,
    `hold:${TURN}:${SECOND}`,
    `commit:${TURN}`,
    `finish:${TURN}`,
  ]);
});

test('rpg-42a.98: a retried attempt resets the streamed text and queued audio before it streams', () => {
  const { turn, calls } = harness();
  turn.heard({ text: FIRST });
  turn.restart();
  turn.heard({ text: SECOND });
  turn.settle({ narration: SECOND, segments: [{ text: SECOND }] });
  assert.deepEqual(calls, [
    `commit:${TURN}`,
    `hold:${TURN}:${FIRST}`,
    `reject:${TURN}`,
    `finish:${TURN}`,
    `commit:${TURN}`,
    `hold:${TURN}:${SECOND}`,
    `commit:${TURN}`,
    `finish:${TURN}`,
  ]);
});

test('rpg-42a.98: a restart before anything streamed touches nothing', () => {
  const { turn, calls } = harness();
  turn.restart();
  assert.deepEqual(calls, []);
});

test('abandon discards the queued audio of a failed stream', () => {
  const { turn, calls } = harness();
  turn.heard({ text: FIRST });
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
    [narrator, npc],
  );
  assert.equal(spokenIn('off', narrator), false);
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
  const profile = narratorProfileOf('en-GB', ROUTE);
  assert.equal(profile.id, 'narrator');
  assert.equal(profile.language, 'en-GB');
  assert.equal(profile.fallbacks[0]?.providerId, 'kokoro');
  assert.deepEqual(narratorProfileOf('xx-YY', ROUTE).fallbacks, []);
});

test('rpg-asjw.20 the pt-BR narrator falls back to every installed engine that speaks pt-BR', () => {
  const engine = (id: string, capabilities: KokoroCapabilities) => ({ id, capabilities });
  const providers = [
    engine(CHATTERBOX_PROVIDER_ID, CHATTERBOX_CAPABILITIES),
    engine(MLX_KOKORO_PROVIDER_ID, MLX_KOKORO_CAPABILITIES),
  ];
  const { fallbacks } = narratorProfileOf('pt-BR', ROUTE, undefined, providers);
  assert.deepEqual(
    fallbacks.map(({ providerId }) => providerId),
    [MLX_KOKORO_PROVIDER_ID, CHATTERBOX_PROVIDER_ID],
  );
});

test('a stop during the turn drops its remaining streamed and recorded speech', () => {
  const { turn, calls, generation } = harness();
  turn.heard({ text: FIRST });
  generation.current += 1;
  turn.heard({ text: SECOND });
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
    narrator: PROFILE,
    utterancesOf: () => {
      throw new Error('no profile');
    },
  });
  assert.doesNotThrow(() => turn.heard({ text: FIRST }));
  assert.doesNotThrow(() => turn.settle({ narration: FIRST, segments: [{ text: FIRST }] }));
  assert.ok(calls.includes(`reject:${TURN}`));
});

const FAST = 1.5;

test('the narrator profile pace follows the saved speed and defaults to normal', () => {
  assert.equal(narratorProfileOf('en', ROUTE, FAST).pace, FAST);
  assert.equal(narratorProfileOf('en', ROUTE).pace, DEFAULT_PLAYBACK_SPEED);
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
      narrator: narratorProfileOf('en', ROUTE, FAST),
      utterancesOf: (segments) =>
        segments.map(({ text }) => ({ ...utteranceOf(text), profile: narratorProfileOf('en', ROUTE, FAST) })),
    });
    turn.heard({ text: FIRST });
    assert.equal(held[0]?.profile.pace, FAST, mode);
  }
});

test('rpg-cm63.55 a chosen narrator voice hands the plain narrator profile to the fallback of every line', () => {
  const fallbacks: (VoiceProfile | undefined)[] = [];
  const chosen: VoiceProfile = { ...PROFILE, fallbacks: [{ providerId: 'f5-tts', voiceId: 'f5-pt-f1' }] };
  const turn = createTurnSpeech({
    speech: {
      hold: (_turn, _utterance, fallback) => void fallbacks.push(fallback),
      commit: () => {},
      reject: () => {},
      finish: () => {},
      generation: () => 0,
    },
    turnId: TURN,
    mode: 'full',
    narrator: chosen,
    narratorFallback: PROFILE,
    utterancesOf: (segments) => segments.map(({ text, speakerId }) => utteranceOf(text, speakerId)),
  });
  turn.heard({ text: FIRST });
  turn.heard(NPC_LINE);
  assert.deepEqual(fallbacks, [PROFILE, PROFILE]);
});

test('rpg-cm63.55 in full mode only the narrator line takes the chosen narrator profile', () => {
  const held: CommittedUtterance[] = [];
  const chosen: VoiceProfile = { ...PROFILE, fallbacks: [{ providerId: 'f5-tts', voiceId: 'f5-pt-f1' }] };
  const turn = createTurnSpeech({
    speech: {
      hold: (_turn, utterance) => void held.push(utterance),
      commit: () => {},
      reject: () => {},
      finish: () => {},
      generation: () => 0,
    },
    turnId: TURN,
    mode: 'full',
    narrator: chosen,
    narratorFallback: PROFILE,
    utterancesOf: (segments) => segments.map(({ text, speakerId }) => utteranceOf(text, speakerId)),
  });
  turn.heard({ text: FIRST, speakerId: 'narrator' });
  turn.heard(NPC_LINE);
  assert.equal(held[0]?.profile.fallbacks[0]?.providerId, 'f5-tts');
  assert.notEqual(held[1]?.profile.fallbacks[0]?.providerId, 'f5-tts');
});
