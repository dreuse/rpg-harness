import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GM_FAILURE_CATALOG, GM_FAILURE_KINDS, type GmFailure, gmFailureText } from './gm-failure.ts';
import { missingKeys } from './locale.ts';

const LOCALES = ['en', 'es', 'pt-BR'];
const RESET = '3:30pm (Europe/Lisbon)';

test('rpg-42a.101 the failure catalog covers en, es and pt-BR with the same keys', () => {
  assert.deepEqual(Object.keys(GM_FAILURE_CATALOG), LOCALES);
  assert.deepEqual(missingKeys(GM_FAILURE_CATALOG), []);
});

test('rpg-42a.101 every kind reads as a sentence in every locale and is not a bare key', () => {
  for (const locale of LOCALES)
    for (const kind of GM_FAILURE_KINDS) {
      const text = gmFailureText(locale, { kind, detail: 'x' });
      assert.ok(text.length > 20, `${locale} ${kind}`);
      assert.ok(!text.startsWith('gmFailure.'), `${locale} ${kind}`);
    }
});

test('rpg-42a.101 a usage limit shows the reset time in each language', () => {
  const failure: GmFailure = { kind: 'limit', detail: RESET };
  assert.match(gmFailureText('en', failure), /usage limit.*3:30pm \(Europe\/Lisbon\)/);
  assert.match(gmFailureText('pt-BR', failure), /limite de uso.*3:30pm \(Europe\/Lisbon\)/);
  assert.match(gmFailureText('es', failure), /límite de uso.*3:30pm \(Europe\/Lisbon\)/);
});

test('rpg-42a.101 a usage limit without a reset time omits the reset sentence', () => {
  const text = gmFailureText('en', { kind: 'limit' });
  assert.match(text, /usage limit/);
  assert.doesNotMatch(text, /resets/i);
});

test('rpg-42a.101 sign-in and install problems say what to do', () => {
  assert.match(gmFailureText('en', { kind: 'auth' }), /sign in/i);
  assert.match(gmFailureText('pt-BR', { kind: 'auth' }), /entre|login/i);
  assert.match(gmFailureText('es', { kind: 'auth' }), /inicia sesión/i);
  assert.match(gmFailureText('en', { kind: 'notInstalled' }), /not installed/i);
});

test('rpg-42a.101 the exit code only shows when nothing better is known', () => {
  assert.match(gmFailureText('en', { kind: 'exit', detail: '1' }), /exit code 1/);
  assert.doesNotMatch(gmFailureText('en', { kind: 'limit', detail: RESET }), /exit code/);
});

test('rpg-42a.101 an unknown locale falls back to English', () => {
  assert.match(gmFailureText('fr', { kind: 'auth' }), /sign in/i);
});

test('rpg-42a.117 a malformed Claude Code reply reads in Brazilian Portuguese', () => {
  assert.equal(
    gmFailureText('pt-BR', { kind: 'malformed' }),
    'O GM de IA não está disponível: o Claude Code enviou uma resposta malformada.',
  );
  assert.equal(
    gmFailureText('en', { kind: 'malformed' }),
    'The AI game master is unavailable: Claude Code sent a malformed reply.',
  );
});
