import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingKeys } from '../../../packages/client-protocol/src/locale.ts';
import {
  actionForKey,
  CATALOG,
  componentLabel,
  DEFAULT_PREFERENCES,
  KEY_BINDINGS,
  loadPreferences,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  parsePreferences,
  persistedPreferences,
  SUPPORTED_LOCALES,
  translate,
} from './accessibility.ts';

test('rpg-42a.39 every desktop locale has every catalog key', () => {
  assert.ok(SUPPORTED_LOCALES.includes('pt-BR'));
  assert.deepEqual(missingKeys(CATALOG), []);
});

test('rpg-42a.39 pt-BR reads naturally and formats numbers the Brazilian way', () => {
  assert.equal(translate('pt-BR', 'start.first'), 'Comece sua primeira aventura');
  assert.equal(translate('pt-BR', 'home.archived', { count: 2 }), 'Aventuras arquivadas (2)');
  assert.equal(translate('pt-BR', 'voice.speed', { speed: 1.5 }), 'velocidade 1,5×');
  assert.equal(translate('pt-BR', 'sheet.max', { max: 20 }), 'Digite 20 ou menos.');
});

test('rpg-42a.39 the saved locale wins over the system locale, which replaces the default', () => {
  assert.equal(loadPreferences(() => '{}', 'pt-BR').locale, 'pt-BR');
  assert.equal(loadPreferences(() => 'not json', 'pt-BR').locale, 'pt-BR');
  assert.equal(loadPreferences(() => '{"language":"es"}', 'pt-BR').locale, 'es');
});

test('rpg-42a.39 a locale saved before the language control does not override the system locale', () => {
  assert.equal(loadPreferences(() => '{"locale":"en"}', 'pt-BR').locale, 'pt-BR');
});

test('rpg-42a.39 only a language that differs from the system locale is saved', () => {
  const chosen = { ...DEFAULT_PREFERENCES, locale: 'en' };
  assert.equal(JSON.stringify(persistedPreferences(chosen, 'pt-BR')).includes('"language":"en"'), true);
  assert.equal(Object.hasOwn(persistedPreferences(chosen, 'pt-BR'), 'locale'), false);
  assert.equal(Object.hasOwn(persistedPreferences(chosen, 'en'), 'language'), false);
  const saved = JSON.stringify(persistedPreferences(chosen, 'pt-BR'));
  assert.equal(loadPreferences(() => saved, 'pt-BR').locale, 'en');
});

test('rpg-42a.39 preferences normalize the locale and drop an unknown one', () => {
  const posix = parsePreferences({ locale: 'pt_BR' });
  assert.equal(posix.ok && posix.value.locale, 'pt-BR');
  const garbage = parsePreferences({ locale: 'not a locale!' }, { ...DEFAULT_PREFERENCES, locale: 'es' });
  assert.equal(garbage.ok && garbage.value.locale, 'es');
  assert.equal(loadPreferences(() => '{"language":"pt_BR"}').locale, 'pt-BR');
  assert.equal(loadPreferences(() => '{"language":"not a locale!"}', 'es').locale, 'es');
});

test('UI10 preferences default, clamp font scale and reject invalid input', () => {
  assert.deepEqual(parsePreferences(undefined), { ok: true, value: DEFAULT_PREFERENCES });
  const big = parsePreferences({ fontScale: 99 });
  assert.ok(big.ok && big.value.fontScale === MAX_FONT_SCALE);
  const small = parsePreferences({ fontScale: 0.01, locale: 'es' });
  assert.ok(small.ok && small.value.fontScale === MIN_FONT_SCALE && small.value.locale === 'es');
  assert.equal(parsePreferences({ fontScale: 'x' }).ok, false);
  assert.equal(parsePreferences({ fontScale: Number.NaN }).ok, false);
  assert.equal(parsePreferences({ reducedMotion: 'yes' }).ok, false);
  assert.equal(parsePreferences({ locale: '' }).ok, false);
  assert.equal(parsePreferences('nope').ok, false);
});

test('A18 saved voice settings default off and reject invalid input', () => {
  assert.deepEqual(DEFAULT_PREFERENCES.voice, {
    microphone: 'off',
    spokenOutput: 'off',
    consent: { granted: false },
    locale: 'en',
    speed: 1,
  });
  const consent = { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: ['local'] };
  const enabled = parsePreferences({ voice: { microphone: 'hands-free', consent } });
  assert.deepEqual(enabled.ok && enabled.value.voice, {
    ...DEFAULT_PREFERENCES.voice,
    microphone: 'hands-free',
    consent,
  });
  for (const voice of [
    'on',
    { microphone: 'loud' },
    { spokenOutput: 'shout' },
    { locale: '' },
    { speed: 9 },
    { consent: { granted: 'yes' } },
    { consent: { granted: true, grantedAt: 1, providerIds: [] } },
    { consent: { granted: true, grantedAt: 'now', providerIds: [1] } },
  ]) {
    assert.equal(parsePreferences({ voice }).ok, false, JSON.stringify(voice));
  }
});

test('rpg-cm63.7 saved speech settings default to full volume and reject invalid input', () => {
  assert.deepEqual(DEFAULT_PREFERENCES.speech, { volume: 1, npcVoices: {} });
  const speech = {
    providerId: 'kokoro',
    narratorVoice: 'am_adam',
    volume: 0.5,
    npcVoices: { 'campaign-a': { Guard: 'bf_emma' } },
  };
  const parsed = parsePreferences({ speech });
  assert.deepEqual(parsed.ok && parsed.value.speech, speech);
  const extra = parsePreferences({ speech: { ...speech, apiKey: 'sk-live' } });
  assert.deepEqual(extra.ok && extra.value.speech, speech);
  const legacy = parsePreferences({ speech: { ...speech, npcVoices: { Guard: 'bf_emma' } } });
  assert.deepEqual(legacy.ok && legacy.value.speech, { ...speech, npcVoices: {} });
  for (const invalid of [
    'loud',
    { volume: 2 },
    { volume: 0.5, npcVoices: [] },
    { volume: 0.5, npcVoices: { 'campaign-a': { '': 'af_heart' } } },
    { volume: 0.5, npcVoices: { 'campaign-a': { Guard: 1 } } },
    { volume: 0.5, npcVoices: { 'campaign-a': [] } },
    { volume: 0.5, npcVoices: { '': { Guard: 'af_heart' } } },
    { volume: 0.5, npcVoices: {}, narratorVoice: '' },
  ]) {
    assert.equal(parsePreferences({ speech: invalid }).ok, false, JSON.stringify(invalid));
  }
});

test('UI10 saved preferences load and fall back to defaults without throwing', () => {
  assert.deepEqual(
    loadPreferences(() => '{"language":"es"}'),
    { ...DEFAULT_PREFERENCES, locale: 'es' },
  );
  assert.deepEqual(
    loadPreferences(() => '{broken'),
    DEFAULT_PREFERENCES,
  );
  assert.deepEqual(
    loadPreferences(() => '[]'),
    DEFAULT_PREFERENCES,
  );
  assert.deepEqual(
    loadPreferences(() => {
      throw new Error('missing');
    }),
    DEFAULT_PREFERENCES,
  );
});

test('UI10 keyboard controls map keys to renderer actions and can be disabled', () => {
  assert.equal(actionForKey('Enter', DEFAULT_PREFERENCES), KEY_BINDINGS.Enter);
  assert.equal(actionForKey('F13', DEFAULT_PREFERENCES), undefined);
  assert.equal(actionForKey('Enter', { ...DEFAULT_PREFERENCES, keyboard: false }), undefined);
});

test('UI10 locale strings fall back to default locale and then to the key', () => {
  assert.equal(translate('es', 'status.connecting'), 'Conectando');
  assert.equal(translate('fr', 'status.connecting'), translate('en', 'status.connecting'));
  assert.equal(translate('es', 'no.such.key'), 'no.such.key');
});

test('UI10 dynamic fichas are readable without animation or color semantics', () => {
  assert.equal(componentLabel({ kind: 'progress', id: 'hp', label: 'HP', value: '7/10' }), 'HP: 7 of 10');
  assert.equal(componentLabel({ kind: 'progress', id: 'x', label: 'XP', value: 3 }), 'XP: 3');
  assert.equal(componentLabel({ kind: 'roll', id: 'r', label: 'Attack', value: 'hit (17)' }), 'Attack: hit (17)');
  assert.equal(componentLabel({ kind: 'field', id: 'f', label: 'Name', value: 'Ash' }), 'Name: Ash');
  assert.equal(componentLabel({ kind: 'field', id: 'f', label: 'Alive', value: true }), 'Alive: yes');
  assert.equal(componentLabel({ kind: 'clock', id: 'c', label: 'Doom' }), 'Doom: no value');
  assert.equal(componentLabel({ kind: 'field', id: 'n', label: 'Nil', value: null as never }), 'Nil: no value');
  assert.equal(componentLabel({ kind: 'journal', id: 'j', label: 'Notes', value: 'a' }), 'Notes: a');
  assert.equal(componentLabel({ kind: 'mystery' as never, id: 'm', label: 'Odd', value: 1 }), 'Odd: 1');
});

const HOME_KEYS = [
  'home.search',
  'home.noMatch',
  'home.continueLabel',
  'home.archiveLabel',
  'home.deleteLabel',
  'home.unarchiveLabel',
  'home.cancel',
  'home.undo',
  'home.ask.archive',
  'home.ask.delete',
  'home.archivedNotice',
  'home.archived',
  'home.problem.needs-migration',
  'home.problem.unreadable',
  'home.restoreHint',
] as const;

test('rpg-42a.13 every home label reads in each supported locale and names the adventure', () => {
  for (const key of HOME_KEYS) {
    const english = translate('en', key, { name: 'Harbor', count: 1 });
    assert.notEqual(english, key);
    assert.notEqual(translate('es', key, { name: 'Harbor', count: 1 }), english, key);
  }
  assert.equal(translate('en', 'home.continueLabel', { name: 'Harbor' }), 'Continue Harbor');
  assert.equal(translate('es', 'home.deleteLabel', { name: 'Harbor' }), 'Borrar Harbor');
});

test('UI15: the motion setting is full, reduced or off and defaults to full', () => {
  assert.equal(DEFAULT_PREFERENCES.motion, 'full');
  const off = parsePreferences({ motion: 'off' });
  assert.equal(off.ok && off.value.motion, 'off');
  assert.equal(parsePreferences({ motion: 'wild' }).ok, false);
});
