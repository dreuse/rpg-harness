import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionForKey,
  componentLabel,
  DEFAULT_PREFERENCES,
  KEY_BINDINGS,
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

test('UI10 keyboard controls map keys to renderer actions and can be disabled', () => {
  assert.equal(actionForKey('Enter', DEFAULT_PREFERENCES), KEY_BINDINGS.Enter);
  assert.equal(actionForKey('F13', DEFAULT_PREFERENCES), undefined);
  assert.equal(actionForKey('Enter', { ...DEFAULT_PREFERENCES, keyboard: false }), undefined);
});

test('UI10 locale strings fall back to default locale and then to the key', () => {
  assert.equal(translate('es', 'status.connecting'), 'Conectando con el motor');
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
