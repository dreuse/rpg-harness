import type { CampaignSnapshot } from '../../../packages/client-protocol/src/protocol.ts';
import { MOTION_SETTINGS } from '../../../packages/client-protocol/src/visualization.ts';
import { createMicrophoneController } from '../../../packages/voice/src/microphone.ts';
import { createSubtitleTranscript } from '../../../packages/voice/src/subtitles.ts';
import { type RendererAction, SUPPORTED_LOCALES } from './accessibility.ts';
import { SETTLE_MS } from './dice.ts';
import { BRIDGE_KEY, type Bridge } from './preload.ts';
import { createDesktopClient, type DesktopState, REGIONS, type Region, type Transport, viewModel } from './renderer.ts';
import {
  ALLOW,
  bindKeys,
  cssEscape,
  DECLINE,
  HOME_ATTRIBUTE,
  HOME_NAME,
  HOME_SEARCH,
  homeActionId,
  KEEP_DEFAULT,
  type KeyEventLike,
  type KeyTarget,
  NAV_ATTRIBUTE,
  PANE_ATTRIBUTE,
  queryPreferences,
  queryStart,
  renderView,
  SHEET_ACTION,
  SHEET_FORM,
  SHEET_INPUT,
  START_CONTROL,
  START_CONTROLS,
  START_EDIT,
  START_ENTRY,
  START_FORM,
  START_OPEN,
  START_OPTION,
  START_TITLE,
  type StartControl,
  VOICE_ATTRIBUTE,
} from './view.ts';
import { browserMicrophone, createDesktopVoice, type DesktopVoiceOptions, MICROPHONE_OFF } from './voice.ts';

export const FONT_SCALE_PROPERTY = '--font-scale';
export const ROOT_ID = 'app';
export const FORM_ID = 'action-form';
export const INPUT_ID = 'action-input';

const CLICK = 'click';
const SUBMIT = 'submit';
const RESIZE = 'resize';
const INPUT = 'input';
const RETRY_SELECTOR = '[data-action="retry"]';
const TABINDEX = 'tabindex';
const PROGRAMMATIC_FOCUS = '-1';
const NO_CAMPAIGN = '';
const FIRST_TURN = 0;
const START_REGION = '[data-region="start"]';
const ENTRY_SELECTOR = `#${START_ENTRY}`;
const TITLE_SELECTOR = `[${START_TITLE}]`;
const OPEN_SELECTOR = `[${START_OPEN}]`;
const FOCUSED_SELECTOR = ':focus';
const STEP_INDEX = /^\d+$/;
const ARCHIVED_SELECTOR = '[data-archived]';
const DISCLOSURE_SELECTORS = ['[data-diagnostics]', ARCHIVED_SELECTOR, '[data-settings]'];
const HOME_REGION = '[data-region="campaigns"]';
const KEEP_ENTER_REGIONS = [START_REGION, HOME_REGION, '[data-region="status"]', '[data-region="sheet"]'];
const SHEET_INPUT_SELECTOR = `#${SHEET_INPUT}`;
const SHEET_FORM_SELECTOR = `[${SHEET_FORM}]`;
const SHEET_FIRST_INPUT = `${SHEET_FORM_SELECTOR} input`;
const SHEET_EDIT_SELECTOR = '#sheet-edit';
const HEADING_SELECTOR = '#heading-status';
const FIRST_CONTINUE_SELECTOR = '#home-continue-0';
const OPEN_MENU_SELECTOR = 'details[open]';
const MENU_TOGGLE_SELECTOR = 'summary';
const SEARCH_SELECTOR = `#${HOME_SEARCH}`;
const CANCEL_SELECTOR = '#home-cancel';
const LOG_SELECTOR = '[data-region="conversation"] > ol';
const SKIP_SELECTOR = '[data-roll-skip]';
const MOTION_ATTRIBUTE = 'data-motion';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const FOCUS_ATTRIBUTES = [START_TITLE, START_OPTION, START_CONTROL, START_OPEN, PANE_ATTRIBUTE, MOTION_ATTRIBUTE];
const FOCUS_REGIONS: Partial<Record<RendererAction, Region>> = {
  focusConversation: 'conversation',
  focusSheet: 'sheet',
  focusPanels: 'panels',
};

type ClickTarget = { closest(selector: string): { getAttribute(name: string): string | null } | null };
export type PageElements = {
  readonly root: Pick<HTMLElement, 'innerHTML' | 'style' | 'addEventListener' | 'querySelector'>;
  readonly form: Pick<HTMLFormElement, 'addEventListener' | 'requestSubmit'>;
  readonly input: Pick<HTMLInputElement, 'value'>;
  readonly keys: KeyTarget;
};
export type PageOptions = {
  readonly elements: PageElements;
  readonly bridge: Transport & Partial<Pick<Bridge, 'saveStart' | 'savePreferences'>>;
  readonly search: string;
  readonly width: () => number;
  readonly newActionId: () => string;
  readonly openMicrophone: DesktopVoiceOptions['openMicrophone'];
  readonly schedule?: (run: () => void, ms: number) => void;
  readonly prefersReducedMotion?: () => boolean;
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

const isStartControl = (value: string | null | undefined): value is StartControl =>
  START_CONTROLS.some((control) => control === value);

const closestTarget = (event: Event) => event.target as unknown as ClickTarget | null;

export const mountPage = ({
  elements: { root, form, input, keys },
  bridge,
  search,
  width,
  newActionId,
  openMicrophone,
  schedule = setTimeout,
  prefersReducedMotion = systemReducedMotion,
}: PageOptions) => {
  let saved = queryPreferences(search);
  const withSystem = () => ({ ...saved, reducedMotion: saved.reducedMotion || prefersReducedMotion() });
  let preferences = withSystem();
  const client = createDesktopClient({
    transport: bridge,
    newActionId,
    startDraft: queryStart(search),
    saveStart: (draft) => bridge.saveStart?.(draft),
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
  });
  let loaded: CampaignSnapshot | undefined;
  let shownStep: string | undefined;
  let shownPane: Region | undefined;
  let shownPlaying = false;
  const entryValue = () => root.querySelector<HTMLInputElement>(ENTRY_SELECTOR)?.value;
  const render = () => {
    const model = viewModel(client.state(), width(), preferences);
    const focused = selectorOf(root.querySelector<HTMLElement>(FOCUSED_SELECTOR));
    const typed = entryValue();
    const sheetTyped = sheetInputs().map((field) => ({ field, value: field?.value, checked: field?.checked }));
    const caret = root.querySelector<HTMLInputElement>(ENTRY_SELECTOR);
    const selection = { start: caret?.selectionStart ?? null, end: caret?.selectionEnd ?? null };
    const opened = DISCLOSURE_SELECTORS.map(
      (selector) => root.querySelector<HTMLDetailsElement>(selector)?.open === true,
    );
    root.innerHTML = renderView(model, preferences.locale, shownPane, voice.view());
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
    const entry = root.querySelector<HTMLInputElement>(ENTRY_SELECTOR);
    if (entry !== null && typed !== undefined) entry.value = typed;
    sheetInputs().forEach((field, index) => {
      const kept = sheetTyped[index];
      if (field === null || !kept?.field) return;
      if (kept.value !== undefined) field.value = kept.value;
      if (kept.checked !== undefined) field.checked = kept.checked;
    });
    if (focused !== undefined) root.querySelector<HTMLElement>(focused)?.focus();
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
  const startEdit = (step: string) => {
    if (!STEP_INDEX.test(step)) return;
    keepName();
    client.startAction({ kind: 'edit', step: Number(step) });
  };
  const startOption = (index: string) => {
    const option = client.startScreen().options[Number(index)];
    if (option === undefined) return;
    const step = shownStep;
    client.startAction(option.action);
    if (shownStep === step) root.querySelector<HTMLElement>(`[${START_OPTION}="${index}"]`)?.focus();
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
  const homeAction = (action: string | null, name: string | null, archived: boolean) => {
    if (action === 'confirm') return client.confirmHome();
    if (action === 'cancel') return cancelHome();
    if (action === 'undo') return client.undoArchive();
    if (name === null) return;
    if (action === 'continue') return continueCampaign(name);
    if (action === 'unarchive') return client.unarchive(name);
    if (action !== 'archive' && action !== 'delete') return;
    client.askHome(action, name, archived);
    root.querySelector<HTMLElement>(CANCEL_SELECTOR)?.focus();
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
  const closeMenu = (target: ClickTarget | undefined) => {
    const menu = target?.closest(OPEN_MENU_SELECTOR) as unknown as HTMLDetailsElement | null | undefined;
    if (!menu) return KEEP_DEFAULT;
    menu.open = false;
    menu.querySelector<HTMLElement>(MENU_TOGGLE_SELECTOR)?.focus();
  };
  const showPane = (region: Region) => {
    shownPane = region;
    render();
  };
  const focusRegion = (region: Region) => {
    showPane(region);
    const section = root.querySelector<HTMLElement>(`[data-region="${region}"]`);
    section?.setAttribute(TABINDEX, PROGRAMMATIC_FOCUS);
    section?.focus();
  };
  const run = (action: RendererAction, event: KeyEventLike) => {
    const region = FOCUS_REGIONS[action];
    if (region !== undefined) return focusRegion(region);
    if (action === 'newAdventure') return client.openStart();
    const target = event.target as ClickTarget | undefined;
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
  const loadVoice = ({ snapshot }: DesktopState) => {
    if (snapshot === undefined || snapshot === loaded || client.voicePending()) return;
    loaded = snapshot;
    voice.load(snapshot.voice ?? { ...voicePreferences, microphone: MICROPHONE_OFF }).then(render);
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
  client.subscribe(loadVoice);
  client.subscribe(settleLater);
  client.subscribe(render);
  root.addEventListener(CLICK, (event) => {
    const target = closestTarget(event);
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
    const answer = target?.closest(`[${VOICE_ATTRIBUTE}]`)?.getAttribute(VOICE_ATTRIBUTE);
    if (answer === ALLOW) return void voice.allow().then(render);
    if (answer === DECLINE) return void voice.decline().then(render);
    if (target?.closest(`[${START_OPEN}]`)) return client.openStart();
    const option = target?.closest(`[${START_OPTION}]`)?.getAttribute(START_OPTION);
    if (option !== undefined && option !== null) return startOption(option);
    const edit = target?.closest(`[${START_EDIT}]`)?.getAttribute(START_EDIT);
    if (edit !== undefined && edit !== null) return startEdit(edit);
    const control = target?.closest(`[${START_CONTROL}]`)?.getAttribute(START_CONTROL);
    if (isStartControl(control)) return startControl(control);
    if (target?.closest(SKIP_SELECTOR)) return client.settle();
    const sheet = target?.closest(`[${SHEET_ACTION}]`);
    if (sheet) return sheetAction(sheet.getAttribute(SHEET_ACTION));
    const motion = MOTION_SETTINGS.find(
      (setting) => setting === target?.closest(`[${MOTION_ATTRIBUTE}]`)?.getAttribute(MOTION_ATTRIBUTE),
    );
    if (motion !== undefined) {
      saved = { ...saved, motion };
      bridge.savePreferences?.(saved);
      preferences = withSystem();
      return render();
    }
    if (target?.closest(RETRY_SELECTOR)) client.retry();
  });
  root.addEventListener(INPUT, () => {
    const query = root.querySelector<HTMLInputElement>(SEARCH_SELECTOR)?.value;
    if (query !== undefined && query !== client.state().home.query) client.search(query);
  });
  root.addEventListener(SUBMIT, (event) => {
    if (closestTarget(event)?.closest(SHEET_FORM_SELECTOR)) {
      event.preventDefault();
      return saveSheet();
    }
    if (!closestTarget(event)?.closest(`[${START_FORM}]`)) return;
    event.preventDefault();
    client.startAction({ kind: 'enter', text: entryValue() ?? '' });
  });
  form.addEventListener(SUBMIT, (event) => {
    event.preventDefault();
    if (input.value.trim() === '') return;
    voice.say(input.value).then((route) => {
      if (route.kind !== 'action' || route.result.ok) input.value = '';
      render();
    });
  });
  bindKeys(keys, () => preferences, run);
  render();
  voice.start().then(render);
  return { ...client, render };
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
      keys: document,
    },
    bridge,
    search: location.search,
    width: () => window.innerWidth,
    newActionId: () => crypto.randomUUID(),
    openMicrophone: (settings) =>
      createMicrophoneController(browserMicrophone(navigator.mediaDevices, MediaRecorder), settings),
  });
  window.addEventListener(RESIZE, page.render);
};

boot();
