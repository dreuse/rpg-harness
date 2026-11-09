import { type GmFailure, gmFailureKept, gmFailureText } from '../../../packages/client-protocol/src/gm-failure.ts';
import {
  budgetWarning,
  GM_MODEL_CHOICES,
  gmUsageLines,
  modelHintOf,
} from '../../../packages/client-protocol/src/gm-usage.ts';
import {
  loadStartDraft,
  RULES_SOURCE_FIELD,
  type StartScreen,
} from '../../../packages/client-protocol/src/guided-start.ts';
import type { GmSnapshot, StoryMemoryEntry, StoryMemoryView } from '../../../packages/client-protocol/src/protocol.ts';
import type { SlashOption } from '../../../packages/client-protocol/src/slash-commands.ts';
import {
  STORY_MEMORY_GROUPS,
  storyFacts,
  storyFactText,
  storyMemoryText,
} from '../../../packages/client-protocol/src/story-memory-text.ts';
import { MOTION_SETTINGS } from '../../../packages/client-protocol/src/visualization.ts';
import { type GmSettings, WHO_ROLLS, type WhoRolls } from '../../../packages/domain/src/gm.ts';
import { RULES_STRICTNESSES, type RulesStrictness } from '../../../packages/domain/src/rules-usage.ts';
import { SPOKEN_OUTPUT_MODES } from '../../../packages/domain/src/voice.ts';
import { MAX_CHANNEL_VOLUME, MIN_CHANNEL_VOLUME } from '../../../packages/voice/src/ambience.ts';
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from '../../../packages/voice/src/playback.ts';
import { PLAYBACK_COMMANDS } from '../../../packages/voice/src/playback-controls.ts';
import { SOUND_CHANNELS, SOUND_VOLUME_STEP, type SoundSettings } from '../../../packages/voice/src/sound-settings.ts';
import { VOICE_STAGES } from '../../../packages/voice/src/voice-diagnostics.ts';
import {
  actionForKey,
  endonym,
  languageName,
  type RendererAction,
  readPreferences,
  SUPPORTED_LOCALES,
  translate,
  type UiPreferences,
  voiceLabel,
} from './accessibility.ts';
import { renderRoll, renderRollBadge, rollSummary } from './dice.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import {
  OPENING_ACTION_ID,
  type Region,
  type SheetField,
  type SheetGroup,
  UNGROUPED,
  type viewModel,
} from './renderer.ts';
import type { SoundSetupView } from './sound-setup.ts';
import type { DesktopVoiceView } from './voice.ts';
import { packName, providerName, voiceName } from './voice-names.ts';
import { MAX_NPC_NAME_LENGTH, MAX_VOLUME, MIN_VOLUME, type VoiceSetupView } from './voice-setup.ts';

export type ReplayView = { readonly available: boolean; readonly playing?: string | undefined };
export type ViewModel = ReturnType<typeof viewModel> & {
  readonly soundSetup?: SoundSetupView;
  readonly replay?: ReplayView;
};
export type KeyEventLike = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly code?: string;
  readonly target?: unknown;
};
export type KeyTarget = {
  addEventListener(type: typeof KEYDOWN, listener: (event: KeyEventLike & { preventDefault(): void }) => void): void;
  addEventListener(type: typeof POINTERDOWN_EVENT, listener: () => void): void;
};

const KEYDOWN = 'keydown';
const POINTERDOWN_EVENT = 'pointerdown';
const KEY_SEPARATOR = '+';
const PHYSICAL_KEY = /^(?:Key|Digit)(.)$/;
const LABEL_SEPARATOR = ': ';
const MARKUP = /[&<>"']/g;
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ISSUE_SEPARATOR = ', ';
const HEADING_ID = 'heading-';
const STATUS: Region = 'status';
const DEFAULT_PANE: Region = 'conversation';
export const PANE_ATTRIBUTE = 'data-pane';
const MODIFIERS = [
  ['ctrlKey', 'Ctrl'],
  ['altKey', 'Alt'],
  ['shiftKey', 'Shift'],
  ['metaKey', 'Meta'],
] as const;

export const escapeHtml = (text: string) => text.replace(MARKUP, (character) => ENTITIES[character] ?? character);

export const SLASH_OPTION_ID = 'slash-option-';
export const SLASH_OPTION_ATTRIBUTE = 'data-slash';

export const slashMenuHtml = (options: readonly SlashOption[], active: number) =>
  options
    .map(({ id, name, args, description }, index) => {
      const safeId = escapeHtml(id);
      const hint = args === '' ? '' : ` <span data-slash-args>${escapeHtml(args)}</span>`;
      return `<div role="option" id="${SLASH_OPTION_ID}${safeId}" aria-selected="${index === active}" ${SLASH_OPTION_ATTRIBUTE}="${safeId}"><span data-slash-name>${escapeHtml(name)}</span>${hint} <span data-slash-description>${escapeHtml(description)}</span></div>`;
    })
    .join('');

const CSS_UNSAFE = /^\d|[^\w-]/gu;
const HEX = 16;
export const cssEscape = (text: string) =>
  text.replace(CSS_UNSAFE, (character) => `\\${character.codePointAt(0)?.toString(HEX)} `);

const list = (items: readonly string[]) => `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
const PRIMARY = ' data-primary';
const button = (attribute: string, value: string, label: string, current = false, primary = false) =>
  `<button type="button" ${attribute}="${escapeHtml(value)}"${current ? ' aria-current="true"' : ''}${primary ? PRIMARY : ''}>${escapeHtml(label)}</button>`;

const empty = (locale: string, region: Region) =>
  `<p data-empty>${escapeHtml(translate(locale, `empty.${region}`))}</p>`;
const orEmpty = (items: readonly string[], locale: string, region: Region) =>
  items.length === 0 ? empty(locale, region) : list(items);
const speaker = (locale: string, who: 'player' | 'gm', text: string, trailing = '') =>
  `<p data-speaker="${who}"><span data-speaker-label>${escapeHtml(translate(locale, `speaker.${who}`))}</span>${escapeHtml(text)}${trailing}</p>`;
const systemLine = (text: string) => `<p data-speaker="system">${escapeHtml(text)}</p>`;
const playerLine = (locale: string, input: string, rollOfferId: string | undefined) =>
  rollOfferId === undefined
    ? speaker(locale, 'player', input)
    : `<p data-speaker="roll">${escapeHtml(translate(locale, 'roll.accepted', { label: input }))}</p>`;
export const RETRY_TURN_ATTRIBUTE = 'data-retry-turn';
const failureNotice = (locale: string, failure: GmFailure) =>
  `<p data-speaker="system" data-gm-failure role="alert">${escapeHtml(gmFailureText(locale, failure))} ${escapeHtml(gmFailureKept(locale))}</p>${button(RETRY_TURN_ATTRIBUTE, '', translate(locale, 'action.retryTurn'), false, true)}`;
const gmLine = (locale: string, narration: string, pending: boolean, trailing: string) =>
  narration.trim() === ''
    ? systemLine(translate(locale, pending ? 'label.pending' : 'label.no-reply'))
    : speaker(locale, 'gm', narration, trailing);

const replayButton = (locale: string, actionId: string, narration: string, replay: ReplayView | undefined) => {
  if (replay?.available !== true || narration.trim() === '') return '';
  const playing = replay.playing === actionId;
  return `<button type="button" ${REPLAY}="${escapeHtml(actionId)}" aria-label="${escapeHtml(translate(locale, playing ? 'replay.stop' : 'replay.play'))}"><span aria-hidden="true">${playing ? REPLAY_STOP_ICON : REPLAY_PLAY_ICON}</span></button>`;
};

const GM_FIELD = 'gm';

const diagnostics = ({ diagnostics: { pid, gm, error, attempts } }: ViewModel, locale: string) =>
  `<details data-diagnostics><summary>${escapeHtml(translate(locale, 'diagnostics.summary'))}</summary><dl>${Object.entries(
    { pid, gm, error, attempts },
  )
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `<dt>${escapeHtml(translate(locale, `diagnostics.${name}`))}</dt><dd>${escapeHtml(name === GM_FIELD ? translate(locale, `gm.${value}`) : String(value))}</dd>`,
    )
    .join('')}</dl></details>`;

const pageHeading = (text: string) => `<h1 id="${HEADING_ID}${STATUS}" tabindex="-1">${escapeHtml(text)}</h1>`;

const header = (model: ViewModel, locale: string) =>
  `<hgroup>${pageHeading(model.title.campaign === undefined ? translate(locale, 'app.name') : model.title.campaign)}${model.title.scene === undefined ? '' : `<p>${escapeHtml(model.title.scene)}</p>`}</hgroup>`;

const connection = (model: ViewModel, locale: string) =>
  `<p role="status" data-connection="${model.status.connection}">${escapeHtml(model.status.label)}</p>${model.status.canRetry ? button('data-action', 'retry', translate(locale, 'action.retry')) : ''}${diagnostics(model, locale)}`;

export const NAV_ATTRIBUTE = 'data-nav';
const homeNav = (locale: string) =>
  `<button type="button" id="nav-home" ${NAV_ATTRIBUTE}="home" aria-label="${escapeHtml(translate(locale, 'nav.homeLabel'))}">${escapeHtml(translate(locale, 'nav.home'))}</button>`;

export const VOICE_SETUP = 'data-voice-setup';
export const VOICE_FIELD = 'data-voice-field';
export const VOICE_PREVIEW = 'data-voice-preview';
export const VOICE_NPC = 'data-voice-npc';
export const VOICE_NPC_PREVIEW = 'data-voice-npc-preview';
export const VOICE_NPC_REMOVE = 'data-voice-npc-remove';
export const VOICE_REMOVE = 'data-voice-remove';
export const VOICE_CLEAR = 'data-voice-clear';
export const VOICE_PLAYBACK = 'data-voice-playback';
export const REPLAY = 'data-replay';
const REPLAY_PLAY_ICON = '\u25B6';
const REPLAY_STOP_ICON = '\u25A0';
export const VOICE_NPC_NAME = 'voice-npc-name';
export const VOICE_NPC_SPEAKER = 'voice-npc-speaker';
export const VOICE_NPC_VOICE = 'voice-npc-voice';
export const NARRATOR_PREVIEW = 'narrator';
export const CHARACTER_PREVIEW = 'character';
const OTHER_SPEAKER = '';
const UNKNOWN_FAILURE = 'provider-error';
const DISABLED = ' disabled';
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const PERCENT = 100;
const VOLUME_STEP = 0.05;
const SPEED_STEP = 0.1;

const labelled = (id: string, label: string, control: string, extra = '') =>
  `<div data-voice-row><label for="${id}">${escapeHtml(label)}</label>${control}${extra}</div>`;
const options = (
  values: readonly string[],
  current: string | undefined,
  label: (value: string) => string = (value) => value,
) =>
  values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label(value))}</option>`,
    )
    .join('');
const select = (id: string, field: string, label: string, body: string, extra = '') =>
  labelled(id, label, `<select id="${id}" ${VOICE_FIELD}="${field}">${body}</select>`, extra);
const RANGE_FORMAT = 'data-range-format';
const RANGE_READOUT = 'data-range-readout';
const ARIA_VALUETEXT = 'aria-valuetext';
const SPEED_DECIMALS = 1;
const RANGE_FORMATS: Record<string, (value: number) => string> = {
  speed: (value) => `${value.toFixed(SPEED_DECIMALS)}x`,
  percent: (value) => `${Math.round(value * PERCENT)}%`,
};
const rangeText = (format: string, value: number) => RANGE_FORMATS[format]?.(value) ?? String(value);

interface RangeElement {
  value: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  closest(selector: string): { querySelector(selector: string): { textContent: string | null } | null } | null;
}

export const syncRangeReadout = (input: RangeElement) => {
  const format = input.getAttribute(RANGE_FORMAT);
  if (format === null) return;
  const text = rangeText(format, Number(input.value));
  input.setAttribute(ARIA_VALUETEXT, text);
  const readout = input.closest('[data-voice-row]')?.querySelector(`[${RANGE_READOUT}]`);
  if (readout) readout.textContent = text;
};

const rangeInput = (
  id: string,
  [min, max, step]: readonly number[],
  value: number,
  format: string,
  attributes: string,
  disabled = false,
) =>
  `<input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" ${attributes} ${RANGE_FORMAT}="${format}" ${ARIA_VALUETEXT}="${rangeText(format, value)}"${disabled ? DISABLED : ''}>`;
const rangeRow = (id: string, label: string, input: string, value: number, format: string) =>
  `<div data-voice-row><label for="${id}">${escapeHtml(label)}</label><output for="${id}" ${RANGE_READOUT}>${rangeText(format, value)}</output>${input}</div>`;
const range = (id: string, field: string, label: string, bounds: readonly number[], value: number, format: string) =>
  rangeRow(id, label, rangeInput(id, bounds, value, format, `${VOICE_FIELD}="${field}"`), value, format);
const mib = (bytes: number) => Math.round(bytes / BYTES_PER_MIB);
const ms = (locale: string, value: number) => translate(locale, 'voice.diagnostics.ms', { value: Math.round(value) });

const previewButton = (attribute: string, value: string, label: string, locale: string, off: boolean) =>
  `<button type="button" ${attribute}="${escapeHtml(value)}" aria-label="${escapeHtml(label)}"${off ? DISABLED : ''}>${escapeHtml(translate(locale, 'voice.preview'))}</button>`;
const voiceOptions = (voices: readonly string[], current: string | undefined, locale: string) =>
  options(voices, current, (id) => voiceName(locale, id, voices));
const failureName = (locale: string, code: string) => translate(locale, `voice.failure.${code}`);

const playbackControls = (locale: string) =>
  `<div role="group" aria-label="${escapeHtml(translate(locale, 'voice.playback'))}" ${VOICE_PLAYBACK}-group>${PLAYBACK_COMMANDS.map((command) => button(VOICE_PLAYBACK, command, translate(locale, `voice.playback.${command}`))).join('')}</div>`;

const basicVoice = ({ preferences }: DesktopVoiceView, setup: VoiceSetupView, locale: string) => {
  const on = preferences.spokenOutput !== 'off';
  const voices = setup.provider?.voices ?? [];
  const languages = [...new Set([...setup.speaking.flatMap(({ languages }) => languages), preferences.locale])];
  return `<fieldset data-voice-basic><legend>${escapeHtml(translate(locale, 'region.voice'))}</legend>${
    on
      ? button(VOICE_SETUP, 'off', translate(locale, 'voice.turnOff'))
      : button(VOICE_SETUP, 'on', translate(locale, 'voice.on'), false, true)
  }${select(
    'voice-mode',
    'spokenOutput',
    translate(locale, 'voice.mode'),
    options(SPOKEN_OUTPUT_MODES, preferences.spokenOutput, (mode) => translate(locale, `voice.output.${mode}`)),
  )}${
    voices.length === 0
      ? ''
      : select(
          'voice-narrator',
          'narratorVoice',
          translate(locale, 'voice.narrator'),
          voiceOptions(voices, setup.narratorVoice, locale),
          previewButton(VOICE_PREVIEW, NARRATOR_PREVIEW, translate(locale, 'voice.previewNarrator'), locale, !on),
        )
  }${select(
    'voice-language',
    'locale',
    translate(locale, 'voice.language'),
    options(languages, preferences.locale, (language) => languageName(locale, language)),
  )}${range('voice-speed', 'speed', translate(locale, 'voice.speedLabel'), [MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED, SPEED_STEP], preferences.speed, 'speed')}${range('voice-volume', 'volume', translate(locale, 'voice.volume'), [MIN_VOLUME, MAX_VOLUME, VOLUME_STEP], setup.speech.volume, 'percent')}</fieldset>`;
};

const npcRow =
  (locale: string, voices: readonly string[], off: boolean) =>
  ([name, voice]: readonly [string, string]) =>
    `<li><span>${escapeHtml(name)} · ${escapeHtml(voiceName(locale, voice, voices))}</span><span data-voice-actions>${previewButton(VOICE_NPC_PREVIEW, name, translate(locale, 'voice.previewLabel', { name }), locale, off)}<button type="button" ${VOICE_NPC_REMOVE}="${escapeHtml(name)}" aria-label="${escapeHtml(translate(locale, 'voice.npcRemoveLabel', { name }))}">${escapeHtml(translate(locale, 'voice.npcRemove'))}</button></span></li>`;

const nameField = (locale: string, key: string, extra = '') =>
  `<div data-voice-row${extra}><label for="${VOICE_NPC_NAME}">${escapeHtml(translate(locale, key))}</label><input id="${VOICE_NPC_NAME}" maxlength="${MAX_NPC_NAME_LENGTH}"></div>`;

const speakerPicker = ({ speakers }: VoiceSetupView, locale: string) =>
  speakers.length === 0
    ? nameField(locale, 'voice.npcName')
    : `${labelled(VOICE_NPC_SPEAKER, translate(locale, 'voice.npcSpeaker'), `<select id="${VOICE_NPC_SPEAKER}">${options(speakers, speakers[0])}<option value="${OTHER_SPEAKER}">${escapeHtml(translate(locale, 'voice.npcOther'))}</option></select>`)}${nameField(locale, 'voice.npcOtherName', ' data-voice-npc-other')}`;

const npcVoices = (setup: VoiceSetupView, locale: string, off: boolean) => {
  const rows = Object.entries(setup.npcVoices);
  const voices = setup.provider?.voices ?? [];
  return `<fieldset data-voice-npcs><legend>${escapeHtml(translate(locale, 'voice.npcs'))}</legend>${rows.length === 0 ? '' : `<ul>${rows.map(npcRow(locale, voices, off)).join('')}</ul>`}${
    voices.length === 0
      ? ''
      : `${speakerPicker(setup, locale)}${labelled(VOICE_NPC_VOICE, translate(locale, 'voice.npcVoice'), `<select id="${VOICE_NPC_VOICE}">${voiceOptions(voices, voices[0], locale)}</select>`)}<div data-voice-actions>${previewButton(VOICE_PREVIEW, CHARACTER_PREVIEW, translate(locale, 'voice.previewCharacter'), locale, off)}${button(VOICE_NPC, 'add', translate(locale, 'voice.npcAdd'))}</div>`
  }</fieldset>`;
};

const voiceStorage = ({ providers, cacheBytes }: VoiceSetupView, locale: string) => {
  const installed = providers
    .filter(({ installed }) => installed)
    .map(({ id, bytes }) => ({ id, name: packName(locale, id, mib(bytes)) }));
  const removes = installed.map(
    ({ id, name }) =>
      `<button type="button" ${VOICE_REMOVE}="${escapeHtml(id)}" aria-label="${escapeHtml(translate(locale, 'voice.removeLabel', { pack: name }))}">${escapeHtml(translate(locale, 'voice.remove'))}</button>`,
  );
  const credits = providers.flatMap(({ installed, attributions = [] }) => (installed ? attributions : []));
  const creditsList =
    credits.length === 0
      ? ''
      : `<details data-voice-credits><summary>${escapeHtml(translate(locale, 'voice.credits'))}</summary><ul>${credits.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></details>`;
  return `<h4>${escapeHtml(translate(locale, 'voice.models'))}</h4>${
    installed.length === 0
      ? `<p>${escapeHtml(translate(locale, 'voice.noModels'))}</p>`
      : `<ul>${installed.map(({ name }) => `<li>${escapeHtml(name)}</li>`).join('')}</ul>`
  }<p>${escapeHtml(translate(locale, 'voice.cache', { size: Math.round(cacheBytes / BYTES_PER_KIB) }))}</p><div data-voice-actions>${removes.join('')}${button(VOICE_CLEAR, 'cache', translate(locale, 'voice.clear'))}</div>${creditsList}`;
};

const failureList = (locale: string, errors: Readonly<Record<string, number | undefined>>) => {
  const failures = Object.entries(errors).map(([code, count]) => `${failureName(locale, code)}: ${count}`);
  return failures.length === 0 ? translate(locale, 'voice.diagnostics.none') : failures.join(ISSUE_SEPARATOR);
};

const engineSpeechRows = (engine: VoiceSetupView['engine'], locale: string): [string, string][] =>
  engine === undefined
    ? []
    : [
        [translate(locale, 'voice.diagnostics.spokenReplies'), String(engine.samples)],
        [
          translate(locale, 'voice.diagnostics.peakQueue'),
          engine.peakQueueDepth === undefined
            ? translate(locale, 'voice.diagnostics.none')
            : String(engine.peakQueueDepth),
        ],
        [translate(locale, 'voice.diagnostics.speechErrors'), failureList(locale, engine.errors)],
      ];

const voiceDiagnostics = (
  { diagnostics: { firstAudioMs, cacheHitRate, errors, stages }, engine }: VoiceSetupView,
  locale: string,
) => {
  const rows: [string, string][] = [
    [
      translate(locale, 'voice.diagnostics.firstAudio'),
      firstAudioMs === undefined ? translate(locale, 'voice.diagnostics.none') : ms(locale, firstAudioMs),
    ],
    [
      translate(locale, 'voice.diagnostics.cacheHits'),
      translate(locale, 'voice.diagnostics.percent', { value: Math.round(cacheHitRate * PERCENT) }),
    ],
    [translate(locale, 'voice.diagnostics.errors'), failureList(locale, errors)],
    ...VOICE_STAGES.flatMap((stage): [string, string][] => {
      const value = stages[stage];
      return value === undefined ? [] : [[translate(locale, `voice.stage.${stage}`), ms(locale, value)]];
    }),
    ...engineSpeechRows(engine, locale),
  ];
  return `<details data-voice-troubleshooting><summary>${escapeHtml(translate(locale, 'voice.troubleshooting'))}</summary><dl data-voice-diagnostics>${rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl></details>`;
};

const voiceProvider = (setup: VoiceSetupView, locale: string) => {
  const ids = setup.speaking.map(({ id }) => id);
  return ids.length === 0
    ? ''
    : select(
        'voice-provider',
        'providerId',
        translate(locale, 'voice.provider'),
        options(ids, setup.provider?.id, (id) => providerName(locale, id, ids)),
      );
};

const voiceSettings = (voice: DesktopVoiceView | undefined, setup: VoiceSetupView | undefined, locale: string) =>
  voice === undefined
    ? ''
    : `<p data-voice-hint>${escapeHtml(translate(locale, 'voice.hint'))}</p>${setup === undefined ? '' : `${basicVoice(voice, setup, locale)}${voiceProvider(setup, locale)}`}`;

export const SOUND_FIELD_TOGGLE = 'data-sound-toggle';
export const SOUND_FIELD_VOLUME = 'data-sound-volume';

const soundRow = (settings: SoundSettings, channel: (typeof SOUND_CHANNELS)[number], locale: string) => {
  const { enabled, volume } = settings[channel];
  const toggleId = `sound-${channel}`;
  const volumeId = `${toggleId}-volume`;
  return `<div data-voice-row><label for="${toggleId}"><input id="${toggleId}" type="checkbox" ${SOUND_FIELD_TOGGLE}="${channel}"${enabled ? ' checked' : ''}> ${escapeHtml(translate(locale, `sound.${channel}`))}</label></div>${rangeRow(volumeId, translate(locale, `sound.volume.${channel}`), rangeInput(volumeId, [MIN_CHANNEL_VOLUME, MAX_CHANNEL_VOLUME, SOUND_VOLUME_STEP], volume, 'percent', `${SOUND_FIELD_VOLUME}="${channel}"`, !enabled), volume, 'percent')}`;
};

export const SOUND_SETUP = 'data-sound-setup';

const SOURCE_SEPARATOR = /,\s*/;

const sourceHosts = (sources: string) =>
  sources
    .split(SOURCE_SEPARATOR)
    .map((source) => URL.parse(source)?.host ?? source)
    .join(', ');

const soundSetupBody = (
  { step, installed, offer, progress, retryMinutes, unavailable }: SoundSetupView,
  locale: string,
) => {
  const text = (key: string, values?: Record<string, string | number>, status = false) =>
    `<p${status ? ' role="status" tabindex="-1"' : ''}>${escapeHtml(translate(locale, key, values))}</p>`;
  const download = button(SOUND_SETUP, 'download', translate(locale, 'sound.setup.download'));
  if (step === 'consent' && offer !== undefined)
    return `${text('sound.setup.consent', { size: offer.sizeMiB, source: sourceHosts(offer.source) })}${button(SOUND_SETUP, 'accept', translate(locale, 'sound.setup.accept'), false, true)}${button(SOUND_SETUP, 'decline', translate(locale, 'sound.setup.decline'))}`;
  if (step === 'downloading')
    return `${text('sound.setup.downloading', undefined, true)}${progress === undefined ? '' : `<div data-voice-progress><progress value="${progress.bytes}" max="${progress.total}" aria-label="${escapeHtml(translate(locale, 'sound.setup.downloading'))}"></progress><span>${escapeHtml(translate(locale, 'voice.setup.progress', { done: mib(progress.bytes), total: mib(progress.total) }))}</span></div>`}`;
  if (step === 'failed') {
    const message =
      retryMinutes === undefined
        ? translate(locale, unavailable ? 'sound.setup.unavailable' : 'sound.setup.failed')
        : translate(locale, 'sound.setup.busy', { minutes: retryMinutes });
    return `${alert(message)}${download}`;
  }
  if (installed) return `<p role="status" tabindex="-1">${escapeHtml(translate(locale, 'sound.setup.installed'))}</p>`;
  return offer === undefined ? '' : download;
};

export const soundPanel = (settings: SoundSettings, locale: string, setup?: SoundSetupView) =>
  `<fieldset data-sound><legend>${escapeHtml(translate(locale, 'sound.legend'))}</legend>${SOUND_CHANNELS.map((channel) => soundRow(settings, channel, locale)).join('')}${setup === undefined ? '' : soundSetupBody(setup, locale)}</fieldset>`;

export const GM_FORM = 'data-gm-form';
export const GM_DEFAULTS_FORM = 'data-gm-defaults-form';
const GM_MODELS_LIST = 'gm-models';
const GM_HELP_ID = 'gm-help';

const GM_MODEL_INPUT = ` list="${GM_MODELS_LIST}"`;
const GM_BUDGET_INPUT = ' type="number" min="1" step="1"';

const gmInput = (locale: string, name: keyof GmSettings, values: GmSettings, placeholders: GmSettings) =>
  `<label>${escapeHtml(translate(locale, `gmModel.${name}`))} <input name="${name}"${name === 'sessionBudgetTokens' ? GM_BUDGET_INPUT : GM_MODEL_INPUT} value="${escapeHtml(String(values[name] ?? ''))}" placeholder="${escapeHtml(String(placeholders[name] ?? ''))}" aria-describedby="${GM_HELP_ID}"></label>`;

const strictnessOption = (locale: string, value: RulesStrictness | '', chosen: RulesStrictness | undefined) =>
  `<option value="${value}"${value !== '' && value === chosen ? ' selected' : ''}>${escapeHtml(translate(locale, `gmModel.rulesStrictness.${value === '' ? 'default' : value}`))}</option>`;

const strictnessControl = (locale: string, chosen: RulesStrictness | undefined) =>
  `<label>${escapeHtml(translate(locale, 'gmModel.rulesStrictness'))} <select name="rulesStrictness">${['' as const, ...RULES_STRICTNESSES].map((value) => strictnessOption(locale, value, chosen)).join('')}</select></label>`;

const whoRollsOption = (locale: string, value: WhoRolls | '', chosen: WhoRolls | undefined) =>
  `<option value="${value}"${value !== '' && value === chosen ? ' selected' : ''}>${escapeHtml(translate(locale, `gmModel.whoRolls.${value === '' ? 'default' : value}`))}</option>`;

const whoRollsControl = (locale: string, chosen: WhoRolls | undefined) =>
  `<label>${escapeHtml(translate(locale, 'gmModel.whoRolls'))} <select name="whoRolls">${['' as const, ...WHO_ROLLS].map((value) => whoRollsOption(locale, value, chosen)).join('')}</select></label>`;

const gmInputs = (locale: string, values: GmSettings, placeholders: GmSettings) =>
  `${gmInput(locale, 'model', values, placeholders)}${gmInput(locale, 'summaryModel', values, placeholders)}${gmInput(locale, 'sessionBudgetTokens', values, placeholders)}`;

const gmUsage = (gm: GmSnapshot | undefined, locale: string) => {
  if (gm === undefined) return '';
  const warning = budgetWarning(gm, locale);
  return gmUsageLines(gm, locale)
    .map((line) => `<p${line === warning ? ' role="status"' : ''}>${escapeHtml(line)}</p>`)
    .join('');
};

const gmSettings = (gm: GmSnapshot | undefined, locale: string) => {
  const campaign = gm?.campaignSettings ?? {};
  const defaults = gm?.defaults ?? {};
  const options = GM_MODEL_CHOICES.map(
    (choice) =>
      `<option value="${choice}">${escapeHtml(translate(locale, `gmModel.hint.${modelHintOf(choice)}`))}</option>`,
  ).join('');
  return `<form ${GM_FORM}><fieldset><legend>${escapeHtml(translate(locale, 'gmModel.legend'))}</legend>${gmInputs(locale, campaign, defaults)}${strictnessControl(locale, campaign.rulesStrictness)}${whoRollsControl(locale, campaign.whoRolls)}<datalist id="${GM_MODELS_LIST}">${options}</datalist><p id="${GM_HELP_ID}">${escapeHtml(translate(locale, 'gmModel.help'))}</p><button type="submit">${escapeHtml(translate(locale, 'gmModel.save'))}</button></fieldset></form>${gmUsage(gm, locale)}<form ${GM_DEFAULTS_FORM}><fieldset><legend>${escapeHtml(translate(locale, 'gmModel.defaultsLegend'))}</legend>${gmInputs(locale, defaults, {})}<button type="submit">${escapeHtml(translate(locale, 'gmModel.saveDefaults'))}</button></fieldset></form>`;
};

const SETTINGS_HEADING_ID = 'settings-heading';
export const SETTINGS_PANEL = 'data-settings-panel';
const SETTINGS_PANEL_ID = 'settings-panel';
export const SETTINGS_TOGGLE = 'data-settings-toggle';

const settingsSection = (key: string, heading: string, body: string) =>
  body === ''
    ? ''
    : `<section data-settings-section="${key}" aria-labelledby="settings-${key}"><h3 id="settings-${key}">${escapeHtml(heading)}</h3>${body}</section>`;

const settingsMenu = (
  model: ViewModel,
  locale: string,
  voice: DesktopVoiceView | undefined,
  setup: VoiceSetupView | undefined,
) => {
  const off = voice?.preferences.spokenOutput === 'off';
  const sections = [
    settingsSection(
      'general',
      translate(locale, 'settings.section.general'),
      `${languageControl(locale)}${storyLanguageControl(model.storyLanguage, locale)}${model.uses.dice ? motionControl(model.motion, locale) : ''}${soundPanel(model.sound, locale, model.soundSetup)}`,
    ),
    settingsSection('voice', translate(locale, 'region.voice'), voiceSettings(voice, setup, locale)),
    settingsSection(
      'characters',
      translate(locale, 'voice.npcs'),
      setup === undefined ? '' : npcVoices(setup, locale, off === true),
    ),
    settingsSection('gm', translate(locale, 'settings.section.gm'), gmSettings(model.gm, locale)),
    settingsSection(
      'storage',
      translate(locale, 'settings.section.storage'),
      setup === undefined ? '' : `${voiceStorage(setup, locale)}${voiceDiagnostics(setup, locale)}`,
    ),
  ];
  return `<details data-settings><summary id="settings-toggle" ${SETTINGS_TOGGLE}>${escapeHtml(translate(locale, 'settings.label'))}</summary><div id="${SETTINGS_PANEL_ID}" ${SETTINGS_PANEL} tabindex="-1" role="group" aria-labelledby="${SETTINGS_HEADING_ID}"><h2 id="${SETTINGS_HEADING_ID}">${escapeHtml(translate(locale, 'settings.label'))}</h2>${sections.join('')}</div></details>`;
};

const setupBody = ({ step, provider, progress, error }: VoiceSetupView, locale: string): string => {
  const text = (key: string, values?: Record<string, string | number>) =>
    `<p>${escapeHtml(translate(locale, key, values))}</p>`;
  switch (step) {
    case 'checking':
      return `<p role="status">${escapeHtml(translate(locale, 'voice.setup.checking'))}</p>`;
    case 'consent':
      return provider === undefined
        ? ''
        : `${text('voice.setup.consent', { pack: packName(locale, provider.id, provider.offer.sizeMiB), source: URL.parse(provider.offer.source)?.host ?? provider.offer.source })}${button(VOICE_SETUP, 'accept', translate(locale, 'voice.setup.accept'), false, true)}${button(VOICE_SETUP, 'decline', translate(locale, 'voice.setup.decline'))}`;
    case 'downloading':
      return `${text('voice.setup.downloading')}${
        progress === undefined
          ? ''
          : `<div data-voice-progress><progress value="${progress.bytes}" max="${progress.total}" aria-label="${escapeHtml(translate(locale, 'voice.setup.downloading'))}"></progress><span>${escapeHtml(translate(locale, 'voice.setup.progress', { done: mib(progress.bytes), total: mib(progress.total) }))}</span></div>`
      }`;
    case 'previewing':
      return `<p role="status">${escapeHtml(translate(locale, 'voice.setup.previewing'))}</p>`;
    case 'ready':
      return `${text('voice.setup.ready')}${button(VOICE_PREVIEW, NARRATOR_PREVIEW, translate(locale, 'voice.setup.again'))}${button(VOICE_SETUP, 'finish', translate(locale, 'voice.setup.done'), false, true)}`;
    case 'unavailable':
      return `${text('voice.setup.unavailable')}${button(VOICE_SETUP, 'finish', translate(locale, 'voice.setup.done'), false, true)}`;
    case 'failed':
      return `${alert(translate(locale, 'voice.setup.failed', { reason: failureName(locale, error ?? UNKNOWN_FAILURE) }))}${button(VOICE_SETUP, 'on', translate(locale, 'voice.setup.retry'))}${button(VOICE_SETUP, 'finish', translate(locale, 'voice.setup.done'), false, true)}`;
    default:
      return '';
  }
};

const renderSetup = (setup: VoiceSetupView | undefined, locale: string) => {
  const body = setup === undefined ? '' : setupBody(setup, locale);
  return body === ''
    ? ''
    : section(
        'voice-setup',
        locale,
        `<div role="dialog" tabindex="-1" data-voice-step="${setup?.step}" aria-label="${escapeHtml(translate(locale, 'voice.setup'))}">${body}</div>`,
      );
};

export const HOME_ATTRIBUTE = 'data-home';
export const HOME_NAME = 'data-name';
export const HOME_SEARCH = 'home-search';
const HOME_FIELD_SEPARATOR = ' · ';

type HomeModel = ViewModel['home'];
type HomeCardModel = HomeModel['cards'][number];

const homeButton = (
  action: string,
  locale: string,
  { id, name, primary = false }: { id: string; name?: string; primary?: boolean },
) =>
  `<button type="button" id="${id}" ${HOME_ATTRIBUTE}="${action}"${name === undefined ? '' : ` ${HOME_NAME}="${escapeHtml(name)}" aria-label="${escapeHtml(translate(locale, `home.${action}Label`, { name }))}"`}${primary ? PRIMARY : ''}>${escapeHtml(translate(locale, `home.${action}`))}</button>`;

const cardFields = (card: HomeCardModel) =>
  [card.characters, card.rules, card.scene, card.when].filter((field) => field !== undefined && field !== '');

const cardDetails = (card: HomeCardModel, locale: string) =>
  card.health === 'ok'
    ? `${cardFields(card).length === 0 ? '' : `<p data-meta>${escapeHtml(cardFields(card).join(HOME_FIELD_SEPARATOR))}</p>`}${card.narration === undefined ? '' : `<p data-narration>${escapeHtml(card.narration)}</p>`}`
    : `<p data-problem>${escapeHtml(`${translate(locale, `home.problem.${card.health}`)} ${translate(locale, 'home.restoreHint')}`)}</p>`;

type CardActions = { readonly prefix: string; readonly primary: string; readonly menu: readonly string[] };
const ACTIVE_CARD: CardActions = { prefix: 'home-card', primary: 'continue', menu: ['rename', 'archive', 'delete'] };
const ARCHIVED_CARD: CardActions = { prefix: 'home-archived', primary: 'unarchive', menu: ['delete'] };

export const homeActionId = (action: string, index: number, archived: boolean) =>
  `home-${archived ? 'archived-' : ''}${action}-${index}`;

const cardMenu = ({ prefix, menu }: CardActions, card: HomeCardModel, index: number, locale: string) => {
  const idOf = (action: string) => homeActionId(action, index, prefix === ARCHIVED_CARD.prefix);
  return `<details data-menu><summary id="${idOf('more')}" aria-label="${escapeHtml(translate(locale, 'home.moreLabel', { name: card.name }))}">${escapeHtml(translate(locale, 'home.more'))}</summary><div>${menu
    .map((action) => homeButton(action, locale, { id: idOf(action), name: card.name }))
    .join('')}</div></details>`;
};

const homeCard = (actions: CardActions, locale: string) => (card: HomeCardModel, index: number) =>
  `<li><article aria-labelledby="${actions.prefix}-${index}"${card.selected ? ' aria-current="true"' : ''}><h3 id="${actions.prefix}-${index}">${escapeHtml(card.name)}</h3>${cardDetails(card, locale)}<div data-actions>${
    actions.primary === 'continue' && !card.playable
      ? ''
      : homeButton(actions.primary, locale, { id: `home-${actions.primary}-${index}`, name: card.name, primary: true })
  }${cardMenu(actions, card, index, locale)}</div></article></li>`;

export const RENAME_INPUT_ID = 'home-rename-input';

const renameField = (confirm: NonNullable<HomeModel['confirm']>, locale: string) =>
  confirm.kind === 'rename'
    ? `<label for="${RENAME_INPUT_ID}">${escapeHtml(translate(locale, 'home.renameLabel', { name: confirm.name }))}</label><input id="${RENAME_INPUT_ID}" type="text" value="${escapeHtml(confirm.name)}">`
    : '';

const homeNotices = ({ error, undo, confirm }: HomeModel, locale: string) =>
  [
    error === undefined ? '' : alert(error),
    undo === undefined
      ? ''
      : `<p role="status">${escapeHtml(translate(locale, 'home.archivedNotice', { name: undo }))} ${homeButton('undo', locale, { id: 'home-undo' })}</p>`,
    confirm === undefined
      ? ''
      : `<div role="alertdialog" aria-labelledby="home-confirm-text"><p id="home-confirm-text">${escapeHtml(translate(locale, `home.ask.${confirm.kind}`, { name: confirm.name }))}</p>${renameField(confirm, locale)}<button type="button" id="home-confirm" ${HOME_ATTRIBUTE}="confirm">${escapeHtml(translate(locale, `home.${confirm.kind}`))}</button>${homeButton('cancel', locale, { id: 'home-cancel' })}</div>`,
  ].join('');

const homeList = (home: HomeModel, starting: boolean, locale: string) => {
  if (home.total === 0)
    return `${empty(locale, 'campaigns')}${starting ? '' : button(START_OPEN, 'home', translate(locale, 'start.first'), false, true)}`;
  const search = home.search
    ? `<label for="${HOME_SEARCH}">${escapeHtml(translate(locale, 'home.search'))}</label><input id="${HOME_SEARCH}" type="search" value="${escapeHtml(home.query)}">`
    : '';
  const cards =
    home.cards.length === 0
      ? `<p data-empty>${escapeHtml(translate(locale, 'home.noMatch'))}</p>`
      : `<ul>${home.cards.map(homeCard(ACTIVE_CARD, locale)).join('')}</ul>`;
  return search + cards;
};

const archivedList = ({ archived }: HomeModel, locale: string) =>
  archived.length === 0
    ? ''
    : `<details data-archived><summary>${escapeHtml(translate(locale, 'home.archived', { count: archived.length }))}</summary><ul>${archived.map(homeCard(ARCHIVED_CARD, locale)).join('')}</ul></details>`;

const rollHistory = (older: ViewModel['rolls'], locale: string) =>
  older.length === 0
    ? ''
    : `<details data-roll-history><summary>${escapeHtml(translate(locale, 'roll.history'))}</summary><ol>${older.map((plan) => `<li>${escapeHtml(rollSummary(plan, locale))}</li>`).join('')}</ol></details>`;

const linkedRolls = ({ rolls }: ViewModel, actionId: string, locale: string) =>
  rolls
    .filter((plan) => plan.actionId === actionId)
    .map((plan) => renderRoll(plan, locale))
    .join('');

const rollTray = ({ rolls, conversation, rollsCollapsed, rollBadgeFresh }: ViewModel, locale: string) => {
  const linked = new Set(conversation.map(({ actionId }) => actionId));
  const [latest, ...older] = rolls.filter(({ actionId }) => actionId === undefined || !linked.has(actionId));
  return latest === undefined
    ? ''
    : rollsCollapsed
      ? renderRollBadge(latest, locale, rollBadgeFresh)
      : `<section data-rolls tabindex="-1" aria-label="${escapeHtml(translate(locale, 'region.rolls'))}">${renderRoll(latest, locale)}${rollHistory(older, locale)}</section>`;
};

export const ROLL_OFFER_ATTRIBUTE = 'data-roll-offer';
export const OOC_ATTRIBUTE = 'data-ooc';
export const OOC_EXCHANGE = 'data-ooc-exchange';
export const OOC_INDEX = 'data-ooc-index';
export const OOC_PANEL = 'ooc-panel';
export const MEMORY_ATTRIBUTE = 'data-memory';
export const MEMORY_INDEX = 'data-memory-index';
export const MEMORY_PANEL = 'memory-panel';

const memoryFact = (fact: StoryMemoryEntry, index: number, locale: string) =>
  `<li><span>${escapeHtml(storyFactText(fact))}</span>${fact.corrected ? ` <em>${escapeHtml(storyMemoryText(locale, 'memory.corrected'))}</em>` : ''}<form ${MEMORY_ATTRIBUTE}="correct" ${MEMORY_INDEX}="${index}"><label for="${MEMORY_PANEL}-value-${index}">${escapeHtml(storyMemoryText(locale, 'memory.value'))}</label><input id="${MEMORY_PANEL}-value-${index}" name="value" autocomplete="off" required><button type="submit">${escapeHtml(storyMemoryText(locale, 'memory.correct'))}</button></form></li>`;

const memoryGroups = ({ memory }: StoryMemoryView, locale: string) => {
  const facts = storyFacts(memory);
  return facts.length === 0
    ? systemLine(storyMemoryText(locale, 'memory.empty'))
    : STORY_MEMORY_GROUPS.map(
        (group) =>
          `<section aria-labelledby="${MEMORY_PANEL}-${group}"><h4 id="${MEMORY_PANEL}-${group}">${escapeHtml(storyMemoryText(locale, `memory.group.${group}`))}</h4><ul>${memory[group].map((fact) => memoryFact(fact, facts.indexOf(fact), locale)).join('')}</ul></section>`,
      ).join('');
};

const memoryPanel = ({ memory }: ViewModel, locale: string) =>
  memory.open
    ? `<section id="${MEMORY_PANEL}" data-memory-panel aria-labelledby="${MEMORY_PANEL}-heading"><h3 id="${MEMORY_PANEL}-heading">${escapeHtml(storyMemoryText(locale, 'memory.heading'))}</h3>${memory.unavailable ? systemLine(storyMemoryText(locale, 'memory.unavailable')) : memory.view === undefined ? '' : memoryGroups(memory.view, locale)}${memory.error === undefined ? '' : `<p role="alert">${escapeHtml(storyMemoryText(locale, 'memory.rejected', { reason: memory.error }))}</p>`}</section>`
    : '';

const oocButton = (action: string, label: string, exchangeId: string, index: number) =>
  `<button type="button" ${OOC_ATTRIBUTE}="${action}" ${OOC_EXCHANGE}="${escapeHtml(exchangeId)}" ${OOC_INDEX}="${index}">${escapeHtml(label)}</button>`;

const oocProposal = (
  { proposal, status, error }: ViewModel['ooc']['exchanges'][number]['proposals'][number],
  exchangeId: string,
  index: number,
  locale: string,
) => {
  const summary = escapeHtml(proposal.summary);
  const note = error === undefined ? '' : `<p role="alert">${escapeHtml(error)}</p>`;
  if (status === 'applied')
    return `<li data-ooc-status="applied">${summary}${LABEL_SEPARATOR}${escapeHtml(translate(locale, 'ooc.applied'))}</li>`;
  if (status === 'declined')
    return `<li data-ooc-status="declined">${summary}${LABEL_SEPARATOR}${escapeHtml(translate(locale, 'ooc.declined'))}</li>`;
  const busy = status === 'applying' ? ' aria-busy="true"' : '';
  const actions =
    status === 'open'
      ? `${oocButton('confirm', translate(locale, 'ooc.confirm'), exchangeId, index)}${oocButton('decline', translate(locale, 'ooc.decline'), exchangeId, index)}`
      : '';
  return `<li data-ooc-status="${status}"${busy}>${summary}${actions}${note}</li>`;
};

const oocExchange = (
  { id, text, asking, reply, error, proposals }: ViewModel['ooc']['exchanges'][number],
  locale: string,
) =>
  `<li ${OOC_EXCHANGE}="${escapeHtml(id)}"><p data-speaker="ooc-you"><span data-ooc-label>${escapeHtml(translate(locale, 'ooc.you'))}${LABEL_SEPARATOR}</span>${escapeHtml(text)}</p>${asking ? `<p data-speaker="system">${escapeHtml(translate(locale, 'ooc.asking'))}</p>` : ''}${reply === undefined ? '' : `<p data-speaker="ooc-gm"><span data-ooc-label>${escapeHtml(translate(locale, 'ooc.gm'))}${LABEL_SEPARATOR}</span>${escapeHtml(reply)}</p>`}${error === undefined ? '' : `<p role="alert">${escapeHtml(error)}</p>`}${proposals.length === 0 ? '' : `<ul>${proposals.map((entry, index) => oocProposal(entry, id, index, locale)).join('')}</ul>`}</li>`;

const oocPanel = ({ ooc }: ViewModel, locale: string) =>
  !ooc.active && ooc.exchanges.length === 0 && ooc.undoable === undefined
    ? ''
    : `<section id="${OOC_PANEL}" data-ooc-panel aria-labelledby="${OOC_PANEL}-heading"><h3 id="${OOC_PANEL}-heading">${escapeHtml(translate(locale, 'ooc.heading'))}</h3><p data-speaker="system">${escapeHtml(translate(locale, 'ooc.note'))}</p><ol aria-live="polite">${ooc.exchanges.map((exchange) => oocExchange(exchange, locale)).join('')}</ol>${ooc.undoable === undefined ? '' : `<button type="button" ${OOC_ATTRIBUTE}="undo">${escapeHtml(translate(locale, 'ooc.undo', { summary: ooc.undoable }))}</button>`}</section>`;

const PLAYER_ROLLS: WhoRolls = 'me';

const rollOfferButton = ({ rollOffer, gm }: ViewModel, locale: string) =>
  rollOffer === undefined || (rollOffer.expression !== undefined && gm?.settings.whoRolls === PLAYER_ROLLS)
    ? ''
    : button(
        ROLL_OFFER_ATTRIBUTE,
        rollOffer.offerId,
        `${translate(locale, 'roll.offer')}${LABEL_SEPARATOR}${rollOffer.label}`,
        false,
        true,
      );

export const ROLL_REPORT_FORM = 'data-roll-report-form';
export const ROLL_REPORT_INPUT = 'roll-report-input';
const DICE_TERM = /(\d+)d(\d+)/g;
const COUNT_GROUP = 1;
const SIDES_GROUP = 2;

const reportBounds = (expression: string) => {
  const terms = [...expression.matchAll(DICE_TERM)].map((term) => [
    Number(term[COUNT_GROUP]),
    Number(term[SIDES_GROUP]),
  ]);
  if (terms.length === 0) return '';
  const min = terms.reduce((sum, [count = 0]) => sum + count, 0);
  const max = terms.reduce((sum, [count = 0, sides = 0]) => sum + count * sides, 0);
  return ` min="${min}" max="${max}"`;
};

const rollReportForm = ({ rollOffer }: ViewModel, locale: string) =>
  rollOffer?.expression === undefined
    ? ''
    : `<form ${ROLL_REPORT_FORM} aria-label="${escapeHtml(translate(locale, 'roll.report.form'))}"><label for="${ROLL_REPORT_INPUT}">${escapeHtml(translate(locale, 'roll.report.label', { expression: rollOffer.expression }))}</label><input id="${ROLL_REPORT_INPUT}" name="total" type="number" step="1"${reportBounds(rollOffer.expression)} required><button type="submit">${escapeHtml(translate(locale, 'roll.report.submit'))}</button></form>`;

export const SHEET_FORM = 'data-sheet-form';
export const SHEET_ACTION = 'data-sheet-action';
export const SHEET_INPUT = 'sheet-field-';
const NUMBER_INPUT = 'type="number" step="any" required';
const TEXT_INPUT = 'type="text"';

const bound = (name: string, value: number | undefined) => (value === undefined ? '' : ` ${name}="${value}"`);

const sheetInput = ({ id, value, error, min, max }: SheetField) => {
  const name = escapeHtml(id);
  const invalid = error === undefined ? '' : ` aria-invalid="true" aria-describedby="sheet-error-${name}"`;
  const typed =
    typeof value === 'boolean'
      ? `type="checkbox"${value ? ' checked' : ''}`
      : typeof value === 'number'
        ? `${NUMBER_INPUT}${bound('min', min)}${bound('max', max)} value="${value}"`
        : `${TEXT_INPUT} value="${escapeHtml(String(value ?? ''))}"`;
  return `<input id="${SHEET_INPUT}${name}" name="${name}" ${typed}${invalid}>`;
};

const sheetError = ({ id, error }: SheetField) =>
  error === undefined ? '' : `<p role="alert" id="sheet-error-${escapeHtml(id)}">${escapeHtml(error)}</p>`;

const sheetModifier = ({ modifier }: SheetField, locale: string) =>
  modifier === undefined
    ? ''
    : ` <span data-modifier>${escapeHtml(translate(locale, 'sheet.modifier', { value: modifier }))}</span>`;

const sheetValue = (field: SheetField, locale: string) => {
  const { id, text, explanation } = field;
  const modifier = sheetModifier(field, locale);
  return explanation === undefined
    ? `${escapeHtml(text)}${modifier}`
    : `<span tabindex="0" aria-describedby="sheet-explain-${escapeHtml(id)}">${escapeHtml(text)}</span><span role="tooltip" id="sheet-explain-${escapeHtml(id)}">${escapeHtml(explanation)}</span>${modifier}`;
};

const statOpen = ({ id, changed }: SheetField) =>
  `<div data-stat="${escapeHtml(id)}"${changed ? ' data-changed' : ''}>`;

const statView = (locale: string) => (field: SheetField) =>
  `${statOpen(field)}<dt>${escapeHtml(field.name)}</dt><dd>${sheetValue(field, locale)}</dd></div>`;

const statEditor = (locale: string) => (field: SheetField) =>
  field.editable
    ? `${statOpen(field)}<label for="${SHEET_INPUT}${escapeHtml(field.id)}">${escapeHtml(field.name)}</label>${sheetInput(field)}${sheetError(field)}</div>`
    : `${statOpen(field)}<span>${escapeHtml(field.name)}</span><span>${sheetValue(field, locale)}</span></div>`;

const sheetGroup = ({ id, fields }: SheetGroup, locale: string, editing: boolean) => {
  const items = editing
    ? `<div data-stats>${fields.map(statEditor(locale)).join('')}</div>`
    : `<dl data-stats>${fields.map(statView(locale)).join('')}</dl>`;
  if (id === UNGROUPED) return items;
  const group = escapeHtml(id);
  return `<section data-sheet-group="${group}" aria-labelledby="sheet-group-${group}"><h4 id="sheet-group-${group}">${escapeHtml(translate(locale, `sheet.group.${id}`))}</h4>${items}</section>`;
};

const sheetBody = (groups: readonly SheetGroup[], editing: boolean, name: string, locale: string) => {
  const editable = groups.some(({ fields }) => fields.some((field) => field.editable));
  const body = groups.map((group) => sheetGroup(group, locale, editing && editable)).join('');
  if (!editable) return name + body;
  if (!editing)
    return `<div data-sheet-head>${name}<button type="button" id="sheet-edit" ${SHEET_ACTION}="edit">${escapeHtml(translate(locale, 'sheet.edit'))}</button></div>${body}`;
  return `${name}<form ${SHEET_FORM} novalidate aria-label="${escapeHtml(translate(locale, 'sheet.edit'))}">${body}<div data-actions><button type="submit" id="sheet-save"${PRIMARY}>${escapeHtml(translate(locale, 'sheet.save'))}</button><button type="button" id="sheet-cancel" ${SHEET_ACTION}="cancel">${escapeHtml(translate(locale, 'sheet.cancel'))}</button></div></form>`;
};

const REGION_BODIES: Readonly<Record<Region, (model: ViewModel, locale: string) => string>> = {
  campaigns: ({ home, start }, locale) =>
    homeNotices(home, locale) + homeList(home, start !== undefined, locale) + archivedList(home, locale),
  status: (model, locale) => `${pageHeading(translate(locale, 'app.name'))}${connection(model, locale)}`,
  conversation: (model, locale) =>
    `<ol aria-live="polite">${model.conversation
      .map(
        ({ actionId, input, narration, pending, noRoll, failure, rollOfferId }) =>
          `<li data-action-id="${escapeHtml(actionId)}"${pending ? ' aria-busy="true"' : ''}>${actionId === OPENING_ACTION_ID ? '' : playerLine(locale, input, rollOfferId)}${linkedRolls(model, actionId, locale)}${failure === undefined ? gmLine(locale, narration, pending, pending ? '' : replayButton(locale, actionId, narration, model.replay)) : failureNotice(locale, failure)}${noRoll === undefined ? '' : systemLine(translate(locale, `noRoll.${noRoll}`))}</li>`,
      )
      .join(
        '',
      )}</ol>${model.conversation.length === 0 ? empty(locale, 'conversation') : ''}${rollOfferButton(model, locale)}${rollReportForm(model, locale)}${rollTray(model, locale)}${oocPanel(model, locale)}${memoryPanel(model, locale)}`,
  sheet: ({ sheetGroups, sheetEditing, character }, locale) => {
    const name = character === undefined ? '' : `<h3>${escapeHtml(character)}</h3>`;
    if (sheetGroups.length > 0) return sheetBody(sheetGroups, sheetEditing, name, locale);
    return character === undefined
      ? empty(locale, 'sheet')
      : `${name}<p data-empty>${escapeHtml(translate(locale, 'sheet.noStats'))}</p>`;
  },
  character: ({ characterCard }) =>
    characterCard === undefined
      ? ''
      : `<h3>${escapeHtml(characterCard.name)}</h3>${characterCard.description === undefined ? '' : `<p>${escapeHtml(characterCard.description)}</p>`}`,
  panels: ({ panels }, locale) =>
    orEmpty(
      panels === undefined
        ? []
        : [
            ...panels.inventory.map(({ name }) => name),
            ...panels.quests.map(({ title }) => title),
            ...(panels.recap.scene === undefined ? [] : [panels.recap.scene]),
          ].map(escapeHtml),
      locale,
      'panels',
    ),
};

const section = (name: string, locale: string, body: string) =>
  `<section data-region="${name}" aria-label="${escapeHtml(translate(locale, `region.${name}`))}">${body}</section>`;

const pane = (region: Region, locale: string, body: string, hidden: boolean) =>
  `<section data-region="${region}" aria-labelledby="${HEADING_ID}${region}"${hidden ? ' hidden' : ''}>${region === STATUS ? '' : `<h2 id="${HEADING_ID}${region}">${escapeHtml(translate(locale, `region.${region}`))}</h2>`}${body}</section>`;

const rejectedAlert = ({ rejected }: ViewModel, locale: string) =>
  rejected.length === 0
    ? ''
    : section(
        'rejected',
        locale,
        `<ul role="alert">${rejected.map(({ input, message }) => `<li>${escapeHtml(input)}${LABEL_SEPARATOR}${escapeHtml(message)}</li>`).join('')}</ul>`,
      );

const alert = (text: string) => `<p role="alert">${escapeHtml(text)}</p>`;

export const VOICE_ATTRIBUTE = 'data-voice';
export const ALLOW = 'allow';
export const DECLINE = 'decline';

const consentPrompt = (locale: string) =>
  `<div role="alertdialog" aria-label="${escapeHtml(translate(locale, 'voice.consent'))}"><p>${escapeHtml(translate(locale, 'voice.consent'))}</p>${button(VOICE_ATTRIBUTE, ALLOW, translate(locale, 'voice.allow'))}${button(VOICE_ATTRIBUTE, DECLINE, translate(locale, 'voice.decline'))}</div>`;

const voiceOff = ({ microphone, spokenOutput }: DesktopVoiceView['preferences']) =>
  microphone === 'off' && spokenOutput === 'off';

export const renderVoice = (
  { preferences, subtitle, fallback, issues, asking }: DesktopVoiceView,
  locale: string,
): string =>
  voiceOff(preferences) && !asking && !subtitle?.text && fallback === undefined && issues.length === 0
    ? ''
    : section(
        'voice',
        locale,
        [
          voiceOff(preferences) ? '' : `<p>${escapeHtml(voiceLabel(locale, preferences))}</p>`,
          asking ? consentPrompt(locale) : '',
          `<p aria-live="polite">${escapeHtml(subtitle?.text ?? '')}</p>`,
          fallback === undefined ? '' : alert(translate(locale, 'voice.fallback', { reason: fallback })),
          issues.length === 0
            ? ''
            : alert(translate(locale, 'voice.rejected', { codes: issues.join(ISSUE_SEPARATOR) })),
        ].join(''),
      );

export const START_OPEN = 'data-start-open';
export const START_IMPORT = 'data-start-import';
export const IMPORT_ACTIONS = ['pick', 'pickOwn', 'pickSetting', 'activate', 'decline'] as const;
export type ImportAction = (typeof IMPORT_ACTIONS)[number];
export const START_OPTION = 'data-start-option';
export const START_PREVIEW = 'data-start-preview';
export const START_VOICE = 'data-start-voice';
export const START_CONTROL = 'data-start-control';
export const START_FORM = 'data-start-form';
export const START_TITLE = 'data-start-title';
export const START_ENTRY = 'start-entry';
export const START_SUBMIT = 'start-submit';
export const START_EDIT = 'data-start-edit';
export const START_CONTROLS = ['back', 'skip', 'next', 'start', 'close'] as const;
export type StartControl = (typeof START_CONTROLS)[number];
const START_FORM_ID = 'start-form';
const OPTION_ID = 'start-option-';
const REVIEW_ID = 'start-review-';
const GROUP_ID = 'start-group-';
const START_VOICE_ID = 'start-voice';
const PRIMARY_CONTROLS: readonly StartControl[] = ['next', 'start'];

const startTitle = ({ title, progress }: StartScreen, locale: string) =>
  progress === undefined ? title : translate(locale, 'start.step', { ...progress, title });

const startOption =
  (step: StartScreen['step']) =>
  ({ label, detail, selected, badge }: StartScreen['options'][number], index: number) =>
    `<li><button type="button" ${START_OPTION}="${index}"${step === 'path' ? '' : ` aria-pressed="${selected}"`} aria-labelledby="${OPTION_ID}${index}-label"${detail === '' ? '' : ` aria-describedby="${OPTION_ID}${index}-detail"`}><span id="${OPTION_ID}${index}-label" data-option-label>${escapeHtml(label)}${badge === undefined ? '' : ` <span data-option-badge>${escapeHtml(badge)}</span>`}</span>${detail === '' ? '' : `<span id="${OPTION_ID}${index}-detail" data-option-detail>${escapeHtml(detail)}</span>`}</button></li>`;

type StartOptionItem = StartScreen['options'][number];

const optionGroups = (options: readonly StartOptionItem[]) =>
  options.reduce<{ group: string | undefined; items: { option: StartOptionItem; index: number }[] }[]>(
    (groups, option, index) => {
      const last = groups.at(-1);
      if (last !== undefined && last.group === option.group) last.items.push({ option, index });
      else groups.push({ group: option.group, items: [{ option, index }] });
      return groups;
    },
    [],
  );

const voiceChoice = (items: readonly { option: StartOptionItem; index: number }[], locale: string, group: string) => {
  const ids = items.map(({ option }) => option.label);
  const current = items.find(({ option }) => option.selected) ?? items[0];
  return `<div data-voice-row><label for="${START_VOICE_ID}">${escapeHtml(group)}</label><select id="${START_VOICE_ID}" ${START_VOICE}>${items
    .map(
      ({ option, index }) =>
        `<option value="${index}"${option === current?.option ? ' selected' : ''}>${escapeHtml(voiceName(locale, option.label, ids))}</option>`,
    )
    .join(
      '',
    )}</select><button type="button" id="${START_VOICE_ID}-preview" ${START_PREVIEW}="${current?.index}">${escapeHtml(translate(locale, 'start.preview'))}</button></div>`;
};

const startOptions = ({ step, options }: StartScreen, locale: string) =>
  options.length === 0
    ? ''
    : optionGroups(options)
        .map(({ group, items }, number) => {
          if (group !== undefined && items.every(({ option }) => option.preview !== undefined))
            return voiceChoice(items, locale, group);
          const list = `<ul data-start-options${group === undefined ? '' : ` aria-labelledby="${GROUP_ID}${number}"`}>${items.map(({ option, index }) => startOption(step)(option, index)).join('')}</ul>`;
          return group === undefined ? list : `<h3 id="${GROUP_ID}${number}">${escapeHtml(group)}</h3>${list}`;
        })
        .join('');

const startEntry = ({ entry }: StartScreen) =>
  entry === undefined
    ? ''
    : `<form id="${START_FORM_ID}" ${START_FORM}="${START_ENTRY}"><label for="${START_ENTRY}">${escapeHtml(entry.label)}</label><input id="${START_ENTRY}" name="${START_ENTRY}" value="${escapeHtml(entry.value)}"></form>`;

type ReviewGroup = NonNullable<StartScreen['review']>[number];

const reviewItem =
  (locale: string) =>
  ({ label, value, chosen, step }: ReviewGroup['items'][number]) =>
    `<li data-provenance="${chosen ? 'chosen' : 'default'}"><span data-review-label>${escapeHtml(label)}</span><span data-review-value>${escapeHtml(value)}</span><span data-review-badge>${escapeHtml(translate(locale, chosen ? 'start.chosen' : 'start.default'))}</span><button type="button" ${START_EDIT}="${step}" aria-label="${escapeHtml(translate(locale, 'start.editLabel', { label }))}">${escapeHtml(translate(locale, 'start.edit'))}</button></li>`;

const startReview = (review: readonly ReviewGroup[], locale: string) =>
  `<div data-start-review>${review
    .map(
      ({ title, items }, index) =>
        `<h3 id="${REVIEW_ID}${index}">${escapeHtml(title)}</h3><ul aria-labelledby="${REVIEW_ID}${index}">${items.map(reviewItem(locale)).join('')}</ul>`,
    )
    .join('')}</div>`;

const shownControls = (screen: StartScreen): readonly StartControl[] =>
  START_CONTROLS.filter(
    (control) =>
      (control === 'back' && screen.canBack) ||
      (control === 'skip' && screen.canSkip) ||
      (control === 'next' && screen.canNext) ||
      (control === 'start' && screen.step === 'summary'),
  );

const startControl = (screen: StartScreen, locale: string) => (control: StartControl) =>
  `<button type="button" ${START_CONTROL}="${control}"${PRIMARY_CONTROLS.includes(control) ? PRIMARY : ''}${control === 'start' && !screen.canStart ? ' disabled' : ''}>${escapeHtml(translate(locale, `start.${control}`))}</button>`;

const startSubmit = ({ entry, step }: StartScreen, locale: string) =>
  entry === undefined || step === 'summary'
    ? ''
    : `<button type="submit" id="${START_SUBMIT}" form="${START_FORM_ID}"${PRIMARY}>${escapeHtml(translate(locale, 'start.next'))}</button>`;

const startActions = (screen: StartScreen, locale: string) => {
  const actions = shownControls(screen).map(startControl(screen, locale)).join('') + startSubmit(screen, locale);
  return actions === '' ? '' : `<div data-actions>${actions}</div>`;
};

const importLines = (lines: readonly string[]) => escapeHtml(lines.join('\n'));

const importOutcome = ({ rulebookImport }: ViewModel, locale: string) => {
  if (rulebookImport === undefined) return '';
  const { status, lines } = rulebookImport;
  if (status === 'needsPack') return alert(translate(locale, 'start.importNeedsPack'));
  if (status === 'failed') return `<div role="alert"><pre>${importLines(lines)}</pre></div>`;
  if (status !== 'preview') return `<div role="status"><pre>${importLines(lines)}</pre></div>`;
  const decide = (action: 'activate' | 'decline') =>
    `<button type="button" ${START_IMPORT}="${action}">${escapeHtml(translate(locale, action === 'activate' ? 'start.importAccept' : 'start.importDecline'))}</button>`;
  return `<pre data-import-report tabindex="0" aria-label="${escapeHtml(translate(locale, 'start.importReport'))}">${importLines(lines)}</pre><div data-actions>${decide('activate')}${decide('decline')}</div>`;
};

const ownFilesChosen = ({ options }: StartScreen) =>
  options.some(
    ({ action, selected }) =>
      selected && action.kind === 'set' && action.field === RULES_SOURCE_FIELD && action.value === 'own',
  );

const ownFilesButton = (start: StartScreen, locale: string) =>
  ownFilesChosen(start)
    ? `<button type="button" ${START_IMPORT}="pickOwn">${escapeHtml(translate(locale, 'start.importOwn'))}</button>`
    : '';

const settingButton = (model: ViewModel, locale: string) =>
  `<div data-start-import-block><button type="button" ${START_IMPORT}="pickSetting">${escapeHtml(translate(locale, 'start.importSetting'))}</button>${importOutcome(model, locale)}</div>`;

const startImport = (model: ViewModel, start: StartScreen, locale: string) =>
  start.step === 'genre'
    ? settingButton(model, locale)
    : start.step === 'rules'
      ? `<div data-start-import-block><p>${escapeHtml(translate(locale, 'start.importHint'))}</p><button type="button" ${START_IMPORT}="pick">${escapeHtml(translate(locale, 'start.import'))}</button>${ownFilesButton(start, locale)}${importOutcome(model, locale)}</div>`
      : '';

const startBody = (model: ViewModel, locale: string) => {
  const { start, created, playing, home } = model;
  return start === undefined
    ? `${playing || home.total === 0 ? '' : button(START_OPEN, 'open', translate(locale, 'start.open'), false, true)}${created === undefined || playing ? '' : `<p role="status">${escapeHtml(translate(locale, 'start.created', { name: created }))}</p>`}`
    : [
        `<div data-start-head><h2 tabindex="-1" ${START_TITLE}="${start.step}">${escapeHtml(startTitle(start, locale))}</h2>${startControl(start, locale)('close')}</div>`,
        ...(start.review === undefined ? start.text.map((line) => `<p>${escapeHtml(line)}</p>`) : []),
        startOptions(start, locale),
        startImport(model, start, locale),
        ...(start.notes ?? []).map((line) => `<p role="status">${escapeHtml(line)}</p>`),
        start.review === undefined ? '' : startReview(start.review, locale),
        startEntry(start),
        start.error === undefined ? '' : alert(start.error),
        startActions(start, locale),
      ].join('');
};

const renderStart = (model: ViewModel, locale: string) => {
  const body = startBody(model, locale);
  return body === '' ? '' : section('start', locale, body);
};

const paneSwitcher = (regions: readonly Region[], shown: Region, locale: string) =>
  `<nav aria-label="${escapeHtml(translate(locale, 'nav.panes'))}">${regions
    .map((region) => button(PANE_ATTRIBUTE, region, translate(locale, `region.${region}`), region === shown))
    .join('')}</nav>`;

const motionControl = (current: string, locale: string): string =>
  `<fieldset data-motion-control><legend>${escapeHtml(translate(locale, 'motion.label'))}</legend>${MOTION_SETTINGS.map(
    (setting) =>
      `<button type="button" data-motion="${setting}" aria-pressed="${setting === current}">${escapeHtml(translate(locale, `motion.${setting}`))}</button>`,
  ).join('')}</fieldset>`;

export const LOCALE_ATTRIBUTE = 'data-locale';
export const STORY_LANGUAGE_ATTRIBUTE = 'data-story-language';

const languageControl = (current: string): string =>
  `<fieldset data-language-control><legend>${escapeHtml(translate(current, 'language.label'))}</legend>${SUPPORTED_LOCALES.map(
    (locale) =>
      `<button type="button" ${LOCALE_ATTRIBUTE}="${locale}" lang="${locale}" aria-pressed="${locale === current}">${escapeHtml(endonym(locale))}</button>`,
  ).join('')}</fieldset>`;

const storyLanguageControl = (current: string | undefined, locale: string): string =>
  `<fieldset data-story-language-control><legend>${escapeHtml(translate(locale, 'storyLanguage.label'))}</legend>${SUPPORTED_LOCALES.map(
    (language) =>
      `<button type="button" ${STORY_LANGUAGE_ATTRIBUTE}="${language}" lang="${language}" aria-pressed="${language === current}">${escapeHtml(endonym(language))}</button>`,
  ).join('')}</fieldset>`;

const mainOpen = (model: ViewModel, screen: 'home' | 'play') =>
  `<main data-screen="${screen}" data-layout="${model.layout.name}" data-animate="${model.animate}" data-motion-mode="${model.motion}">`;

const renderHome = (model: ViewModel, locale: string) =>
  `${mainOpen(model, 'home')}${pane(STATUS, locale, REGION_BODIES.status(model, locale), false)}${renderStart(model, locale)}${pane('campaigns', locale, REGION_BODIES.campaigns(model, locale), false)}</main>`;

const playHeader = (
  model: ViewModel,
  locale: string,
  voice: DesktopVoiceView | undefined,
  setup: VoiceSetupView | undefined,
) =>
  pane(
    STATUS,
    locale,
    `${homeNav(locale)}${header(model, locale)}${connection(model, locale)}${voice !== undefined && voice.preferences.spokenOutput !== 'off' ? playbackControls(locale) : ''}${settingsMenu(model, locale, voice, setup)}`,
    false,
  );

const renderPlay = (
  model: ViewModel,
  locale: string,
  shown: Region,
  voice: DesktopVoiceView | undefined,
  setup: VoiceSetupView | undefined,
) => {
  const [single, ...rest] = model.layout.columns;
  const tabbed = single !== undefined && rest.length === 0;
  return `${mainOpen(model, 'play')}${playHeader(model, locale, voice, setup)}${renderSetup(setup, locale)}${renderStart(model, locale)}${tabbed ? paneSwitcher(single, shown, locale) : ''}<div data-columns>${model.layout.columns
    .map(
      (column) =>
        `<div>${column.map((region) => pane(region, locale, REGION_BODIES[region](model, locale), tabbed && region !== shown)).join('')}</div>`,
    )
    .join('')}</div>${rejectedAlert(model, locale)}</main>`;
};

export const renderView = (
  model: ViewModel,
  locale: string,
  shown: Region = DEFAULT_PANE,
  voice?: DesktopVoiceView,
  setup?: VoiceSetupView,
): string =>
  `${model.playing ? renderPlay(model, locale, shown, voice, setup) : renderHome(model, locale)}${voice === undefined ? '' : renderVoice(voice, locale)}`;

export const keyName = (event: KeyEventLike) =>
  [
    ...MODIFIERS.filter(([flag]) => event[flag]).map(([, name]) => name),
    PHYSICAL_KEY.exec(event.code ?? '')?.[1] ?? event.key,
  ].join(KEY_SEPARATOR);

export const KEEP_DEFAULT = Symbol('keep default');

export const bindKeys = (
  target: KeyTarget,
  preferences: () => UiPreferences,
  run: (action: RendererAction, event: KeyEventLike) => unknown,
) =>
  target.addEventListener(KEYDOWN, (event) => {
    const action = actionForKey(keyName(event), preferences());
    if (action === undefined) return;
    if (run(action, event) !== KEEP_DEFAULT) event.preventDefault();
  });

export const queryPreferences = (search: string) =>
  readPreferences(() => JSON.parse(new URLSearchParams(search).get(PREFERENCES_QUERY) ?? ''));

export const queryStart = (search: string) => loadStartDraft(() => new URLSearchParams(search).get(START_QUERY) ?? '');
