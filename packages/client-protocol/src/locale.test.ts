import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranslator, LANGUAGE_ENV, localeOf, matchLocale, missingKeys, systemLocale } from './locale.ts';

const SUPPORTED = ['en', 'es', 'pt-BR'];
const CATALOG = {
  en: { hello: 'Hello {name}', 'turns.one': '{count} turn', 'turns.other': '{count} turns', only: 'English only' },
  'pt-BR': { hello: 'Olá, {name}', 'turns.one': '{count} turno', 'turns.other': '{count} turnos' },
};

test('rpg-42a.39 missingKeys names every key a locale lacks', () => {
  assert.deepEqual(missingKeys(CATALOG), ['pt-BR only']);
  assert.deepEqual(missingKeys({ en: { a: 'A' }, es: { a: 'B' } }), []);
});

test('rpg-42a.39 translator picks plurals, formats numbers and falls back to English then the key', () => {
  const translate = createTranslator(CATALOG);
  assert.equal(translate('pt-BR', 'hello', { name: 'Ana' }), 'Olá, Ana');
  assert.equal(translate('pt-BR', 'turns', { count: 1 }), '1 turno');
  assert.equal(translate('pt-BR', 'turns', { count: 1500 }), '1.500 turnos');
  assert.equal(translate('en', 'turns', { count: 1500 }), '1,500 turns');
  assert.equal(translate('pt-BR', 'only'), 'English only');
  assert.equal(translate('pt-BR', 'missing'), 'missing');
  assert.equal(translate('en', 'hello'), 'Hello {name}');
});

test('rpg-42a.39 system locale reads RPG_LANG, then POSIX variables, then Intl', () => {
  assert.equal(systemLocale({ [LANGUAGE_ENV]: 'pt-BR', LANG: 'en_US.UTF-8' }), 'pt-BR');
  assert.equal(systemLocale({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' }), 'pt-BR');
  assert.equal(systemLocale({ LANG: 'es_ES.UTF-8@euro' }), 'es-ES');
  assert.equal(systemLocale({ LANG: 'C' }), Intl.DateTimeFormat().resolvedOptions().locale);
  assert.equal(systemLocale({}), Intl.DateTimeFormat().resolvedOptions().locale);
});

test('rpg-42a.39 a requested locale matches exactly, then by language, then falls back to English', () => {
  assert.equal(matchLocale('pt-br', SUPPORTED), 'pt-BR');
  assert.equal(matchLocale('pt-PT', SUPPORTED), 'pt-BR');
  assert.equal(matchLocale('en-US', SUPPORTED), 'en');
  assert.equal(matchLocale('fr-FR', SUPPORTED), 'en');
  assert.equal(matchLocale('not a locale!', SUPPORTED), 'en');
  assert.equal(localeOf({ LANG: 'pt_BR.UTF-8' }, SUPPORTED), 'pt-BR');
});

test('rpg-42a.39 matchLocale accepts POSIX tags and an explicit fallback', () => {
  assert.equal(matchLocale('pt_BR', SUPPORTED), 'pt-BR');
  assert.equal(matchLocale('pt_BR.UTF-8', SUPPORTED), 'pt-BR');
  assert.equal(matchLocale('not a locale!', SUPPORTED, 'es'), 'es');
  assert.equal(matchLocale('fr-FR', SUPPORTED, 'es'), 'es');
});

test('rpg-42a.39 the translator never throws on a malformed locale and reads it as English', () => {
  const translate = createTranslator(CATALOG);
  assert.equal(translate('pt_BR', 'turns', { count: 1500 }), '1,500 turns');
  assert.equal(translate('not a locale!', 'hello', { name: 'Ana' }), 'Hello Ana');
});
