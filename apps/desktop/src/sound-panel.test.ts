import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SOUND_SETTINGS } from '../../../packages/voice/src/sound-settings.ts';
import { DEFAULT_PREFERENCES, parsePreferences, persistedPreferences } from './accessibility.ts';
import { initialState, viewModel } from './renderer.ts';
import type { SoundHostStatus } from './sound-host.ts';
import type { SoundBridge } from './sound-player.ts';
import { createSoundSetup, type SoundSetupView } from './sound-setup.ts';
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

const OFFER = { source: 'https://cdn.example.org/sounds', bytes: 40_894_464, sizeMiB: 39 };
const MISSING: SoundHostStatus = { installed: false, bytes: 0, offer: OFFER };
const PRESENT: SoundHostStatus = { installed: true, bytes: OFFER.bytes, offer: OFFER };

const fakeBridge = (first: SoundHostStatus = MISSING) => {
  let status = first;
  const downloads: unknown[] = [];
  let progress: (bytes: number) => void = () => {};
  let fail = false;
  const bridge: SoundBridge = {
    status: async () => status,
    download: async (consent) => {
      downloads.push(consent);
      progress(OFFER.bytes / 2);
      if (fail) throw new Error('offline');
      status = PRESENT;
    },
    file: async () => undefined,
    onProgress: (listener) => {
      progress = listener;
    },
    onSpeaking: () => {},
  };
  return {
    bridge,
    downloads,
    failNext: () => {
      fail = true;
    },
  };
};

const setupOf = async (fake = fakeBridge()) => {
  const seen: SoundSetupView[] = [];
  let installed = 0;
  const setup = createSoundSetup({
    bridge: fake.bridge,
    changed: () => seen.push(setup.view()),
    installed: () => installed++,
  });
  await setup.refresh();
  return { setup, seen, installed: () => installed, ...fake };
};

test('the panel offers the download only while the pack is missing and states the size on consent', async () => {
  const { setup } = await setupOf();
  const offer = soundPanel(DEFAULT_SOUND_SETTINGS, 'en', setup.view());
  assert.match(offer, /data-sound-setup="download">Download sound pack<\/button>/);
  setup.ask();
  const consent = soundPanel(DEFAULT_SOUND_SETTINGS, 'en', setup.view());
  assert.match(consent, /39 MB/);
  assert.match(consent, /cdn\.example\.org/);
  assert.match(consent, /data-sound-setup="accept"/);
  assert.match(consent, /data-sound-setup="decline"/);
  const { setup: done } = await setupOf(fakeBridge(PRESENT));
  assert.doesNotMatch(soundPanel(DEFAULT_SOUND_SETTINGS, 'en', done.view()), /data-sound-setup="download"/);
  assert.match(soundPanel(DEFAULT_SOUND_SETTINGS, 'en', done.view()), /Sound pack installed/);
});

test('nothing downloads without explicit consent, and declining returns to the offer', async () => {
  const { setup, downloads } = await setupOf();
  await setup.accept();
  assert.deepEqual(downloads, []);
  setup.ask();
  setup.decline();
  await setup.accept();
  assert.deepEqual(downloads, []);
  assert.equal(setup.view().step, 'idle');
});

test('accepting downloads with the offered consent, shows progress, then refreshes the install status', async () => {
  const { setup, downloads, seen, installed } = await setupOf();
  setup.ask();
  await setup.accept();
  assert.deepEqual(downloads, [{ accepted: true, ...OFFER }]);
  assert.equal(setup.view().installed, true);
  assert.equal(setup.view().step, 'idle');
  assert.equal(installed(), 1);
  const page = soundPanel(
    DEFAULT_SOUND_SETTINGS,
    'en',
    seen.find(({ progress }) => progress?.bytes === OFFER.bytes / 2),
  );
  assert.match(page, /<progress value="20447232" max="40894464"/);
  assert.match(page, /20 of 39 MB/);
});

test('a failed download shows an alert, allows a retry and does not report an install', async () => {
  const fake = fakeBridge();
  fake.failNext();
  const { setup, installed } = await setupOf(fake);
  setup.ask();
  await setup.accept();
  assert.equal(setup.view().step, 'failed');
  assert.equal(installed(), 0);
  const page = soundPanel(DEFAULT_SOUND_SETTINGS, 'en', setup.view());
  assert.match(page, /role="alert"/);
  assert.match(page, /data-sound-setup="download"/);
});

test('the download controls are localized in Portuguese', async () => {
  const { setup } = await setupOf();
  setup.ask();
  const page = soundPanel(DEFAULT_SOUND_SETTINGS, 'pt-BR', setup.view());
  assert.match(page, /Baixar e continuar/);
  assert.match(page, /39 MB/);
  assert.match(soundPanel(DEFAULT_SOUND_SETTINGS, 'pt-BR', { ...setup.view(), step: 'idle' }), /Baixar pacote de som/);
});

test('the setup control is in the settings menu', async () => {
  const { setup } = await setupOf();
  const model = {
    ...viewModel({ ...initialState, selected: 'c1' }, WIDE_WIDTH, DEFAULT_PREFERENCES),
    soundSetup: setup.view(),
  };
  assert.match(renderView(model, 'en', undefined, undefined, undefined), /data-sound-setup="download"/);
});
