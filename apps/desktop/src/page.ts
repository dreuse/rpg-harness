import { createMicrophoneController } from '../../../packages/voice/src/microphone.ts';
import { createSubtitleTranscript } from '../../../packages/voice/src/subtitles.ts';
import { type RendererAction, SUPPORTED_LOCALES } from './accessibility.ts';
import { BRIDGE_KEY } from './preload.ts';
import { createDesktopClient, type Region, type Transport, viewModel } from './renderer.ts';
import { bindKeys, type KeyTarget, queryPreferences, renderView, renderVoice } from './view.ts';
import { browserMicrophone, createDesktopVoice, type DesktopVoiceOptions } from './voice.ts';

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
  readonly bridge: Transport;
  readonly search: string;
  readonly width: () => number;
  readonly newActionId: () => string;
  readonly openMicrophone: DesktopVoiceOptions['openMicrophone'];
};

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
  const client = createDesktopClient({ transport: bridge, newActionId });
  const { consent, ...voicePreferences } = preferences.voice;
  const voice = createDesktopVoice({
    session: { campaignId: NO_CAMPAIGN, turn: FIRST_TURN, pendingInput: [], preferences: voicePreferences },
    consent,
    supportedLocales: SUPPORTED_LOCALES,
    subtitles: createSubtitleTranscript(),
    openMicrophone,
    submit: client.submit,
  });
  const render = () => {
    const model = viewModel(client.state(), width(), preferences);
    root.innerHTML = renderView(model, preferences.locale) + renderVoice(voice.view(), preferences.locale);
    root.style.setProperty(FONT_SCALE_PROPERTY, String(model.fontScale));
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
  const run = (action: RendererAction) => {
    const region = FOCUS_REGIONS[action];
    if (region !== undefined) return focusRegion(region);
    if (action === 'submit') return form.requestSubmit();
    if (action === 'retry') return client.retry();
    if (action === 'nextCampaign') return nextCampaign();
  };
  client.subscribe(render);
  root.addEventListener(CLICK, (event) => {
    const target = closestTarget(event);
    const campaign = target?.closest(`[${CAMPAIGN_ATTRIBUTE}]`)?.getAttribute(CAMPAIGN_ATTRIBUTE);
    if (campaign) return client.select(campaign);
    if (target?.closest(RETRY_SELECTOR)) client.retry();
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

const bridgeOf = (scope: object) => (scope as Record<string, Transport | undefined>)[BRIDGE_KEY];

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
