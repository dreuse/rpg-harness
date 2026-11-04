import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLanguageSwitch, normalizeTranscript, type ProtectedTerm, resolveLocale } from './transcript.ts';
import type { TranscriptSegment } from './voice.ts';

const ENGLISH = 'en-GB';
const PORTUGUESE = 'pt-BR';
const CONFIDENCE = 0.9;
const SEGMENT_MS = 500;

const TERMS: readonly ProtectedTerm[] = [
  { text: 'Zoë', kind: 'name' },
  { text: 'São Jorge', kind: 'name' },
  { text: 'Hit Points', kind: 'rule-term' },
  { text: 'Hit', kind: 'rule-term' },
];

const segment = (index: number, text: string, locale: string): TranscriptSegment => ({
  id: `seg-${index}`,
  text,
  startMs: index * SEGMENT_MS,
  endMs: (index + 1) * SEGMENT_MS,
  confidence: CONFIDENCE,
  final: true,
  locale,
});

test('supports locale hints and multilingual inputs with faithful named-entity handling', () => {
  assert.equal(resolveLocale('pt-br', undefined), PORTUGUESE);
  assert.equal(resolveLocale(ENGLISH, segment(0, 'olá', PORTUGUESE)), PORTUGUESE);
  const input = [
    segment(0, '  zoe   attacks  ', ENGLISH),
    segment(1, 'Zoë vai para sao  jorge', PORTUGUESE),
    segment(2, 'restore hit points to zoë', ENGLISH),
  ];
  const result = normalizeTranscript(input, TERMS);
  assert.deepEqual(
    result.segments.map((item) => item.text),
    ['Zoë attacks', 'Zoë vai para São Jorge', 'restore Hit Points to Zoë'],
  );
  assert.deepEqual(
    result.segments.map(({ text: _text, ...rest }) => rest),
    input.map(({ text: _text, ...rest }) => rest),
  );
  assert.deepEqual(result.substitutions, [
    { segmentId: 'seg-0', from: 'zoe', to: 'Zoë', kind: 'name' },
    { segmentId: 'seg-1', from: 'sao jorge', to: 'São Jorge', kind: 'name' },
    { segmentId: 'seg-2', from: 'hit points', to: 'Hit Points', kind: 'rule-term' },
    { segmentId: 'seg-2', from: 'zoë', to: 'Zoë', kind: 'name' },
  ]);
});

test('user language switch does not silently change rule terminology or names', () => {
  assert.equal(detectLanguageSwitch(ENGLISH, PORTUGUESE), true);
  assert.equal(detectLanguageSwitch(ENGLISH, 'en-US'), false);
  assert.equal(detectLanguageSwitch(undefined, PORTUGUESE), false);
  const input = [segment(0, 'Zoë loses Hit Points', ENGLISH), segment(1, 'Zoë perde Hit Points', PORTUGUESE)];
  const result = normalizeTranscript(input, TERMS);
  assert.deepEqual(result.segments, input);
  assert.deepEqual(result.substitutions, []);
});

test('invalid or empty locale hints fall back to undefined', () => {
  for (const hint of ['', '   ', 'not a locale!', 'en_US_', undefined])
    assert.equal(resolveLocale(hint, undefined), undefined);
});

test('text without a protected term match is left untouched', () => {
  const input = [segment(0, 'Hitter Zoey pontos de vida', PORTUGUESE)];
  const result = normalizeTranscript(input, TERMS);
  assert.deepEqual(result.segments, input);
  assert.deepEqual(result.substitutions, []);
});
