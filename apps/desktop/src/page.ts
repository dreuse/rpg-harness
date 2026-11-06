import type { StartVoices } from '../../../packages/client-protocol/src/guided-start.ts';
import type { CampaignSnapshot } from '../../../packages/client-protocol/src/protocol.ts';
import {
  matchSlash,
  resolveSlash,
  SLASH_PREFIX,
  type SlashClient,
  type SlashOption,
  slashText,
} from '../../../packages/client-protocol/src/slash-commands.ts';
import { storyFacts, storyMemoryText } from '../../../packages/client-protocol/src/story-memory-text.ts';
import { MOTION_SETTINGS } from '../../../packages/client-protocol/src/visualization.ts';
import { DUCK_RELEASE_MS } from '../../../packages/voice/src/ducking-sink.ts';
import { voiceLocaleFor } from '../../../packages/voice/src/language-voices.ts';
import { createMicrophoneController } from '../../../packages/voice/src/microphone.ts';
import type { PlaybackControl } from '../../../packages/voice/src/playback-controls.ts';
import { type ChannelSetting, isVolume, SOUND_CHANNELS } from '../../../packages/voice/src/sound-settings.ts';
import { createSubtitleTranscript } from '../../../packages/voice/src/subtitles.ts';
import { keepsDelivery } from '../../../packages/voice/src/tts.ts';
import { type RendererAction, SUPPORTED_LOCALES, translate } from './accessibility.ts';
import { ROLL_COLLAPSE_MS, SETTLE_MS } from './dice.ts';
import { BRIDGE_KEY, type Bridge } from './preload.ts';
import { createDesktopClient, type DesktopState, REGIONS, type Region, type Transport, viewModel } from './renderer.ts';
import { createDesktopSound, type DesktopSound, sceneSoundInput } from './sound-player.ts';
import { createSoundSetup } from './sound-setup.ts';
import {
  ALLOW,
  bindKeys,
  CHARACTER_PREVIEW,
  cssEscape,
  DECLINE,
  GM_DEFAULTS_FORM,
  GM_FORM,
  HOME_ATTRIBUTE,
  HOME_NAME,
  HOME_SEARCH,
  homeActionId,
  IMPORT_ACTIONS,
  type ImportAction,
  KEEP_DEFAULT,
  type KeyEventLike,
  type KeyTarget,
  LOCALE_ATTRIBUTE,
  MEMORY_ATTRIBUTE,
  MEMORY_INDEX,
  MEMORY_PANEL,
  NAV_ATTRIBUTE,
  OOC_ATTRIBUTE,
  OOC_EXCHANGE,
  OOC_INDEX,
  PANE_ATTRIBUTE,
  queryPreferences,
  queryStart,
  RENAME_INPUT_ID,
  REPLAY,
  RETRY_TURN_ATTRIBUTE,
  ROLL_OFFER_ATTRIBUTE,
  ROLL_REPORT_FORM,
  ROLL_REPORT_INPUT,
  renderView,
  SETTINGS_PANEL,
  SETTINGS_TOGGLE,
  SHEET_ACTION,
  SHEET_FORM,
  SHEET_INPUT,
  SLASH_OPTION_ATTRIBUTE,
  SLASH_OPTION_ID,
  SOUND_FIELD_TOGGLE,
  SOUND_FIELD_VOLUME,
  SOUND_SETUP,
  START_CONTROL,
  START_CONTROLS,
  START_EDIT,
  START_ENTRY,
  START_FORM,
  START_IMPORT,
  START_OPEN,
  START_OPTION,
  START_PREVIEW,
  START_TITLE,
  START_VOICE,
  STORY_LANGUAGE_ATTRIBUTE,
  type StartControl,
  slashMenuHtml,
  syncRangeReadout,
  VOICE_ATTRIBUTE,
  VOICE_CLEAR,
  VOICE_FIELD,
  VOICE_NPC,
  VOICE_NPC_NAME,
  VOICE_NPC_PREVIEW,
  VOICE_NPC_REMOVE,
  VOICE_NPC_SPEAKER,
  VOICE_NPC_VOICE,
  VOICE_PLAYBACK,
  VOICE_PREVIEW,
  VOICE_REMOVE,
  VOICE_SETUP,
} from './view.ts';
import {
  browserMicrophone,
  createDesktopVoice,
  type DesktopVoiceOptions,
  MICROPHONE_OFF,
  type OutputChange,
} from './voice.ts';
import { createReplay } from './voice-replay.ts';
import {
  type AudioOut,
  browserAudio,
  createVoiceSetup,
  MAX_SPEECH_CHARS,
  type SpeechPreferences,
  splitSpeech,
  type VoiceBridge,
} from './voice-setup.ts';

export const FONT_SCALE_PROPERTY = '--font-scale';
export const ROOT_ID = 'app';
export const FORM_ID = 'action-form';
export const INPUT_ID = 'action-input';
export const OOC_TOGGLE_ID = 'ooc-toggle';
export const MEMORY_TOGGLE_ID = 'memory-toggle';
export const SLASH_MENU_ID = 'slash-menu';
export const SLASH_STATUS_ID = 'slash-status';
export const SLASH_HINT_ID = 'slash-hint';

const SLASH_CLIENT: SlashClient = 'desktop';
const NO_OPTION = -1;
const ARIA_EXPANDED = 'aria-expanded';
const ARIA_ACTIVE = 'aria-activedescendant';
const OPTION_STEP = 1;
const OPTION_SELECTOR = `[${SLASH_OPTION_ATTRIBUTE}]`;
const KEY_DOWN = 'ArrowDown';
const KEY_UP = 'ArrowUp';
const KEY_TAB = 'Tab';
const KEY_ENTER = 'Enter';
const KEY_ESCAPE = 'Escape';
const CLICK = 'click';
const MOUSEDOWN = 'mousedown';
const BLUR = 'blur';
const KEYDOWN = 'keydown';
const TOGGLE = 'toggle';
const SUBMIT = 'submit';
const RESIZE = 'resize';
const INPUT = 'input';
const RANGE_SELECTOR = '[data-range-format]';
const CHANGE = 'change';
const OUTPUT_FIELDS = ['spokenOutput', 'locale', 'speed'];
const NO_DURATION_MS = 0;
const NARRATOR_FIELD = 'narratorVoice';
const SPEECH_FIELDS = ['providerId', 'narratorVoice', 'volume'];
const NUMBER_FIELDS = ['speed', 'volume'];
const RETRY_SELECTOR = '[data-action="retry"]';
const TABINDEX = 'tabindex';
const PROGRAMMATIC_FOCUS = '-1';
const NO_CAMPAIGN = '';
const NO_VOICE_BRIDGE = 'voice bridge is unavailable';
const FIRST_TURN = 0;
const START_REGION = '[data-region="start"]';
const ENTRY_SELECTOR = `#${START_ENTRY}`;
const TITLE_SELECTOR = `[${START_TITLE}]`;
const OPEN_SELECTOR = `[${START_OPEN}]`;
const FOCUSED_SELECTOR = ':focus';
const TEXT_FIELD_SELECTOR = 'input, textarea, select';
const ROLL_OFFER_SELECTOR = `[${ROLL_OFFER_ATTRIBUTE}]`;
const STEP_INDEX = /^\d+$/;
const ARCHIVED_SELECTOR = '[data-archived]';
const SETTINGS_SELECTOR = '[data-settings]';
const OPEN_SETTINGS_SELECTOR = 'details[data-settings][open]';
const SETTINGS_TOGGLE_ATTRIBUTE = `[${SETTINGS_TOGGLE}]`;
const SETTINGS_PANEL_SELECTOR = `[${SETTINGS_PANEL}]`;
const DISCLOSURE_SELECTORS = [
  '[data-diagnostics]',
  ARCHIVED_SELECTOR,
  SETTINGS_SELECTOR,
  '[data-voice-troubleshooting]',
];
const HOME_REGION = '[data-region="campaigns"]';
const KEEP_ENTER_REGIONS = [START_REGION, HOME_REGION, '[data-region="status"]', '[data-region="sheet"]'];
const SHEET_INPUT_SELECTOR = `#${SHEET_INPUT}`;
const EMPTY_MEMORY = { person: [], place: [], thread: [] };
const MEMORY_FORM_SELECTOR = `[${MEMORY_ATTRIBUTE}="correct"]`;
const SHEET_FORM_SELECTOR = `[${SHEET_FORM}]`;
const ROLL_REPORT_FORM_SELECTOR = `[${ROLL_REPORT_FORM}]`;
const ROLL_REPORT_INPUT_SELECTOR = `#${ROLL_REPORT_INPUT}`;
const GM_FORM_SELECTOR = `[${GM_FORM}]`;
const GM_DEFAULTS_FORM_SELECTOR = `[${GM_DEFAULTS_FORM}]`;
const GM_FORM_SELECTORS = [GM_FORM_SELECTOR, GM_DEFAULTS_FORM_SELECTOR];
const GM_FIELDS = ['model', 'summaryModel', 'sessionBudgetTokens', 'rulesStrictness', 'whoRolls'] as const;
const GM_BUDGET_FIELD = 'sessionBudgetTokens';
const SHEET_FIRST_INPUT = `${SHEET_FORM_SELECTOR} input`;
const SHEET_EDIT_SELECTOR = '#sheet-edit';
const HEADING_SELECTOR = '#heading-status';
const FIRST_CONTINUE_SELECTOR = '#home-continue-0';
const OPEN_MENU_SELECTOR = 'details[open]';
const SETTINGS_TOGGLE_SELECTOR = '#settings-toggle';
const SETUP_STEP_ATTRIBUTE = 'data-voice-step';
const SETUP_DIALOG_SELECTOR = `[${SETUP_STEP_ATTRIBUTE}]`;
const SETUP_PRIMARY_SELECTOR = `${SETUP_DIALOG_SELECTOR} [data-primary]`;
const SETUP_CLOSED = 'closed';
const SOUND_ACCEPT_SELECTOR = '[data-sound-setup="accept"]';
const SOUND_DOWNLOAD_SELECTOR = '[data-sound-setup="download"]';
const SOUND_STATUS_SELECTOR = '[data-sound] [role="status"]';
const SOUND_IDLE = 'idle';
const MENU_TOGGLE_SELECTOR = 'summary';
const RENAME_SELECTOR = `#${RENAME_INPUT_ID}`;
const SEARCH_SELECTOR = `#${HOME_SEARCH}`;
const CANCEL_SELECTOR = '#home-cancel';
const LOG_SELECTOR = '[data-region="conversation"] > ol';
const SKIP_SELECTOR = '[data-roll-skip]';
const ROLL_BADGE_ATTRIBUTE = 'data-roll-badge';
const ROLL_BADGE_SELECTOR = `[${ROLL_BADGE_ATTRIBUTE}]`;
const ROLLS_SELECTOR = '[data-rolls]';
const ROLLS_HELD_SELECTOR = '[data-rolls]:is(:hover, :focus-within)';
const MOTION_ATTRIBUTE = 'data-motion';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FOCUS_ATTRIBUTES = [
  ROLL_OFFER_ATTRIBUTE,
  START_TITLE,
  START_OPTION,
  START_CONTROL,
  START_IMPORT,
  START_OPEN,
  PANE_ATTRIBUTE,
  MOTION_ATTRIBUTE,
  VOICE_SETUP,
  VOICE_PREVIEW,
  SETUP_STEP_ATTRIBUTE,
  REPLAY,
  ROLL_BADGE_ATTRIBUTE,
];
const FOCUS_REGIONS: Partial<Record<RendererAction, Region>> = {
  focusConversation: 'conversation',
  focusSheet: 'sheet',
  focusPanels: 'panels',
};

type ClickTarget = { closest(selector: string): { getAttribute(name: string): string | null } | null };
export type PageElements = {
  readonly root: Pick<HTMLElement, 'innerHTML' | 'style' | 'addEventListener' | 'querySelector'>;
  readonly form: Pick<HTMLFormElement, 'addEventListener' | 'requestSubmit'>;
  readonly input: Pick<HTMLInputElement, 'value'> &
    Partial<
      Pick<HTMLInputElement, 'placeholder' | 'matches' | 'addEventListener' | 'setAttribute' | 'removeAttribute'>
    >;
  readonly slashMenu?: Pick<HTMLElement, 'innerHTML' | 'hidden' | 'addEventListener'>;
  readonly slashStatus?: Pick<HTMLElement, 'textContent'>;
  readonly slashHint?: Pick<HTMLElement, 'textContent'>;
  readonly oocToggle?: Pick<HTMLButtonElement, 'addEventListener' | 'setAttribute' | 'textContent'>;
  readonly memoryToggle?: Pick<HTMLButtonElement, 'addEventListener' | 'setAttribute' | 'textContent'>;
  readonly keys: KeyTarget;
};
export type PageOptions = {
  readonly elements: PageElements;
  readonly bridge: Transport &
    Partial<Pick<Bridge, 'saveStart' | 'savePreferences' | 'voice' | 'sound' | 'importRulebook'>>;
  readonly search: string;
  readonly width: () => number;
  readonly newActionId: () => string;
  readonly openMicrophone: DesktopVoiceOptions['openMicrophone'];
  readonly schedule?: (run: () => void, ms: number) => void;
  readonly prefersReducedMotion?: () => boolean;
  readonly audio?: AudioOut;
  readonly sound?: DesktopSound;
  readonly localize?: (locale: string) => void;
};

const systemReducedMotion = () => globalThis.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;

type Focusable = Pick<Element, 'id' | 'hasAttribute' | 'getAttribute'>;

const selectorOf = (element: Focusable | null) => {
  if (element === null) return undefined;
  if (element.id !== '') return `#${cssEscape(element.id)}`;
  const attribute = FOCUS_ATTRIBUTES.find((name) => element.hasAttribute(name));
  return attribute === undefined ? undefined : `[${attribute}="${element.getAttribute(attribute)}"]`;
};

const isRegion = (value: string | null | undefined): value is Region => REGIONS.some((region) => region === value);

const isImportAction = (value: string | null | undefined): value is ImportAction =>
  IMPORT_ACTIONS.some((action) => action === value);

const isStartControl = (value: string | null | undefined): value is StartControl =>
  START_CONTROLS.some((control) => control === value);

const closestTarget = (event: Event) => event.target as unknown as ClickTarget | null;

const playbackOf = (bridge: VoiceBridge): PlaybackControl => ({
  pause: () => void bridge.playback('pause'),
  resume: () => void bridge.playback('resume'),
  skip: () => void bridge.playback('skip'),
  stop: () => void bridge.playback('stop'),
});

const assignmentsOf = (speech: SpeechPreferences, campaignId: string | undefined, providerId: string | undefined) =>
  campaignId === undefined || providerId === undefined || !Object.hasOwn(speech.npcVoices, campaignId)
    ? {}
    : Object.fromEntries(
        Object.entries(speech.npcVoices[campaignId] ?? {}).map(([name, voiceId]) => [name, { providerId, voiceId }]),
      );

export const mountPage = ({
  elements: { root, form, input, oocToggle, memoryToggle, keys, slashMenu, slashStatus, slashHint },
  bridge,
  search,
  width,
  newActionId,
  openMicrophone,
  schedule = setTimeout,
  prefersReducedMotion = systemReducedMotion,
  audio = browserAudio(() => new AudioContext()),
  sound = bridge.sound === undefined ? undefined : createDesktopSound({ bridge: bridge.sound }),
  localize = () => {},
}: PageOptions) => {
  let saved = queryPreferences(search);
  const withSystem = () => ({ ...saved, reducedMotion: saved.reducedMotion || prefersReducedMotion() });
  let preferences = withSystem();
  const client = createDesktopClient({
    transport: bridge,
    newActionId,
    startDraft: queryStart(search),
    saveStart: (draft) => bridge.saveStart?.(draft),
    locale: () => preferences.locale,
    voices: () => startVoices(),
    importRulebook: bridge.importRulebook,
  });
  const { consent, ...voicePreferences } = preferences.voice;
  const voice = createDesktopVoice({
    session: { campaignId: NO_CAMPAIGN, turn: FIRST_TURN, pendingInput: [], preferences: voicePreferences },
    providerIds: consent.granted ? consent.providerIds : [],
    supportedLocales: SUPPORTED_LOCALES,
    subtitles: createSubtitleTranscript(),
    openMicrophone,
    submit: client.submit,
    save: client.saveVoice,
    ...(bridge.voice === undefined ? {} : { playback: playbackOf(bridge.voice) }),
  });
  let previewing = false;
  let previewRun = 0;
  const syncSpeaking = () => sound?.speaking(previewing || voice.view().subtitle !== undefined);
  const speechAudio: AudioOut = {
    play: async (chunks, volume) => {
      const played = await audio.play(chunks, volume);
      const run = ++previewRun;
      previewing = true;
      syncSpeaking();
      schedule(
        () => {
          if (run !== previewRun) return;
          previewing = false;
          syncSpeaking();
        },
        (played.durationMs ?? NO_DURATION_MS) + DUCK_RELEASE_MS,
      );
      return played;
    },
    stop: () => {
      audio.stop?.();
      previewRun += 1;
      previewing = false;
      syncSpeaking();
    },
  };
  const storyLanguage = () => {
    const { open, draft } = client.state().start;
    const draftLanguage = draft.choices.language;
    if (open && typeof draftLanguage === 'string') return draftLanguage;
    return client.state().snapshot?.language ?? voice.view().preferences.locale;
  };
  const setup = createVoiceSetup({
    ...(bridge.voice === undefined ? {} : { bridge: bridge.voice }),
    audio: speechAudio,
    speech: saved.speech,
    language: storyLanguage,
    campaign: () => client.state().snapshot?.campaignId,
    speakers: () => client.state().snapshot?.speakers?.map(({ name }) => name) ?? [],
    speed: () => voice.view().preferences.speed,
    saveSpeech: (speech: SpeechPreferences) => {
      saved = { ...saved, speech };
      voice.setNpcVoices(assignmentsOf(speech, client.state().snapshot?.campaignId, setup.view().provider?.id));
      bridge.savePreferences?.(saved);
      preferences = withSystem();
    },
    setOutput: (spokenOutput) => voice.change({ spokenOutput }),
    changed: () => render(),
  });
  const soundSetup =
    bridge.sound === undefined
      ? undefined
      : createSoundSetup({ bridge: bridge.sound, changed: () => render(), installed: () => void sound?.refresh() });
  const replay = createReplay({
    preview: (request) => bridge.voice?.preview(request) ?? Promise.reject(new Error(NO_VOICE_BRIDGE)),
    stopLive: () => void bridge.voice?.playback('stop'),
    audio: speechAudio,
    provider: () => setup.view().provider?.id,
    voiceOf: setup.voiceOf,
    language: storyLanguage,
    speed: () => voice.view().preferences.speed,
    volume: () => setup.view().speech.volume,
    wait: (ms) => new Promise((resolve) => schedule(resolve, ms)),
    changed: () => render(),
  });
  const replayTurn = (actionId: string) => {
    const snapshot = client.state().snapshot;
    const turn = snapshot?.turns.find((candidate) => candidate.actionId === actionId);
    if (turn === undefined) return;
    const segments = turn.segments?.length ? turn.segments : [{ text: turn.narration }];
    const nameOf = (speakerId?: string) => snapshot?.speakers?.find(({ id }) => id === speakerId)?.name ?? speakerId;
    void replay.toggle(
      actionId,
      segments.flatMap(({ speakerId, delivery, text }) => {
        const name = nameOf(speakerId);
        return splitSpeech(text, MAX_SPEECH_CHARS).map((piece) => ({
          text: piece,
          ...(name === undefined ? {} : { speakerId: name }),
          ...(delivery !== undefined && keepsDelivery(voice.view().preferences.spokenOutput) ? { delivery } : {}),
        }));
      }),
    );
  };
  const startVoices = (): StartVoices => {
    const { provider, narratorVoice } = setup.view();
    return { ids: provider?.voices ?? [], current: narratorVoice };
  };
  let loaded: CampaignSnapshot | undefined;
  let shownStep: string | undefined;
  let shownPane: Region | undefined;
  let shownPlaying = false;
  let shownVoiceStep = SETUP_CLOSED;
  let shownSoundStep = SOUND_IDLE;
  const entryValue = () => root.querySelector<HTMLInputElement>(ENTRY_SELECTOR)?.value;
  const gmFormInputs = (form: string) =>
    GM_FIELDS.map((name) => root.querySelector<HTMLInputElement>(`${form} [name="${name}"]`));
  const gmInputs = () => GM_FORM_SELECTORS.flatMap(gmFormInputs);
  const gmTypedIn = (form: string) => {
    const fields = gmFormInputs(form);
    const entries = GM_FIELDS.flatMap((name, index) => {
      const typed = fields[index]?.value?.trim() ?? '';
      if (typed === '') return [];
      return [[name, name === GM_BUDGET_FIELD ? Number(typed) : typed] as const];
    });
    return Object.fromEntries(entries);
  };
  let focusRollsOnRender = false;
  let shownOfferId: string | undefined;
  const render = () => {
    const model = viewModel(client.state(), width(), preferences, undefined, startVoices());
    const focusedElement = root.querySelector<HTMLElement>(FOCUSED_SELECTOR);
    const focused = selectorOf(focusedElement);
    const typingInField =
      (focusedElement?.matches?.(TEXT_FIELD_SELECTOR) === true && (focusedElement as HTMLInputElement).value !== '') ||
      (input.matches?.(FOCUSED_SELECTOR) === true && input.value !== '');
    const offerAppeared = model.rollOffer !== undefined && model.rollOffer.offerId !== shownOfferId;
    shownOfferId = model.rollOffer?.offerId;
    const typed = entryValue();
    const sheetTyped = sheetInputs().map((field) => ({ field, value: field?.value, checked: field?.checked }));
    const memoryInputs = () =>
      storyFacts(client.state().memory.view?.memory ?? EMPTY_MEMORY).map((_, index) =>
        root.querySelector<HTMLInputElement>(`#${MEMORY_PANEL}-value-${index}`),
      );
    const memoryTyped = memoryInputs().map((field) => field?.value);
    const gmTyped = gmInputs().map((field) => (field?.value === field?.defaultValue ? undefined : field?.value));
    const caret = root.querySelector<HTMLInputElement>(ENTRY_SELECTOR);
    const selection = { start: caret?.selectionStart ?? null, end: caret?.selectionEnd ?? null };
    const opened = DISCLOSURE_SELECTORS.map(
      (selector) => root.querySelector<HTMLDetailsElement>(selector)?.open === true,
    );
    localize(preferences.locale);
    const talking = client.state().ooc.active;
    oocToggle?.setAttribute('aria-pressed', String(talking));
    if (oocToggle !== undefined) oocToggle.textContent = translate(preferences.locale, 'ooc.toggle');
    memoryToggle?.setAttribute('aria-pressed', String(client.state().memory.open));
    if (memoryToggle !== undefined) memoryToggle.textContent = storyMemoryText(preferences.locale, 'memory.heading');
    input.placeholder = translate(preferences.locale, talking ? 'ooc.placeholder' : 'action.placeholder');
    sound?.update(
      preferences.sound,
      model.playing ? sceneSoundInput(model.scene?.title, model.scene) : undefined,
      model.playing ? model.scene?.id : undefined,
    );
    syncSpeaking();
    const setupView = setup.view();
    const available = voice.view().preferences.spokenOutput !== 'off' && setupView.provider?.installed === true;
    root.innerHTML = renderView(
      {
        ...model,
        ...(soundSetup === undefined ? {} : { soundSetup: soundSetup.view() }),
        replay: { available, playing: replay.playing() },
      },
      preferences.locale,
      shownPane,
      voice.view(),
      setupView,
    );
    root.style.setProperty(FONT_SCALE_PROPERTY, String(model.fontScale));
    DISCLOSURE_SELECTORS.forEach((selector, index) => {
      const details = root.querySelector<HTMLDetailsElement>(selector);
      if (details !== null) details.open = opened[index] === true;
    });
    const log = root.querySelector<HTMLElement>(LOG_SELECTOR);
    if (log !== null) log.scrollTop = log.scrollHeight;
    if (model.playing !== shownPlaying) {
      shownPlaying = model.playing;
      shownStep = model.start?.step;
      const home = () =>
        root.querySelector<HTMLElement>(FIRST_CONTINUE_SELECTOR) ?? root.querySelector<HTMLElement>(OPEN_SELECTOR);
      return (model.playing ? root.querySelector<HTMLElement>(HEADING_SELECTOR) : home())?.focus();
    }
    if (model.start?.step !== shownStep) {
      shownStep = model.start?.step;
      return root.querySelector<HTMLElement>(shownStep === undefined ? OPEN_SELECTOR : TITLE_SELECTOR)?.focus();
    }
    if (setupView.step !== shownVoiceStep) {
      shownVoiceStep = setupView.step;
      if (shownVoiceStep === SETUP_CLOSED) return root.querySelector<HTMLElement>(SETTINGS_TOGGLE_SELECTOR)?.focus();
      return (
        root.querySelector<HTMLElement>(SETUP_PRIMARY_SELECTOR) ??
        root.querySelector<HTMLElement>(SETUP_DIALOG_SELECTOR)
      )?.focus();
    }
    const soundStep = soundSetup?.view().step ?? SOUND_IDLE;
    let soundFocus: HTMLElement | null = null;
    if (soundStep !== shownSoundStep) {
      shownSoundStep = soundStep;
      soundFocus =
        root.querySelector<HTMLElement>(soundStep === 'consent' ? SOUND_ACCEPT_SELECTOR : SOUND_DOWNLOAD_SELECTOR) ??
        root.querySelector<HTMLElement>(SOUND_STATUS_SELECTOR);
    }
    const entry = root.querySelector<HTMLInputElement>(ENTRY_SELECTOR);
    if (entry !== null && typed !== undefined) entry.value = typed;
    sheetInputs().forEach((field, index) => {
      const kept = sheetTyped[index];
      if (field === null || !kept?.field) return;
      if (kept.value !== undefined) field.value = kept.value;
      if (kept.checked !== undefined) field.checked = kept.checked;
    });
    gmInputs().forEach((field, index) => {
      const kept = gmTyped[index];
      if (field !== null && kept !== undefined) field.value = kept;
    });
    memoryInputs().forEach((field, index) => {
      const kept = memoryTyped[index];
      if (field !== null && kept !== undefined && kept !== '') field.value = kept;
    });
    if (focusRollsOnRender) {
      focusRollsOnRender = false;
      return root.querySelector<HTMLElement>(ROLLS_SELECTOR)?.focus();
    }
    if (offerAppeared && !typingInField) return root.querySelector<HTMLElement>(ROLL_OFFER_SELECTOR)?.focus();
    const typing = focused === ENTRY_SELECTOR || focused === SEARCH_SELECTOR;
    if (soundFocus !== null && !typing) soundFocus.focus();
    else if (focused !== undefined) root.querySelector<HTMLElement>(focused)?.focus();
    if (focused === ENTRY_SELECTOR && selection.start !== null && selection.end !== null)
      entry?.setSelectionRange?.(selection.start, selection.end);
    const search = focused === SEARCH_SELECTOR ? root.querySelector<HTMLInputElement>(SEARCH_SELECTOR) : null;
    search?.setSelectionRange?.(search.value.length, search.value.length);
  };
  const keepName = () => {
    const entry = entryValue();
    const screen = client.startScreen();
    if (screen.step === 'summary' && entry !== undefined && entry !== screen.entry?.value)
      client.startAction({ kind: 'enter', text: entry });
  };
  const startControl = (control: StartControl) => {
    if (control === 'close') return client.closeStart();
    keepName();
    client.startAction({ kind: control });
  };
  const importRulebook = (action: ImportAction) =>
    void (action === 'pick'
      ? client.importRulebook()
      : action === 'pickOwn'
        ? client.importOwnRules()
        : client.decideImport(action));
  const startEdit = (step: string) => {
    if (!STEP_INDEX.test(step)) return;
    keepName();
    client.startAction({ kind: 'edit', step: Number(step) });
  };
  const startOption = (index: string) => {
    const option = client.startScreen().options[Number(index)];
    if (option === undefined) return;
    const step = shownStep;
    const { action } = option;
    if (action.kind === 'set' && action.field === NARRATOR_FIELD && typeof action.value === 'string')
      setup.update({ narratorVoice: action.value });
    client.startAction(action);
    if (shownStep === step) root.querySelector<HTMLElement>(`[${START_OPTION}="${index}"]`)?.focus();
  };
  const startPreview = (index: string) => {
    const preview = client.startScreen().options[Number(index)]?.preview;
    if (preview?.kind === 'preview') void setup.previewVoice(preview.voice);
  };
  const editableFields = () =>
    client.state().sheetEditing
      ? (client.state().views.sheet?.components ?? []).filter(({ editable }) => editable === true)
      : [];
  const sheetInputs = () =>
    editableFields().map(({ id }) => root.querySelector<HTMLInputElement>(`${SHEET_INPUT_SELECTOR}${cssEscape(id)}`));
  const leaveSheetEdit = () => {
    if (!client.state().sheetEditing) root.querySelector<HTMLElement>(SHEET_EDIT_SELECTOR)?.focus();
  };
  const saveSheet = () => {
    const values = Object.fromEntries(
      editableFields().flatMap(({ id, value }) => {
        const field = root.querySelector<HTMLInputElement>(`${SHEET_INPUT_SELECTOR}${cssEscape(id)}`);
        if (field === null) return [];
        return [[id, typeof value === 'boolean' ? field.checked : field.value]];
      }),
    );
    client.saveSheet(values, preferences.locale);
    leaveSheetEdit();
  };
  const sheetAction = (action: string | null) => {
    if (action === 'edit') {
      client.openSheetEdit();
      return root.querySelector<HTMLElement>(SHEET_FIRST_INPUT)?.focus();
    }
    if (action !== 'cancel') return;
    client.cancelSheetEdit();
    leaveSheetEdit();
  };
  const continueCampaign = (name: string) => {
    shownPane = undefined;
    client.continueCampaign(name);
  };
  const nextCampaign = () => {
    const { campaigns, selected } = client.state();
    const playable = campaigns.filter(({ id, health }) => id !== null && health === 'ok');
    const next = playable[(playable.findIndex(({ id }) => id === selected) + 1) % playable.length];
    if (next !== undefined) continueCampaign(next.name);
  };
  const renameFromInput = (name: string) => {
    const newName = root.querySelector<HTMLInputElement>(RENAME_SELECTOR)?.value.trim() ?? '';
    client.cancelHome();
    if (newName !== '' && newName !== name) client.rename(name, newName);
  };
  const confirmHome = () => {
    const { home, campaigns, archived: archivedCampaigns } = client.state();
    const { confirm } = home;
    if (confirm?.kind === 'rename') return renameFromInput(confirm.name);
    client.confirmHome();
    if (confirm?.kind !== 'delete') return;
    const listed = confirm.archived === true ? archivedCampaigns : campaigns;
    const id = listed.find(({ name }) => name === confirm.name)?.id;
    if (id) setup.forgetCampaign(id);
  };
  const homeAction = (action: string | null, name: string | null, archived: boolean) => {
    if (action === 'confirm') return confirmHome();
    if (action === 'cancel') return cancelHome();
    if (action === 'undo') return client.undoArchive();
    if (name === null) return;
    if (action === 'continue') return continueCampaign(name);
    if (action === 'unarchive') return client.unarchive(name);
    if (action !== 'rename' && action !== 'archive' && action !== 'delete') return;
    client.askHome(action, name, archived);
    root.querySelector<HTMLElement>(action === 'rename' ? RENAME_SELECTOR : CANCEL_SELECTOR)?.focus();
  };
  const oocAction = (action: string | null, exchange: string | null, index: string | null) => {
    if (action === 'undo') return client.undoOoc();
    if (exchange === null || index === null) return;
    if (action === 'confirm') client.confirmOoc(exchange, Number(index));
    if (action === 'decline') client.declineOoc(exchange, Number(index));
  };
  const cancelHome = () => {
    const asked = client.state().home.confirm;
    client.cancelHome();
    if (asked === undefined) return;
    const { home } = viewModel(client.state(), width(), preferences);
    const archived = asked.archived === true;
    const index = (archived ? home.archived : home.cards).findIndex(({ name }) => name === asked.name);
    if (index >= 0) root.querySelector<HTMLElement>(`#${homeActionId('more', index, archived)}`)?.focus();
  };
  let focusPanelOnToggle = false;
  const closeMenu = (target: ClickTarget | undefined) => {
    const menu = (target?.closest(OPEN_SETTINGS_SELECTOR) ?? target?.closest(OPEN_MENU_SELECTOR)) as unknown as
      | HTMLDetailsElement
      | null
      | undefined;
    if (!menu) return KEEP_DEFAULT;
    menu.open = false;
    menu.querySelector<HTMLElement>(MENU_TOGGLE_SELECTOR)?.focus();
  };
  const showPane = (region: Region) => {
    shownPane = region;
    render();
  };
  const focusRegion = (region: Region) => {
    const section = root.querySelector<HTMLElement>(`[data-region="${region}"]`);
    if (section === null) return;
    showPane(region);
    section.setAttribute(TABINDEX, PROGRAMMATIC_FOCUS);
    section.focus();
  };
  const run = (action: RendererAction, event: KeyEventLike) => {
    const region = FOCUS_REGIONS[action];
    if (region !== undefined) return focusRegion(region);
    if (action === 'newAdventure') return client.openStart();
    const target = event.target as ClickTarget | undefined;
    if (action === 'closeMenu') replay.stop();
    if (action === 'closeMenu' && target?.closest(SHEET_FORM_SELECTOR)) return sheetAction('cancel');
    if (action === 'closeMenu') return closeMenu(target);
    if (
      action === 'submit' &&
      (client.state().selected === undefined || KEEP_ENTER_REGIONS.some((region) => target?.closest(region)))
    )
      return KEEP_DEFAULT;
    if (action === 'submit') return form.requestSubmit();
    if (action === 'retry') return client.retry();
    if (action === 'nextCampaign') return nextCampaign();
  };
  const setupActions: Readonly<Record<string, () => unknown>> = {
    on: () => {
      const settings = root.querySelector<HTMLDetailsElement>(SETTINGS_SELECTOR);
      if (settings !== null) settings.open = false;
      return setup.turnOn();
    },
    off: setup.turnOff,
    accept: setup.accept,
    decline: setup.decline,
    finish: setup.finish,
  };
  const soundSetupActions: Record<string, (() => unknown) | undefined> = {
    download: soundSetup?.ask,
    accept: soundSetup?.accept,
    decline: soundSetup?.decline,
  };
  const fieldValue = (id: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value ?? '';
  const voiceClicks: readonly [string, (value: string) => unknown][] = [
    [VOICE_SETUP, (action) => setupActions[action]?.()],
    [SOUND_SETUP, (action) => soundSetupActions[action]?.()],
    [
      VOICE_PREVIEW,
      (value) => (value === CHARACTER_PREVIEW ? setup.previewVoice(fieldValue(VOICE_NPC_VOICE)) : setup.preview()),
    ],
    [VOICE_NPC_PREVIEW, setup.preview],
    [
      VOICE_NPC,
      () => setup.setNpcVoice(fieldValue(VOICE_NPC_SPEAKER) || fieldValue(VOICE_NPC_NAME), fieldValue(VOICE_NPC_VOICE)),
    ],
    [VOICE_NPC_REMOVE, setup.removeNpcVoice],
    [VOICE_REMOVE, setup.removeModel],
    [VOICE_CLEAR, setup.clearCache],
    [VOICE_PLAYBACK, voice.playback],
  ];
  const voiceClick = (target: ClickTarget | null) => {
    const value = (name: string) => target?.closest(`[${name}]`)?.getAttribute(name) ?? undefined;
    const found = voiceClicks.find(([name]) => value(name) !== undefined);
    if (found === undefined) return false;
    const [name, run] = found;
    void run(value(name) ?? '');
    return true;
  };
  const changeSound = (name: string, patch: Partial<ChannelSetting>) => {
    const channel = SOUND_CHANNELS.find((known) => known === name);
    if (channel === undefined || (patch.volume !== undefined && !isVolume(patch.volume))) return;
    const sound = { ...saved.sound, [channel]: { ...saved.sound[channel], ...patch } };
    saved = { ...saved, sound };
    bridge.savePreferences?.(saved);
    preferences = withSystem();
    render();
  };
  const voiceField = (field: string, raw: unknown) => {
    const value = NUMBER_FIELDS.includes(field) ? Number(raw) : String(raw);
    if (OUTPUT_FIELDS.includes(field)) {
      voice.change({ [field]: value } as OutputChange);
      return render();
    }
    if (SPEECH_FIELDS.includes(field)) setup.update({ [field]: value });
  };
  const defaultVoice = ({ language }: CampaignSnapshot) => ({
    ...voicePreferences,
    locale: language === undefined ? voicePreferences.locale : voiceLocaleFor(language, voicePreferences.locale),
    microphone: MICROPHONE_OFF,
  });
  const loadVoice = ({ snapshot }: DesktopState) => {
    if (snapshot === undefined || snapshot === loaded || client.voicePending()) return;
    loaded = snapshot;
    voice.load(snapshot.voice ?? defaultVoice(snapshot)).then(render);
  };
  let settling = false;
  const settleLater = ({ rolling, sheetChanged }: DesktopState) => {
    if (settling || (!rolling && sheetChanged.length === 0)) return;
    settling = true;
    const scheduled = client.state().rolls[0]?.resultId;
    schedule(() => {
      settling = false;
      if (client.state().rolls[0]?.resultId === scheduled) return client.settle();
      settleLater(client.state());
    }, SETTLE_MS);
  };
  let collapsing = false;
  const collapseLater = ({ rolls, rollsCollapsed }: DesktopState) => {
    if (collapsing || rollsCollapsed || rolls.length === 0) return;
    collapsing = true;
    const scheduled = rolls[0]?.resultId;
    schedule(() => {
      collapsing = false;
      const current = client.state();
      if (current.rolls[0]?.resultId === scheduled && root.querySelector(ROLLS_HELD_SELECTOR) === null)
        return client.collapseRolls();
      collapseLater(current);
    }, ROLL_COLLAPSE_MS);
  };
  let badgeSettling = false;
  const settleBadgeLater = ({ rollBadgeFresh }: DesktopState) => {
    if (badgeSettling || !rollBadgeFresh) return;
    badgeSettling = true;
    schedule(() => {
      badgeSettling = false;
      client.settleBadge();
    }, SETTLE_MS);
  };
  let observedRevision: number | undefined;
  const observeSpeech = ({ snapshot }: DesktopState) => {
    if (snapshot?.revision === observedRevision) return;
    observedRevision = snapshot?.revision;
    void setup.observe();
  };
  client.subscribe(loadVoice);
  client.subscribe(observeSpeech);
  client.subscribe(settleLater);
  client.subscribe(collapseLater);
  client.subscribe(settleBadgeLater);
  client.subscribe(render);
  root.addEventListener(
    TOGGLE,
    (event) => {
      const settings = event.target as unknown as HTMLDetailsElement;
      if (!focusPanelOnToggle || !settings.matches(SETTINGS_SELECTOR)) return;
      focusPanelOnToggle = false;
      if (settings.open) settings.querySelector<HTMLElement>(SETTINGS_PANEL_SELECTOR)?.focus();
    },
    true,
  );
  root.addEventListener(CLICK, (event) => {
    const target = closestTarget(event);
    if (target?.closest(SETTINGS_TOGGLE_ATTRIBUTE)) focusPanelOnToggle = true;
    const home = target?.closest(`[${HOME_ATTRIBUTE}]`);
    if (home)
      return homeAction(
        home.getAttribute(HOME_ATTRIBUTE),
        home.getAttribute(HOME_NAME),
        !!target?.closest(ARCHIVED_SELECTOR),
      );
    if (target?.closest(`[${NAV_ATTRIBUTE}]`)) {
      shownPane = undefined;
      return client.goHome();
    }
    const pane = target?.closest(`[${PANE_ATTRIBUTE}]`)?.getAttribute(PANE_ATTRIBUTE);
    if (isRegion(pane)) return showPane(pane);
    if (voiceClick(target)) return;
    const answer = target?.closest(`[${VOICE_ATTRIBUTE}]`)?.getAttribute(VOICE_ATTRIBUTE);
    if (answer === ALLOW) return void voice.allow().then(render);
    if (answer === DECLINE) return void voice.decline().then(render);
    if (target?.closest(`[${START_OPEN}]`)) return client.openStart();
    const importAction = target?.closest(`[${START_IMPORT}]`)?.getAttribute(START_IMPORT);
    if (isImportAction(importAction)) return importRulebook(importAction);
    const option = target?.closest(`[${START_OPTION}]`)?.getAttribute(START_OPTION);
    if (option !== undefined && option !== null) return startOption(option);
    const replayed = target?.closest(`[${REPLAY}]`)?.getAttribute(REPLAY);
    if (replayed !== undefined && replayed !== null) return replayTurn(replayed);
    const preview = target?.closest(`[${START_PREVIEW}]`)?.getAttribute(START_PREVIEW);
    if (preview !== undefined && preview !== null) return startPreview(preview);
    const edit = target?.closest(`[${START_EDIT}]`)?.getAttribute(START_EDIT);
    if (edit !== undefined && edit !== null) return startEdit(edit);
    const control = target?.closest(`[${START_CONTROL}]`)?.getAttribute(START_CONTROL);
    if (isStartControl(control)) return startControl(control);
    if (target?.closest(SKIP_SELECTOR)) return client.settle();
    if (target?.closest(ROLL_BADGE_SELECTOR)) {
      focusRollsOnRender = true;
      return client.reopenRolls();
    }
    const ooc = target?.closest(`[${OOC_ATTRIBUTE}]`);
    if (ooc)
      return oocAction(ooc.getAttribute(OOC_ATTRIBUTE), ooc.getAttribute(OOC_EXCHANGE), ooc.getAttribute(OOC_INDEX));
    if (target?.closest(`[${RETRY_TURN_ATTRIBUTE}]`)) return void client.retryNarration();
    if (target?.closest(`[${ROLL_OFFER_ATTRIBUTE}]`)) return void client.acceptRoll();
    const sheet = target?.closest(`[${SHEET_ACTION}]`);
    if (sheet) return sheetAction(sheet.getAttribute(SHEET_ACTION));
    const motion = MOTION_SETTINGS.find(
      (setting) => setting === target?.closest(`[${MOTION_ATTRIBUTE}]`)?.getAttribute(MOTION_ATTRIBUTE),
    );
    const locale = SUPPORTED_LOCALES.find(
      (supported) => supported === target?.closest(`[${LOCALE_ATTRIBUTE}]`)?.getAttribute(LOCALE_ATTRIBUTE),
    );
    const storyLanguage = SUPPORTED_LOCALES.find(
      (supported) =>
        supported === target?.closest(`[${STORY_LANGUAGE_ATTRIBUTE}]`)?.getAttribute(STORY_LANGUAGE_ATTRIBUTE),
    );
    if (storyLanguage !== undefined) return void client.setStoryLanguage(storyLanguage);
    const chosen = motion === undefined ? (locale === undefined ? undefined : { locale }) : { motion };
    if (chosen !== undefined) {
      saved = { ...saved, ...chosen };
      bridge.savePreferences?.(saved);
      preferences = withSystem();
      return render();
    }
    if (target?.closest(RETRY_SELECTOR)) client.retry();
  });
  root.addEventListener(INPUT, (event) => {
    const range = closestTarget(event)?.closest(RANGE_SELECTOR);
    if (range) syncRangeReadout(range as unknown as Parameters<typeof syncRangeReadout>[0]);
    const query = root.querySelector<HTMLInputElement>(SEARCH_SELECTOR)?.value;
    if (query !== undefined && query !== client.state().home.query) client.search(query);
  });
  root.addEventListener(CHANGE, (event) => {
    const soundTarget = closestTarget(event);
    const toggled = soundTarget?.closest(`[${SOUND_FIELD_TOGGLE}]`)?.getAttribute(SOUND_FIELD_TOGGLE);
    const sized = soundTarget?.closest(`[${SOUND_FIELD_VOLUME}]`)?.getAttribute(SOUND_FIELD_VOLUME);
    const { checked, value } = event.target as { checked?: unknown; value?: unknown };
    if (toggled !== undefined && toggled !== null) return changeSound(toggled, { enabled: checked === true });
    if (sized !== undefined && sized !== null) return changeSound(sized, { volume: Number(value) });
    if (closestTarget(event)?.closest(`[${START_VOICE}]`)) return startOption(String(value));
    const field = closestTarget(event)?.closest(`[${VOICE_FIELD}]`)?.getAttribute(VOICE_FIELD);
    if (field !== undefined && field !== null) voiceField(field, (event.target as { value?: unknown }).value);
  });
  root.addEventListener(SUBMIT, (event) => {
    if (closestTarget(event)?.closest(ROLL_REPORT_FORM_SELECTOR)) {
      event.preventDefault();
      const typed = root.querySelector<HTMLInputElement>(ROLL_REPORT_INPUT_SELECTOR)?.value?.trim() ?? '';
      if (typed !== '') client.reportRoll(Number(typed));
      return;
    }
    if (closestTarget(event)?.closest(GM_FORM_SELECTOR)) {
      event.preventDefault();
      return client.saveGm(gmTypedIn(GM_FORM_SELECTOR));
    }
    if (closestTarget(event)?.closest(GM_DEFAULTS_FORM_SELECTOR)) {
      event.preventDefault();
      return client.saveGmDefaults(gmTypedIn(GM_DEFAULTS_FORM_SELECTOR));
    }
    const memoryForm = closestTarget(event)?.closest(MEMORY_FORM_SELECTOR);
    if (memoryForm) {
      event.preventDefault();
      const index = memoryForm.getAttribute(MEMORY_INDEX);
      const typed = root.querySelector<HTMLInputElement>(`#${MEMORY_PANEL}-value-${index}`)?.value?.trim() ?? '';
      if (typed !== '') client.correctFact(Number(index), typed);
      return;
    }
    if (closestTarget(event)?.closest(SHEET_FORM_SELECTOR)) {
      event.preventDefault();
      return saveSheet();
    }
    if (!closestTarget(event)?.closest(`[${START_FORM}]`)) return;
    event.preventDefault();
    client.startAction({ kind: 'enter', text: entryValue() ?? '' });
  });
  let slashOptions: readonly SlashOption[] = [];
  let slashActive = NO_OPTION;
  const paintSlash = (typed = '') => {
    const open = slashOptions.length > 0;
    const { locale } = preferences;
    if (slashMenu !== undefined) {
      slashMenu.innerHTML = open ? slashMenuHtml(slashOptions, slashActive) : '';
      slashMenu.hidden = !open;
    }
    input.setAttribute?.(ARIA_EXPANDED, String(open));
    const active = slashOptions[slashActive];
    if (active === undefined) input.removeAttribute?.(ARIA_ACTIVE);
    else input.setAttribute?.(ARIA_ACTIVE, `${SLASH_OPTION_ID}${active.id}`);
    if (slashStatus === undefined) return;
    if (open) slashStatus.textContent = slashText(locale, 'slash.options', { count: slashOptions.length });
    else slashStatus.textContent = typed.startsWith(SLASH_PREFIX) ? slashText(locale, 'slash.none') : '';
  };
  const closeSlash = () => {
    slashOptions = [];
    slashActive = NO_OPTION;
    paintSlash();
  };
  const refreshSlash = () => {
    if (slashHint !== undefined) slashHint.textContent = '';
    slashOptions = client.state().ooc.active ? [] : matchSlash(preferences.locale, SLASH_CLIENT, input.value);
    slashActive = slashOptions.length > 0 ? 0 : NO_OPTION;
    paintSlash(input.value);
  };
  const completeSlash = (option: SlashOption | undefined) => {
    if (option === undefined) return;
    input.value = `${option.name} `;
    closeSlash();
  };
  const chooseSlash = (option: SlashOption | undefined) => {
    completeSlash(option);
    if (option?.args === '') form.requestSubmit();
  };
  const moveSlash = (step: number) => {
    slashActive = (slashActive + step + slashOptions.length) % slashOptions.length;
    paintSlash();
  };
  const SLASH_KEYS: Readonly<Record<string, () => void>> = {
    [KEY_DOWN]: () => moveSlash(OPTION_STEP),
    [KEY_UP]: () => moveSlash(-OPTION_STEP),
    [KEY_TAB]: () => completeSlash(slashOptions[slashActive]),
    [KEY_ENTER]: () => chooseSlash(slashOptions[slashActive]),
    [KEY_ESCAPE]: closeSlash,
  };
  if (input.addEventListener !== undefined && slashMenu !== undefined) {
    input.addEventListener(INPUT, refreshSlash);
    input.addEventListener(BLUR, closeSlash);
    input.addEventListener(KEYDOWN, (event) => {
      const handle = slashOptions.length === 0 ? undefined : SLASH_KEYS[event.key];
      if (handle === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      handle();
    });
    slashMenu.addEventListener(MOUSEDOWN, (event) => event.preventDefault());
    slashMenu.addEventListener(CLICK, (event) => {
      const id = closestTarget(event)?.closest(OPTION_SELECTOR)?.getAttribute(SLASH_OPTION_ATTRIBUTE);
      const option = slashOptions.find((candidate) => candidate.id === id);
      chooseSlash(option);
    });
  }
  form.addEventListener(SUBMIT, (event) => {
    event.preventDefault();
    if (input.value.trim() === '') return;
    if (client.state().ooc.active) {
      if (client.submit(input.value).ok) input.value = '';
      return render();
    }
    const slash = resolveSlash(preferences.locale, SLASH_CLIENT, input.value);
    if (slash.kind === 'unknown') {
      if (slashHint !== undefined)
        slashHint.textContent = slashText(preferences.locale, 'slash.unknown', { name: slash.name });
      return closeSlash();
    }
    closeSlash();
    const typed = slash.kind === 'command' ? `${SLASH_PREFIX}${slash.id} ${slash.args}`.trim() : input.value;
    voice.say(typed).then((route) => {
      if (route.kind !== 'action' || route.result.ok) input.value = '';
      render();
    });
  });
  oocToggle?.addEventListener('click', () => {
    client.toggleOoc();
    render();
  });
  memoryToggle?.addEventListener('click', () => {
    client.toggleMemory();
    render();
  });
  bindKeys(keys, () => preferences, run);
  render();
  voice.start().then(render);
  void setup.refresh();
  void soundSetup?.refresh();
  return { ...client, render };
};

const ACTION_LABEL_SELECTOR = `label[for="${INPUT_ID}"]`;
const ACTION_SEND_SELECTOR = `#${FORM_ID} button[type="submit"]`;

const localizeDocument = (locale: string) => {
  document.documentElement.lang = locale;
  const label = document.querySelector(ACTION_LABEL_SELECTOR);
  const send = document.querySelector(ACTION_SEND_SELECTOR);
  const input = document.getElementById(INPUT_ID) as HTMLInputElement | null;
  if (label !== null) label.textContent = translate(locale, 'action.label');
  if (send !== null) send.textContent = translate(locale, 'action.send');
  if (input !== null) input.placeholder = translate(locale, 'action.placeholder');
  document.getElementById(SLASH_MENU_ID)?.setAttribute('aria-label', slashText(locale, 'slash.list'));
};

const bridgeOf = (scope: object) => (scope as Record<string, PageOptions['bridge'] | undefined>)[BRIDGE_KEY];

const boot = () => {
  const bridge = bridgeOf(globalThis);
  if (bridge === undefined || typeof document === 'undefined') return;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const page = mountPage({
    elements: {
      root: byId(ROOT_ID),
      form: byId<HTMLFormElement>(FORM_ID),
      input: byId<HTMLInputElement>(INPUT_ID),
      oocToggle: byId<HTMLButtonElement>(OOC_TOGGLE_ID),
      memoryToggle: byId<HTMLButtonElement>(MEMORY_TOGGLE_ID),
      slashMenu: byId(SLASH_MENU_ID),
      slashStatus: byId(SLASH_STATUS_ID),
      slashHint: byId(SLASH_HINT_ID),
      keys: document,
    },
    bridge,
    search: location.search,
    width: () => window.innerWidth,
    newActionId: () => crypto.randomUUID(),
    openMicrophone: (settings) =>
      createMicrophoneController(browserMicrophone(navigator.mediaDevices, MediaRecorder), settings),
    localize: localizeDocument,
  });
  window.addEventListener(RESIZE, page.render);
};

boot();
