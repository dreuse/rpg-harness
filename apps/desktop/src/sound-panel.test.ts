import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SOUND_SETTINGS } from '../../../packages/voice/src/sound-settings.ts';
import { DEFAULT_PREFERENCES, parsePreferences, persistedPreferences } from './accessibility.ts';
import { initialState, viewModel } from './renderer.ts';
import { renderView, SOUND_FIELD_TOGGLE, SOUND_FIELD_VOLUME, soundPanel } from './view.ts';

const WIDE_WIDTH = 1600;
const MUSIC_ON = { ...DEFAULT_SOUND_SETTINGS, music: { enabled: true, volume: 0.25 } };

test('every channel is off by default in the saved preferences', () => {
  assert.deepEqual(DEFAULT_PREFERENCES.sound, DEFAULT_SOUND_SETTINGS);
  const parsed = parsePreferences({});
  assert.deepEqual(parsed.ok && parsed.value.sound, DEFAULT_SOUND_SETTINGS);
});

test('saved sound settings round-trip and invalid channels fall back to off', () => {
  const parsed = parsePreferences({ sound: { ...MUSIC_ON, ambience: { enabled: 'yes', volume: 9 } } });
  assert.deepEqual(parsed.ok && parsed.value.sound, MUSIC_ON);
  assert.deepEqual(persistedPreferences({ ...DEFAULT_PREFERENCES, sound: MUSIC_ON }, 'en').sound, MUSIC_ON);
});

test('the panel has a labelled toggle and volume slider per channel', () => {
  const page = soundPanel(MUSIC_ON, 'en');
  assert.match(page, /<legend>Background sound<\/legend>/);
  for (const channel of ['ambience', 'effects', 'music']) {
    assert.match(
      page,
      new RegExp(
        `<label for="sound-${channel}"><input id="sound-${channel}" type="checkbox" ${SOUND_FIELD_TOGGLE}="${channel}"`,
      ),
    );
    assert.match(page, new RegExp(`<input id="sound-${channel}-volume" type="range" min="0" max="1" step="0.05"`));
    assert.match(page, new RegExp(`${SOUND_FIELD_VOLUME}="${channel}"`));
  }
  assert.match(page, /type="checkbox" data-sound-toggle="music" checked>/);
  assert.doesNotMatch(page, /data-sound-toggle="ambience" checked/);
  assert.match(page, /id="sound-music-volume" type="range" min="0" max="1" step="0.05" value="0.25"/);
  assert.match(page, /<label for="sound-music-volume">Music volume<\/label>/);
});

test('the panel is in the settings menu and is localized in Portuguese', () => {
  const model = viewModel({ ...initialState, selected: 'c1' }, WIDE_WIDTH, { ...DEFAULT_PREFERENCES, sound: MUSIC_ON });
  const page = renderView(model, 'pt-BR', undefined, undefined, undefined);
  assert.match(page, /<legend>Som de fundo<\/legend>/);
  assert.match(page, /<label for="sound-music-volume">Volume da música<\/label>/);
  assert.match(page, /Ambiência/);
});
