import type { CampaignSnapshot } from '../../../packages/client-protocol/src/protocol.ts';
import { createMicrophoneController } from '../../../packages/voice/src/microphone.ts';
import { createSubtitleTranscript } from '../../../packages/voice/src/subtitles.ts';
import { type RendererAction, SUPPORTED_LOCALES } from './accessibility.ts';
import { BRIDGE_KEY, type Bridge } from './preload.ts';
import { createDesktopClient, type DesktopState, type Region, type Transport, viewModel } from './renderer.ts';
import {
  ALLOW,
  bindKeys,
  DECLINE,
  KEEP_DEFAULT,
  type KeyEventLike,
  type KeyTarget,
  queryPreferences,
  queryStart,
  renderView,
  renderVoice,
  START_CONTROL,
  START_CONTROLS,
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
const CAMPAIGN_ATTRIBUTE = 'data-campaign';
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
const FOCUS_ATTRIBUTES = [START_TITLE, START_OPTION, START_CONTROL, START_OPEN];
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
  readonly bridge: Transport & Partial<Pick<Bridge, 'saveStart'>>;
  readonly search: string;
  readonly width: () => number;
  readonly newActionId: () => string;
  readonly openMicrophone: DesktopVoiceOptions['openMicrophone'];
};

type Focusable = Pick<Element, 'id' | 'hasAttribute' | 'getAttribute'>;

const selectorOf = (element: Focusable | null) => {
  if (element === null) return undefined;
  if (element.id !== '') return `#${element.id}`;
  const attribute = FOCUS_ATTRIBUTES.find((name) => element.hasAttribute(name));
  return attribute === undefined ? undefined : `[${attribute}="${element.getAttribute(attribute)}"]`;
};

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
}: PageOptions) => {
  const preferences = queryPreferences(search);
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
  const entryValue = () => root.querySelector<HTMLInputElement>(ENTRY_SELECTOR)?.value;
  const render = () => {
    const model = viewModel(client.state(), width(), preferences);
    const focused = selectorOf(root.querySelector<HTMLElement>(FOCUSED_SELECTOR));
    const typed = entryValue();
    root.innerHTML = renderView(model, preferences.locale) + renderVoice(voice.view(), preferences.locale);
    root.style.setProperty(FONT_SCALE_PROPERTY, String(model.fontScale));
    if (model.start?.step !== shownStep) {
      shownStep = model.start?.step;
      return root.querySelector<HTMLElement>(shownStep === undefined ? OPEN_SELECTOR : TITLE_SELECTOR)?.focus();
    }
    const entry = root.querySelector<HTMLInputElement>(ENTRY_SELECTOR);
    if (entry !== null && typed !== undefined) entry.value = typed;
    if (focused !== undefined) root.querySelector<HTMLElement>(focused)?.focus();
  };
  const startControl = (control: StartControl) => {
    if (control === 'close') return client.closeStart();
    const entry = entryValue();
    if (control === 'start' && entry !== undefined && entry !== client.startScreen().entry?.value)
      client.startAction({ kind: 'enter', text: entry });
    client.startAction({ kind: control });
  };
  const startOption = (index: string) => {
    const option = client.startScreen().options[Number(index)];
    if (option === undefined) return;
    const step = shownStep;
    client.startAction(option.action);
    if (shownStep === step) root.querySelector<HTMLElement>(`[${START_OPTION}="${index}"]`)?.focus();
  };
  const nextCampaign = () => {
    const { campaigns, selected } = client.state();
    const next = campaigns[(campaigns.findIndex(({ id }) => id === selected) + 1) % campaigns.length];
    if (next !== undefined) client.select(next.id);
  };
  const focusRegion = (region: Region) => {
    const section = root.querySelector<HTMLElement>(`[data-region="${region}"]`);
    section?.setAttribute(TABINDEX, PROGRAMMATIC_FOCUS);
    section?.focus();
  };
  const run = (action: RendererAction, event: KeyEventLike) => {
    const region = FOCUS_REGIONS[action];
    if (region !== undefined) return focusRegion(region);
    if (action === 'newAdventure') return client.openStart();
    if (action === 'submit' && (event.target as ClickTarget | undefined)?.closest(START_REGION)) return KEEP_DEFAULT;
    if (action === 'submit') return form.requestSubmit();
    if (action === 'retry') return client.retry();
    if (action === 'nextCampaign') return nextCampaign();
  };
  const loadVoice = ({ snapshot }: DesktopState) => {
    if (snapshot === undefined || snapshot === loaded || client.voicePending()) return;
    loaded = snapshot;
    voice.load(snapshot.voice ?? { ...voicePreferences, microphone: MICROPHONE_OFF }).then(render);
  };
  client.subscribe(loadVoice);
  client.subscribe(render);
  root.addEventListener(CLICK, (event) => {
    const target = closestTarget(event);
    const campaign = target?.closest(`[${CAMPAIGN_ATTRIBUTE}]`)?.getAttribute(CAMPAIGN_ATTRIBUTE);
    if (campaign) return client.select(campaign);
    const answer = target?.closest(`[${VOICE_ATTRIBUTE}]`)?.getAttribute(VOICE_ATTRIBUTE);
    if (answer === ALLOW) return void voice.allow().then(render);
    if (answer === DECLINE) return void voice.decline().then(render);
    if (target?.closest(`[${START_OPEN}]`)) return client.openStart();
    const option = target?.closest(`[${START_OPTION}]`)?.getAttribute(START_OPTION);
    if (option !== undefined && option !== null) return startOption(option);
    const control = target?.closest(`[${START_CONTROL}]`)?.getAttribute(START_CONTROL);
    if (isStartControl(control)) return startControl(control);
    if (target?.closest(RETRY_SELECTOR)) client.retry();
  });
  root.addEventListener(SUBMIT, (event) => {
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
