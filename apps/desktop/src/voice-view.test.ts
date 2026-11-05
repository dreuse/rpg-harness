import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialState, viewModel } from './renderer.ts';
import { renderView } from './view.ts';
import type { DesktopVoiceView } from './voice.ts';
import type { VoiceProviderStatus } from './voice-host.ts';
import { DEFAULT_SPEECH, type VoiceSetupView } from './voice-setup.ts';

const WIDE_WIDTH = 1600;
const MIB = 1024 * 1024;
const KOKORO: VoiceProviderStatus = {
  id: 'kokoro',
  languages: ['en'],
  voices: ['af_heart', 'am_adam'],
  narrator: 'af_heart',
  installed: true,
  bytes: 310 * MIB,
  offer: {
    source: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main',
    bytes: 310 * MIB,
    sizeMiB: 310,
  },
};
const HOSTILE = '<b>Guard</b>';
const CAMPAIGN = 'campaign-a';
const voice: DesktopVoiceView = {
  mode: { kind: 'typed-input-only' },
  preferences: { microphone: 'off', spokenOutput: 'dialogue', locale: 'en', speed: 1.2 },
  subtitle: undefined,
  fallback: undefined,
  issues: [],
  asking: false,
};
const ready: VoiceSetupView = {
  step: 'closed',
  provider: KOKORO,
  narratorVoice: 'am_adam',
  providers: [KOKORO],
  speaking: [KOKORO],
  cacheBytes: 2048,
  progress: undefined,
  error: undefined,
  speech: { ...DEFAULT_SPEECH, volume: 0.5, npcVoices: { [CAMPAIGN]: { [HOSTILE]: 'af_heart' } } },
  npcVoices: { [HOSTILE]: 'af_heart' },
  diagnostics: {
    samples: 2,
    firstAudioMs: 243,
    cacheHitRate: 0.5,
    errors: { timeout: 1 },
    stages: { synthesis: 200, transfer: 13, decode: 30 },
  },
};
const html = (setup: VoiceSetupView, preferences = voice.preferences) =>
  renderView(
    viewModel({ ...initialState, selected: 'c1' }, WIDE_WIDTH),
    'en',
    undefined,
    { ...voice, preferences },
    setup,
  );
const labelled = (page: string, id: string, label: string) =>
  assert.ok(page.includes(`<label for="${id}">${label}</label>`) && page.includes(`id="${id}"`), `${id} ${label}`);

test('rpg-cm63.7 basic voice settings: on/off, mode, narrator voice with preview, language, speed and volume', () => {
  const page = html(ready);
  assert.match(page, /<button type="button" data-voice-setup="off">Turn voice off<\/button>/);
  labelled(page, 'voice-mode', 'Spoken output');
  for (const mode of ['off', 'narrator', 'dialogue', 'full', 'cinematic'])
    assert.match(page, new RegExp(`<option value="${mode}"${mode === 'dialogue' ? ' selected' : ''}>`));
  labelled(page, 'voice-narrator', 'Narrator voice');
  assert.match(page, /<option value="am_adam" selected>am_adam<\/option>/);
  assert.match(page, /data-voice-preview="narrator"/);
  labelled(page, 'voice-language', 'Language');
  labelled(page, 'voice-speed', 'Speed');
  assert.match(page, /id="voice-speed" type="range" min="0.5" max="2" step="0.1" value="1.2"/);
  labelled(page, 'voice-volume', 'Volume');
  assert.match(page, /id="voice-volume" type="range" min="0" max="1" step="0.05" value="0.5"/);
  const off = html(
    { ...ready, provider: undefined, providers: [], speaking: [] },
    { ...voice.preferences, spokenOutput: 'off' },
  );
  assert.match(off, /<button type="button" data-voice-setup="on" data-primary>Turn voice on<\/button>/);
});

test('rpg-cm63.7 advanced voice settings: provider, NPC voices, installed models, cache and diagnostics', () => {
  const page = html(ready);
  assert.match(page, /<details data-voice-advanced><summary>Advanced voice settings<\/summary>/);
  labelled(page, 'voice-provider', 'Voice provider');
  assert.ok(page.includes('&lt;b&gt;Guard&lt;/b&gt;'));
  assert.ok(!page.includes(HOSTILE));
  assert.match(page, /data-voice-npc-preview="&lt;b&gt;Guard&lt;\/b&gt;"/);
  assert.match(page, /data-voice-npc-remove="&lt;b&gt;Guard&lt;\/b&gt;"/);
  labelled(page, 'voice-npc-name', 'Character name');
  labelled(page, 'voice-npc-voice', 'Character voice');
  assert.match(page, /data-voice-npc="add"/);
  assert.match(page, /<li>kokoro · 310 MiB <button type="button" data-voice-remove="kokoro">Remove<\/button><\/li>/);
  assert.match(page, /Audio cache: 2 KiB <button type="button" data-voice-clear="cache">Clear cache<\/button>/);
  const diagnostics = /<dl data-voice-diagnostics>[\s\S]*?<\/dl>/.exec(page)?.[0] ?? '';
  for (const text of [
    'Time to first audio',
    '243 ms',
    'Cache hit rate',
    '50%',
    'Errors',
    'timeout: 1',
    'Speech synthesis',
    '200 ms',
    'Transfer',
    '13 ms',
    'Decoding',
    '30 ms',
  ])
    assert.ok(diagnostics.includes(text), text);
  assert.doesNotMatch(diagnostics, /Guard/);
});

test('rpg-cm63.7 setup flow dialog shows consent with size and source, progress, preview and text fallback', () => {
  const dialog = (setup: Partial<VoiceSetupView>) =>
    /<div role="dialog" tabindex="-1" data-voice-step="[^"]+"[\s\S]*?<\/div>/.exec(html({ ...ready, ...setup }))?.[0] ??
    '';
  assert.equal(dialog({ step: 'closed' }), '');
  assert.match(dialog({ step: 'checking' }), /Checking voices on this computer/);
  const consent = dialog({ step: 'consent', provider: { ...KOKORO, installed: false } });
  assert.match(consent, /Use the kokoro voice on this computer/);
  assert.match(consent, /310 MiB/);
  assert.match(consent, /huggingface\.co/);
  assert.match(consent, /data-voice-setup="accept" data-primary>Download and continue/);
  assert.match(consent, /data-voice-setup="decline">Not now/);
  const downloading = dialog({ step: 'downloading', progress: { bytes: 155 * MIB, total: 310 * MIB } });
  assert.match(
    downloading,
    /<div data-voice-progress><progress value="162529280" max="325058560"[^>]*><\/progress><span>155 of 310 MiB<\/span>/,
  );
  assert.match(dialog({ step: 'previewing' }), /Playing the narrator/);
  const done = dialog({ step: 'ready' });
  assert.match(done, /Voice is on/);
  assert.match(done, /data-voice-preview="narrator"/);
  assert.match(done, /data-voice-setup="finish" data-primary>Done/);
  assert.match(
    dialog({ step: 'unavailable' }),
    /No voice speaks this language on this computer yet\. The story stays in text\./,
  );
  const failed = dialog({ step: 'failed', error: 'timeout' });
  assert.match(failed, /role="alert">Voice could not start \(timeout\)\. The story stays in text\./);
  assert.match(failed, /data-voice-setup="on">Try again/);
});
