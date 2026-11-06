import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { PROTOCOL_VERSION, type SavedVoiceSettings } from '../../../packages/client-protocol/src/protocol.ts';
import type { VoiceSession } from '../../../packages/voice/src/voice-settings.ts';
import { createEngineGateway, openClientSession } from './engine-gateway.ts';
import { createTuiAudio, defaultTuiAudio } from './tui-audio.ts';

const SUPPORTED_LOCALES = ['en-US'];
const NO_SCENE = 'No scene to act in yet.';
const PORTUGUESE = 'pt-BR';
const TEMP_PREFIX = 'rpg-tui-audio-';
const CAMPAIGN = 'Ember';
const NO_CHARACTER = async () => undefined;
const session: VoiceSession = {
  campaignId: 'c1',
  turn: 0,
  pendingInput: [],
  preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en-US', speed: 1 },
};

const recorder = (notice?: string) => {
  const acted: string[] = [];
  const act = (text: string) => {
    acted.push(text);
    return notice;
  };
  return { acted, act };
};

const saver = () => {
  const saved: SavedVoiceSettings[] = [];
  return { saved, save: (settings: SavedVoiceSettings) => void saved.push(settings) };
};

test('A18: tui supports appropriate audio controls when available', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save);
  const { acted, act } = recorder();
  assert.equal(audio.input('set output to narrator', act), 'Voice settings changed: spokenOutput narrator');
  assert.match(audio.status(), /output narrator/);
  assert.equal(audio.input('set speed to 9', act), 'Voice settings not changed: speed_out_of_range');
  assert.equal(audio.input('Turn to the bard.', act), undefined);
  assert.deepEqual(acted, ['Turn to the bard.']);
  assert.deepEqual(saved, [{ ...session.preferences, spokenOutput: 'narrator' }]);
});

test('A18: tui keeps the action after a settings sentence', () => {
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, saver().save);
  const { acted, act } = recorder(NO_SCENE);
  assert.equal(audio.input('Set speed to 1.5. I wave.', act), `Voice settings changed: speed 1.5\n${NO_SCENE}`);
  assert.deepEqual(acted, ['I wave.']);
});

test('A21: tui asks for microphone consent and declining keeps text play', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save);
  const { acted, act } = recorder();
  assert.match(audio.input('set mic to push-to-talk', act) ?? '', /Allow microphone capture.*yes or no/);
  assert.deepEqual(saved, []);
  assert.match(audio.status(), /mic off/);
  assert.match(audio.input('no', act) ?? '', /Microphone stays off/);
  assert.match(audio.status(), /mic off/);
  assert.deepEqual(saved, [session.preferences]);
  assert.equal(audio.input('I wave.', act), undefined);
  assert.deepEqual(acted, ['I wave.']);
});

test('A21: tui saves the microphone only after consent', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save);
  const { act } = recorder();
  audio.input('set mic to hands-free', act);
  assert.match(audio.input('yes', act) ?? '', /Microphone allowed\.\nVoice settings changed: microphone hands-free/);
  assert.match(audio.status(), /mic hands-free/);
  assert.equal(saved.at(-1)?.microphone, 'hands-free');
  assert.ok(saved.at(-1)?.consentGrantedAt);
  audio.input('set mic to off', act);
  assert.equal(audio.input('set mic to push-to-talk', act), 'Voice settings changed: microphone push-to-talk');
});

test('A21: tui voice settings survive a restart through the engine', async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const { act } = recorder();
  const first = openClientSession(dataDir, CAMPAIGN);
  const audio = defaultTuiAudio(first.session, first.campaignId);
  assert.match(audio.status(), /^Voice: mic off, output off, /);
  audio.input('set speed to 1.5 and output to full', act);
  audio.input('set mic to push-to-talk', act);
  audio.input('yes', act);
  first.close();
  const second = openClientSession(dataDir, CAMPAIGN);
  try {
    const reopened = defaultTuiAudio(second.session, second.campaignId);
    assert.match(reopened.status(), /^Voice: mic push-to-talk, output full, .*, 1\.5x$/);
    assert.equal(reopened.input('set mic to hands-free', act), 'Voice settings changed: microphone hands-free');
  } finally {
    second.close();
  }
});

test('rpg-cm63.5 tui binds pause, resume, skip and stop to the playback control', () => {
  const calls: string[] = [];
  const playback = {
    pause: () => void calls.push('pause'),
    resume: () => void calls.push('resume'),
    skip: () => void calls.push('skip'),
    stop: () => void calls.push('stop'),
  };
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, saver().save, undefined, playback);
  const { acted, act } = recorder();
  for (const name of ['pause', 'resume', 'skip', 'stop'])
    assert.equal(audio.input(`/${name}`, act), `Playback: ${name}`);
  assert.deepEqual(calls, ['pause', 'resume', 'skip', 'stop']);
  assert.deepEqual(acted, []);
  assert.equal(audio.input('/dance', act), undefined);
});

test('rpg-42a.40 tui voice locale defaults to the campaign language', async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER, undefined, PORTUGUESE));
  const opened = openClientSession(dataDir, CAMPAIGN);
  try {
    assert.match(defaultTuiAudio(opened.session, opened.campaignId).status(), /, pt-BR, /);
  } finally {
    opened.close();
  }
});

test('rpg-42a.40 a campaign without a recorded language keeps the system voice locale', async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const opened = openClientSession(dataDir, CAMPAIGN);
  try {
    const snapshot = opened.session.getSnapshot({
      version: PROTOCOL_VERSION,
      type: 'GetCampaignSnapshot',
      campaignId: opened.campaignId,
    });
    assert.ok(snapshot.ok);
    assert.equal('language' in snapshot.value, false);
    const { locale } = Intl.DateTimeFormat().resolvedOptions();
    assert.match(defaultTuiAudio(opened.session, opened.campaignId).status(), new RegExp(`, ${locale}, `));
  } finally {
    opened.close();
  }
});

test('rpg-cm63.17 tui /voice shows speech diagnostics as numbers only', () => {
  const playback = {
    pause() {},
    resume() {},
    skip() {},
    stop() {},
    diagnostics: () => ({
      samples: 3,
      firstAudioMs: 412,
      cacheHitRate: 0,
      errors: { timeout: 1 },
      stages: { synthesis: 300 },
      peakQueueDepth: 2,
    }),
  };
  const { acted, act } = recorder();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, saver().save, undefined, playback);
  assert.equal(
    audio.input('/voice', act),
    'Speech: 3 samples, first audio 412 ms, synthesis 300 ms, peak queue 2, errors 1',
  );
  assert.deepEqual(acted, []);
  const idle = createTuiAudio(session, SUPPORTED_LOCALES, saver().save, undefined, {
    ...playback,
    diagnostics: () => undefined,
  });
  assert.equal(idle.input('/voice', act), 'Speech: no spoken turn yet.');
});

test('rpg-42a.53 tui voice messages read in Brazilian Portuguese', () => {
  const { saved, save } = saver();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, save, undefined, undefined, PORTUGUESE);
  const { act } = recorder();
  assert.equal(audio.status(), 'Voz: microfone off, saída off, en-US, 1x');
  assert.equal(audio.input('set output to narrator', act), 'Configurações de voz alteradas: spokenOutput narrator');
  assert.equal(audio.input('set speed to 9', act), 'Configurações de voz não alteradas: speed_out_of_range');
  assert.match(
    audio.input('set mic to push-to-talk', act) ?? '',
    /Permitir a captura do microfone nesta campanha\? Digite sim ou não\./,
  );
  assert.match(
    audio.input('sim', act) ?? '',
    /^Microfone permitido\.\nConfigurações de voz alteradas: microphone push-to-talk/,
  );
  assert.ok(saved.at(-1)?.consentGrantedAt);
  const declining = createTuiAudio(session, SUPPORTED_LOCALES, saver().save, undefined, undefined, PORTUGUESE);
  declining.input('set mic to hands-free', act);
  assert.equal(declining.input('não', act), 'O microfone continua desligado. Digite para jogar.');
});

test('rpg-42a.53 tui speech diagnostics read in Brazilian Portuguese', () => {
  const diagnostics = () => ({
    samples: 3,
    firstAudioMs: 412,
    cacheHitRate: 0,
    errors: { timeout: 1 },
    stages: { synthesis: 300 },
    peakQueueDepth: 2,
  });
  const playback = { pause() {}, resume() {}, skip() {}, stop() {}, diagnostics };
  const { act } = recorder();
  const audio = createTuiAudio(session, SUPPORTED_LOCALES, saver().save, undefined, playback, PORTUGUESE);
  assert.equal(
    audio.input('/voice', act),
    'Fala: 3 amostras, primeiro áudio 412 ms, síntese 300 ms, pico da fila 2, erros 1',
  );
  const idle = createTuiAudio(
    session,
    SUPPORTED_LOCALES,
    saver().save,
    undefined,
    { ...playback, diagnostics: () => undefined },
    PORTUGUESE,
  );
  assert.equal(idle.input('/voice', act), 'Fala: ainda não há turno falado.');
});
