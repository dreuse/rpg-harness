import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KOKORO_CAPABILITIES, KOKORO_ONNX_PROVIDER_ID } from '../../../packages/voice/src/kokoro-provider.ts';
import { MLX_KOKORO_CAPABILITIES, MLX_KOKORO_PROVIDER_ID } from '../../../packages/voice/src/mlx-audio-engine.ts';
import { initialState, viewModel } from './renderer.ts';
import { renderView } from './view.ts';
import type { DesktopVoiceView } from './voice.ts';
import type { VoiceProviderStatus } from './voice-host.ts';
import { BRAZILIAN_PROVIDER_ID, VOICE_NAMES } from './voice-names.ts';
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
  detail: undefined,
  speech: { ...DEFAULT_SPEECH, volume: 0.5, npcVoices: { [CAMPAIGN]: { [HOSTILE]: 'af_heart' } } },
  npcVoices: { [HOSTILE]: 'af_heart' },
  speakers: ['Wren'],
  diagnostics: {
    samples: 2,
    firstAudioMs: 243,
    cacheHitRate: 0.5,
    errors: { timeout: 1 },
    stages: { synthesis: 200, transfer: 13, decode: 30 },
  },
  engine: undefined,
};
const html = (setup: VoiceSetupView, preferences = voice.preferences, locale = 'en') =>
  renderView(
    viewModel({ ...initialState, selected: 'c1' }, WIDE_WIDTH),
    locale,
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
  assert.match(page, /<option value="am_adam" selected>Adam, male, US English<\/option>/);
  assert.match(page, /data-voice-preview="narrator" aria-label="Preview the narrator voice">Preview<\/button>/);
  labelled(page, 'voice-language', 'Language');
  assert.match(page, /<option value="en" selected>English<\/option>/);
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

test('rpg-asjw.23 voice controls stay hidden while voice is off and the turn-on button stays', () => {
  const off = html(ready, { ...voice.preferences, spokenOutput: 'off' });
  assert.match(off, /data-voice-setup="on" data-primary>Turn voice on<\/button>/);
  assert.doesNotMatch(off, /id="voice-(mode|narrator|language|speed|volume|provider)"/);
});

test('rpg-cm63.7 advanced voice settings: provider, NPC voices, installed models, cache and diagnostics', () => {
  const page = html(ready);
  assert.doesNotMatch(page, /data-voice-advanced/);
  labelled(page, 'voice-provider', 'Voice provider');
  assert.match(page, /<option value="kokoro" selected>Built-in voice<\/option>/);
  assert.ok(page.includes('&lt;b&gt;Guard&lt;/b&gt;'));
  assert.ok(!page.includes(HOSTILE));
  assert.match(page, /data-voice-npc-preview="&lt;b&gt;Guard&lt;\/b&gt;"/);
  assert.match(page, /data-voice-npc-remove="&lt;b&gt;Guard&lt;\/b&gt;"/);
  assert.ok(page.includes('&lt;b&gt;Guard&lt;/b&gt; · Heart, female, US English'));
  labelled(page, 'voice-npc-voice', 'Character voice');
  assert.match(page, /data-voice-npc="add"/);
  assert.match(page, /<li>Built-in voice pack, 310 MB<\/li>/);
  assert.match(page, /<p>Audio cache: 2 KB<\/p>/);
  assert.match(
    page,
    /<div data-voice-actions><button type="button" data-voice-remove="kokoro" aria-label="Remove voice pack: Built-in voice pack, 310 MB">Remove voice pack<\/button><button type="button" data-voice-clear="cache">Clear cache<\/button><\/div>/,
  );
  const diagnostics = /<dl data-voice-diagnostics>[\s\S]*?<\/dl>/.exec(page)?.[0] ?? '';
  for (const text of [
    'Time to first audio',
    '243 ms',
    'Cache hit rate',
    '50%',
    'Errors',
    'timed out: 1',
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
  assert.match(
    consent,
    /Voice needs a one-time download to this computer: Built-in voice pack, 310 MB\. Source: huggingface\.co\./,
  );
  assert.match(consent, /data-voice-setup="accept" data-primary>Download and continue/);
  assert.match(consent, /data-voice-setup="decline">Not now/);
  const downloading = dialog({ step: 'downloading', progress: { bytes: 155 * MIB, total: 310 * MIB } });
  assert.match(
    downloading,
    /<div data-voice-progress><progress value="162529280" max="325058560"[^>]*><\/progress><span>155 of 310 MB<\/span>/,
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
  assert.match(failed, /role="alert">Voice could not start \(timed out\)\. The story stays in text\./);
  assert.match(failed, /data-voice-setup="on">Try again/);
  const installer = dialog({ step: 'failed', error: 'provider-error', detail: 'Needs uv <b>now</b>.' });
  assert.match(installer, /role="alert">Voice could not start \(Needs uv &lt;b&gt;now&lt;\/b&gt;\.\)/);
  assert.doesNotMatch(installer, /voice engine error/);
});

const RAW_IDS = ['kokoro', 'af_heart', ...Object.keys(VOICE_NAMES)];
const MLX: VoiceProviderStatus = {
  ...KOKORO,
  id: BRAZILIAN_PROVIDER_ID,
  languages: ['pt-BR'],
  voices: [...MLX_KOKORO_CAPABILITIES.voices],
};
const everyVoice: VoiceSetupView = {
  ...ready,
  provider: { ...KOKORO, voices: [...KOKORO_CAPABILITIES.voices] },
  providers: [KOKORO, MLX],
  speaking: [KOKORO, MLX],
};
const visibleText = (page: string) =>
  `${page.replace(/<[^>]*>/g, ' ')} ${[...page.matchAll(/aria-label="([^"]*)"/g)].map(([, label]) => label).join(' ')}`;

test('rpg-cm63.15 the voice panel never shows a raw provider, voice or model id in English or Portuguese', () => {
  const steps: Partial<VoiceSetupView>[] = [
    {},
    { step: 'consent', provider: { ...KOKORO, installed: false } },
    { step: 'downloading', progress: { bytes: MIB, total: 310 * MIB } },
    { step: 'ready' },
    { step: 'failed', error: 'provider-error' },
  ];
  for (const locale of ['en', 'es', 'pt-BR'])
    for (const step of steps) {
      const text = visibleText(html({ ...everyVoice, ...step }, voice.preferences, locale)).toLowerCase();
      for (const id of RAW_IDS) assert.ok(!text.includes(id.toLowerCase()), `${locale} ${step.step ?? 'closed'} ${id}`);
    }
});

test('rpg-cm63.15 every hosted provider and voice has a readable name and unknown ids get a neutral label', () => {
  assert.equal(BRAZILIAN_PROVIDER_ID, MLX_KOKORO_PROVIDER_ID);
  assert.equal(VOICE_NAMES[KOKORO_ONNX_PROVIDER_ID]?.kind, 'brazilian');
  for (const id of [...KOKORO_CAPABILITIES.voices, ...MLX_KOKORO_CAPABILITIES.voices, MLX_KOKORO_PROVIDER_ID])
    assert.ok(Object.hasOwn(VOICE_NAMES, id), id);
  const page = html(everyVoice);
  assert.match(page, /<option value="kokoro-mlx">Brazilian Portuguese voice<\/option>/);
  assert.match(page, /<option value="bf_emma">Emma, female, UK English<\/option>/);
  const strange = html({
    ...ready,
    provider: { ...KOKORO, id: 'zz-engine', voices: ['zz_one', 'am_adam'] },
    speaking: [{ ...KOKORO, id: 'zz-engine' }],
    providers: [{ ...KOKORO, id: 'zz-engine' }],
    npcVoices: { Wren: 'zz_gone' },
  });
  assert.match(strange, /<option value="zz_one">Voice 1<\/option>/);
  assert.match(strange, /<option value="zz-engine" selected>Voice provider 1<\/option>/);
  assert.match(strange, /<li>Voice pack, 310 MB<\/li>/);
  assert.ok(strange.includes('Wren · Another voice'));
  assert.doesNotMatch(visibleText(strange), /zz/);
  assert.match(
    html(everyVoice, voice.preferences, 'pt-BR'),
    /<option value="bf_emma">Emma, feminina, inglês britânico<\/option>/,
  );
});

test('rpg-cm63.15 the character picker lists known speaking characters plus Other with a free name field', () => {
  const page = html(ready);
  labelled(page, 'voice-npc-speaker', 'Character');
  assert.match(
    page,
    /<select id="voice-npc-speaker"><option value="Wren" selected>Wren<\/option><option value="">Other…<\/option><\/select>/,
  );
  assert.match(
    page,
    /<div data-voice-row data-voice-npc-other><label for="voice-npc-name">Other character name<\/label>/,
  );
  const none = html({ ...ready, speakers: [] });
  assert.doesNotMatch(none, /voice-npc-speaker/);
  labelled(none, 'voice-npc-name', 'Character name');
});

test('rpg-cm63.15 each voice choice has a labelled Preview that is hidden while voice is off', () => {
  const on = html(ready);
  assert.match(
    on,
    /data-voice-preview="character" aria-label="Preview the selected character voice">Preview<\/button>/,
  );
  assert.match(
    on,
    /data-voice-npc-preview="&lt;b&gt;Guard&lt;\/b&gt;" aria-label="Preview the voice of &lt;b&gt;Guard&lt;\/b&gt;">/,
  );
  const off = html(ready, { ...voice.preferences, spokenOutput: 'off' });
  assert.doesNotMatch(off, /data-voice-(npc-)?preview=/);
  assert.doesNotMatch(on, /data-voice-(npc-)?preview=[^>]* disabled>/);
});

test('rpg-cm63.15 diagnostics sit in a collapsed Troubleshooting section', () => {
  const page = html(ready);
  assert.match(
    page,
    /<details data-voice-troubleshooting><summary>Troubleshooting<\/summary><dl data-voice-diagnostics>/,
  );
  assert.doesNotMatch(page, /Voice diagnostics/);
  assert.match(
    html(ready, voice.preferences, 'pt-BR'),
    /<details data-voice-troubleshooting><summary>Solução de problemas<\/summary>/,
  );
});

test('rpg-cm63.15 voice controls share the body font and one button alignment', () => {
  const css = readFileSync(new URL('./view.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-voice-row\] > :is\(select, input\) \{[^}]*font: inherit;/);
  assert.match(css, /\[data-voice-actions\] \{[^}]*display: flex;/);
  assert.match(
    css,
    /\[data-voice-npcs\]:has\(#voice-npc-speaker option:checked:not\(\[value=""\]\)\) \[data-voice-npc-other\] \{\s*display: none;/,
  );
});

test('rpg-cm63.17 voice settings show pause, resume, skip and stop only while spoken output is on', () => {
  const page = html(ready);
  assert.match(page, /<div role="group" aria-label="Playback" data-voice-playback-group>/);
  for (const [command, label] of [
    ['pause', 'Pause'],
    ['resume', 'Resume'],
    ['skip', 'Skip'],
    ['stop', 'Stop'],
  ])
    assert.match(page, new RegExp(`<button type="button" data-voice-playback="${command}">${label}</button>`));
  assert.doesNotMatch(html(ready, { ...voice.preferences, spokenOutput: 'off' }), /data-voice-playback/);
  assert.match(html(ready, voice.preferences, 'pt-BR'), /data-voice-playback="pause">Pausar<\/button>/);
});

test('rpg-cm63.22 playback buttons sit on the play screen before the settings menu', () => {
  const page = html(ready);
  assert.ok(page.indexOf('data-voice-playback="pause"') < page.indexOf('<details data-settings>'));
  assert.equal(page.split('data-voice-playback-group').length, 2);
});

const ENGINE = { samples: 3, cacheHitRate: 0, errors: { timeout: 2 }, stages: {}, peakQueueDepth: 4 };
const diagnosticsOf = (page: string) => /<dl data-voice-diagnostics>[\s\S]*?<\/dl>/.exec(page)?.[0] ?? '';

test('rpg-cm63.22 troubleshooting shows the engine speech metrics when the engine reports them', () => {
  const rows = diagnosticsOf(html({ ...ready, engine: ENGINE }));
  assert.match(rows, /<dt>Spoken replies<\/dt><dd>3<\/dd>/);
  assert.match(rows, /<dt>Peak speech queue<\/dt><dd>4<\/dd>/);
  assert.match(rows, /<dt>Speech errors<\/dt><dd>timed out: 2<\/dd>/);
});

test('rpg-cm63.22 troubleshooting omits engine speech rows without a report and says none for empty metrics', () => {
  assert.doesNotMatch(diagnosticsOf(html(ready)), /Spoken replies|Peak speech queue|Speech errors/);
  const quiet = diagnosticsOf(html({ ...ready, engine: { samples: 0, cacheHitRate: 0, errors: {}, stages: {} } }));
  assert.match(quiet, /<dt>Spoken replies<\/dt><dd>0<\/dd>/);
  assert.match(quiet, /<dt>Peak speech queue<\/dt><dd>none<\/dd>/);
  assert.match(quiet, /<dt>Speech errors<\/dt><dd>none<\/dd>/);
});

test('rpg-cm63.22 engine speech rows are translated', () => {
  const rows = diagnosticsOf(html({ ...ready, engine: ENGINE }, voice.preferences, 'pt-BR'));
  assert.match(rows, /<dt>Respostas faladas<\/dt><dd>3<\/dd>/);
  assert.match(rows, /<dt>Pico da fila de fala<\/dt><dd>4<\/dd>/);
  assert.match(rows, /<dt>Erros de fala<\/dt><dd>tempo esgotado: 2<\/dd>/);
});

const SECTION = /data-settings-section="(\w+)" aria-labelledby="([\w-]+)"><h3 id="\2">([^<]*)<\/h3>/g;

test('rpg-42a.55 settings are a panel with section headings and troubleshooting under storage', () => {
  const page = html(ready);
  assert.match(
    page,
    /<div id="settings-panel" data-settings-panel tabindex="-1" role="group" aria-labelledby="settings-heading"><h2 id="settings-heading">Settings<\/h2>/,
  );
  assert.deepEqual(
    [...page.matchAll(SECTION)].map(([, key, , heading]) => [key, heading]),
    [
      ['general', 'General'],
      ['voice', 'Voice'],
      ['characters', 'Character voices'],
      ['gm', 'GM'],
      ['storage', 'Storage'],
    ],
  );
  const storage = page.slice(page.indexOf('data-settings-section="storage"'));
  assert.match(storage, /data-voice-troubleshooting/);
  assert.match(storage, /data-voice-clear="cache"/);
  assert.match(
    page.slice(page.indexOf('data-settings-section="characters"')),
    /^[\s\S]*?data-voice-npcs[\s\S]*?data-settings-section="gm"/,
  );
});

test('rpg-42a.55 the voice status line appears once and the typed hint is localized', () => {
  const status = 'Dialogue read aloud · English · 1.2× speed';
  assert.equal(html(ready).split(status).length, 2);
  const portuguese = html(ready, voice.preferences, 'pt-BR');
  assert.doesNotMatch(portuguese, /set mic|set output|set speed/);
  assert.match(
    portuguese,
    /data-settings-section="general" aria-labelledby="settings-general"><h3 id="settings-general">Geral<\/h3>/,
  );
  assert.match(portuguese, />Armazenamento<\/h3>/);
  assert.match(portuguese, />Mestre<\/h3>/);
});

test('rpg-cm63.55 installed voices with attributions list their credits, escaped, in storage', () => {
  const credited = { ...KOKORO, attributions: [`Voice by ${HOSTILE} (CC-BY-NC-4.0)`] };
  const page = html({ ...ready, providers: [credited] });
  assert.match(page, /<details data-voice-credits><summary>Voice credits<\/summary><ul><li>Voice by &lt;b&gt;/);
  assert.ok(!page.includes(`Voice by ${HOSTILE}`));
  assert.doesNotMatch(html(ready), /data-voice-credits/);
});
