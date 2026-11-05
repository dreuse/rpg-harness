import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionForKey,
  componentLabel,
  DEFAULT_PREFERENCES,
  KEY_BINDINGS,
  loadPreferences,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  parsePreferences,
  translate,
} from './accessibility.ts';

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

test('UI10 saved preferences load and fall back to defaults without throwing', () => {
  assert.deepEqual(
    loadPreferences(() => '{"locale":"es"}'),
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
