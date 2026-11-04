import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyProsody,
  MAX_PRONUNCIATIONS,
  MAX_RATE,
  MIN_PITCH_SEMITONES,
  type ProsodyHint,
  type ProviderProsodyCapabilities,
  profileHint,
  toSsml,
} from './prosody.ts';
import type { VoiceProfile } from './voice.ts';

const FULL: ProviderProsodyCapabilities = {
  styles: ['calm', 'whisper', 'angry'],
  rate: true,
  pitch: true,
  emphasis: true,
  pronunciation: true,
};
const NONE: ProviderProsodyCapabilities = {
  styles: [],
  rate: false,
  pitch: false,
  emphasis: false,
  pronunciation: false,
};
const HINT: ProsodyHint = {
  style: 'whisper',
  rate: 1.2,
  pitch: 2,
  emphasis: 'strong',
  pronunciations: [{ text: 'Eldoria', phonetic: 'el-DOR-ee-uh' }],
};

const LONG_INPUT = 64;
const PROFILE: VoiceProfile = {
  id: 'warden',
  language: 'en-GB',
  pace: 1,
  style: 'calm',
  pronunciations: {},
  fallbacks: [],
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

test('A10: use validated ssml-equivalent styles where provider supports them', () => {
  const result = applyProsody(HINT, FULL);
  assert.deepEqual(result.hint, HINT);
  assert.deepEqual(result.dropped, []);
  assert.ok(Object.isFrozen(result.hint));
  assert.deepEqual(toSsml('Welcome to Eldoria.', result), {
    ssml:
      '<speak><prosody rate="120%" pitch="+2st"><emphasis level="strong">Welcome to ' +
      '<sub alias="el-DOR-ee-uh">Eldoria</sub>.</emphasis></prosody></speak>',
    style: 'whisper',
  });
  assert.deepEqual(toSsml('Hush.', applyProsody({ style: 'whisper' }, NONE)), { ssml: '<speak>Hush.</speak>' });
});

test('A10: unsupported prosody hints degrade gracefully, without modifying character emotions', () => {
  const emotion = deepFreeze({ ...HINT, pronunciations: [...(HINT.pronunciations ?? [])] });
  const snapshot = structuredClone(emotion);
  const result = applyProsody(emotion, NONE);
  assert.deepEqual(result.hint, {});
  assert.deepEqual(
    result.dropped.map(({ field, reason }) => `${field}:${reason}`),
    [
      'style:unsupported',
      'rate:unsupported',
      'pitch:unsupported',
      'emphasis:unsupported',
      'pronunciations:unsupported',
    ],
  );
  assert.deepEqual(emotion, snapshot);
  assert.deepEqual(toSsml('Plain speech.', result), { ssml: '<speak>Plain speech.</speak>' });
});

test('no hints yields plain speech', () => {
  assert.deepEqual(applyProsody({}, FULL), { hint: {}, dropped: [] });
  assert.deepEqual(toSsml('a & b', applyProsody({}, FULL)), { ssml: '<speak>a &amp; b</speak>' });
});

test('rejects unknown styles and out-of-range numbers', () => {
  const result = applyProsody(
    { style: 'sobbing', rate: MAX_RATE + 1, pitch: MIN_PITCH_SEMITONES - 1, emphasis: 'loud' as never },
    FULL,
  );
  assert.deepEqual(result.hint, {});
  assert.deepEqual(
    result.dropped.map(({ field, reason }) => `${field}:${reason}`),
    ['style:unsupported', 'rate:invalid', 'pitch:invalid', 'emphasis:invalid'],
  );
  assert.deepEqual(applyProsody({ rate: Number.NaN }, FULL).hint, {});
});

test('rejects markup-like style labels even when the provider lists them', () => {
  const caps = { ...FULL, styles: ['calm"><break/>'] };
  const result = applyProsody({ style: 'calm"><break/>' }, caps);
  assert.deepEqual(result.hint, {});
  assert.equal(result.dropped[0]?.reason, 'invalid');
});

test('drops invalid pronunciation entries and keeps valid ones', () => {
  const valid = { text: 'Aelric', phonetic: 'AYL-rick' };
  const result = applyProsody(
    {
      pronunciations: [
        valid,
        { text: '', phonetic: 'x' },
        { text: 'Bad', phonetic: '<phoneme ph="x"/>' },
        { text: 'Amp&', phonetic: 'amp' },
        { text: 'Long', phonetic: 'a'.repeat(200) },
      ],
    },
    FULL,
  );
  assert.deepEqual(result.hint, { pronunciations: [valid] });
  assert.equal(result.dropped.length, 4);
  assert.ok(result.dropped.every(({ field, reason }) => field === 'pronunciations' && reason === 'invalid'));
});

test('caps the number of pronunciation entries', () => {
  const entries = Array.from({ length: MAX_PRONUNCIATIONS + 1 }, (_, index) => ({
    text: `Name${index}`,
    phonetic: `nayme ${index}`,
  }));
  const result = applyProsody({ pronunciations: [...entries, ...entries] }, FULL);
  assert.equal(result.hint.pronunciations?.length, MAX_PRONUNCIATIONS);
  assert.deepEqual(result.dropped, [{ field: 'pronunciations', reason: 'over-limit' }]);
});

test('drops duplicate pronunciation text and keeps the first entry', () => {
  const result = applyProsody(
    {
      pronunciations: [
        { text: 'Aelric', phonetic: 'AYL-rick' },
        { text: 'Aelric', phonetic: 'EL-rick' },
      ],
    },
    FULL,
  );
  assert.deepEqual(result.hint, { pronunciations: [{ text: 'Aelric', phonetic: 'AYL-rick' }] });
  assert.deepEqual(result.dropped, [{ field: 'pronunciations', reason: 'duplicate' }]);
});

test('drops non-array pronunciations once as invalid', () => {
  const result = applyProsody({ pronunciations: 'Aelric' as never }, FULL);
  assert.deepEqual(result.hint, {});
  assert.deepEqual(result.dropped, [{ field: 'pronunciations', reason: 'invalid' }]);
});

test('mixed hints keep the supported style and drop the rest without touching the input', () => {
  const emotion = deepFreeze({ style: 'angry', pitch: 3, rate: MAX_RATE * 2 });
  const caps = { ...FULL, pitch: false };
  const result = applyProsody(emotion, caps);
  assert.deepEqual(result.hint, { style: 'angry' });
  assert.deepEqual(
    result.dropped.map(({ field, reason }) => `${field}:${reason}`),
    ['rate:invalid', 'pitch:unsupported'],
  );
  assert.deepEqual(emotion, { style: 'angry', pitch: 3, rate: MAX_RATE * 2 });
  assert.deepEqual(toSsml('Out!', result), { ssml: '<speak>Out!</speak>', style: 'angry' });
});

test('toSsml only accepts the validated result', () => {
  const raw: ProsodyHint = { pronunciations: [{ text: '(', phonetic: 'paren' }] };
  // @ts-expect-error
  assert.throws(() => toSsml('(', raw));
  // @ts-expect-error
  assert.throws(() => toSsml('x', profileHint(PROFILE)));
});

test('regex metacharacter pronunciation keys never reach the matcher', () => {
  const result = applyProsody(
    {
      pronunciations: [
        { text: '(', phonetic: 'paren' },
        { text: '(a+)+', phonetic: 'evil' },
      ],
    },
    FULL,
  );
  const text = `${'a'.repeat(LONG_INPUT)}! (`;
  assert.equal(toSsml(text, result).ssml, `<speak>${text}</speak>`);
});

test('toSsml escapes narrative text so it cannot inject markup', () => {
  assert.equal(
    toSsml('<break time="9s"/> "x" & \'y\'', applyProsody({ rate: 1 }, FULL)).ssml,
    '<speak><prosody rate="100%">&lt;break time=&quot;9s&quot;/&gt; &quot;x&quot; &amp; &apos;y&apos;</prosody></speak>',
  );
});

test('toSsml prefers the longest pronunciation match', () => {
  const hint: ProsodyHint = {
    pronunciations: [
      { text: 'Eld', phonetic: 'eld' },
      { text: 'Eldoria', phonetic: 'el-DOR-ee-uh' },
    ],
  };
  assert.equal(
    toSsml('Eldoria Eld', applyProsody(hint, FULL)).ssml,
    '<speak><sub alias="el-DOR-ee-uh">Eldoria</sub> <sub alias="eld">Eld</sub></speak>',
  );
});

test('profileHint maps profile pace, style and pronunciations without sharing references', () => {
  const profile: VoiceProfile = deepFreeze({
    id: 'warden',
    language: 'en-GB',
    pace: 0.9,
    style: 'calm',
    pronunciations: { Aelric: 'AYL-rick' },
    fallbacks: [],
  });
  assert.deepEqual(profileHint(profile), {
    style: 'calm',
    rate: 0.9,
    pronunciations: [{ text: 'Aelric', phonetic: 'AYL-rick' }],
  });
  assert.deepEqual(profileHint({ ...profile, style: '', pronunciations: {} }), { rate: 0.9 });
});
