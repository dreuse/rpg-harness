import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDE_STEPS, INITIAL_DRAFT, type StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import { type ClientCommand, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { DUCK_RELEASE_MS } from '../../../packages/voice/src/ducking-sink.ts';
import type { MicrophoneState } from '../../../packages/voice/src/microphone.ts';
import { DEFAULT_SOUND_SETTINGS } from '../../../packages/voice/src/sound-settings.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE, type UiPreferences } from './accessibility.ts';
import { ROLL_COLLAPSE_MS, SETTLE_MS } from './dice.ts';
import { FONT_SCALE_PROPERTY, mountPage, type PageElements, type PageOptions } from './page.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import type { DesktopSound } from './sound-player.ts';
import type { KeyEventLike } from './view.ts';
import type { VoiceProviderStatus } from './voice-host.ts';
import type { VoiceBridge } from './voice-setup.ts';

const CAMPAIGN = 'c1';
const WIDE_WIDTH = 1600;
const COMPACT_WIDTH = 480;
const READY = { type: 'Ready', version: PROTOCOL_VERSION, pid: 42, node: 'v24', sqlite: true, gm: 'fake' };
const SNAPSHOT = {
  version: PROTOCOL_VERSION,
  campaignId: CAMPAIGN,
  revision: 1,
  campaign: { id: CAMPAIGN, name: 'Harbor' },
  characters: [{ id: 'hero', campaignId: CAMPAIGN, name: 'Ash' }],
  currentScene: { id: 's1', campaignId: CAMPAIGN, title: 'Docks' },
  turns: [],
};

const FOCUSED = ':focus';
const ALT_N = { key: '˜', code: 'KeyN', altKey: true } as const;

type Listener = (event: { target: unknown; key?: string; preventDefault(): void }) => void;

const target = (attributes: Record<string, string>, find?: (selector: string) => unknown) => ({
  closest: (selector: string) => {
    const name = /\[([a-z-]+)/.exec(selector)?.[1] ?? '';
    return Object.hasOwn(attributes, name)
      ? { getAttribute: (key: string) => attributes[key] ?? null, open: true, querySelector: find }
      : null;
  },
});

const fakePage = () => {
  const listeners = new Map<string, Listener>();
  const style: Record<string, string> = {};
  const focused: string[] = [];
  const focusOptions: (FocusOptions | undefined)[] = [];
  const sent: ClientCommand[] = [];
  const saved: StartDraft[] = [];
  const fields: Record<string, string> = {};
  const selections: Record<string, [number, number]> = {};
  let prevented = 0;
  let held = false;
  let inputFocused = false;
  const inputAttributes: Record<string, string> = {};
  let onLine = (_line: string) => {};
  const bridge: PageOptions['bridge'] = {
    connect: () => {},
    send: (line) => {
      sent.push(JSON.parse(line) as ClientCommand);
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onClose: () => {},
    saveStart: (draft: StartDraft) => {
      saved.push(draft);
    },
  };
  let html = '';
  let active: ReturnType<typeof node> | null = null;
  const node = (selector: string) => {
    const [, id = ''] = /^#(.+)$/.exec(selector) ?? [];
    const [, name, value = ''] = /^\[([a-z-]+)(?:="(.*)")?\]$/.exec(selector) ?? [];
    const element = {
      id,
      setAttribute: () => {},
      hasAttribute: (attribute: string) => attribute === name,
      getAttribute: (attribute: string) => (attribute === name ? value : null),
      focus: (options?: FocusOptions) => {
        focused.push(selector);
        focusOptions.push(options);
        active = element;
      },
      get selectionStart() {
        return selections[selector]?.[0] ?? null;
      },
      get selectionEnd() {
        return selections[selector]?.[1] ?? null;
      },
      setSelectionRange:
        selector === ENTRY
          ? (start: number, end: number) => {
              selections[selector] = [start, end];
            }
          : undefined,
      get value() {
        return fields[selector];
      },
      set value(typed: string | undefined) {
        if (typed !== undefined) fields[selector] = typed;
      },
    };
    return element;
  };
  const on = (prefix: string) => (type: string, listener: Listener) => {
    const earlier = listeners.get(prefix + type);
    listeners.set(
      prefix + type,
      earlier === undefined
        ? listener
        : (...args) => {
            earlier(...args);
            return listener(...args);
          },
    );
  };
  const elements = {
    root: {
      get innerHTML() {
        return html;
      },
      set innerHTML(next: string) {
        html = next;
        active = null;
        for (const key of Object.keys(fields)) delete fields[key];
        for (const key of Object.keys(selections)) delete selections[key];
      },
      style: { setProperty: (name: string, value: string) => (style[name] = value) },
      addEventListener: on('root:'),
      querySelector: (selector: string) =>
        selector === FOCUSED
          ? active
          : (selector.includes(':hover') && !held) ||
              (selector.includes('[data-primary]') && html.includes('data-voice-step="downloading"'))
            ? null
            : node(selector),
    },
    form: { addEventListener: on('form:'), requestSubmit: () => listeners.get('form:submit')?.(event({})) },
    input: {
      value: '',
      matches: (selector: string) => selector === FOCUSED && inputFocused,
      addEventListener: on('input:'),
      setAttribute: (name: string, value: string) => {
        inputAttributes[name] = value;
      },
      removeAttribute: (name: string) => {
        delete inputAttributes[name];
      },
    },
    slashMenu: { innerHTML: '', hidden: true, addEventListener: on('menu:') },
    slashStatus: { textContent: '' },
    slashHint: { textContent: '' },
    keys: { addEventListener: on('keys:') },
  };
  const event = (attributes: Record<string, string>, key?: string, keys: Partial<KeyEventLike> = {}) => ({
    target: target(attributes, node),
    preventDefault: () => {
      prevented++;
    },
    ...(key === undefined ? {} : { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...keys }),
  });
  return {
    elements: elements as unknown as PageElements,
    root: elements.root,
    input: elements.input,
    menu: elements.slashMenu,
    status: elements.slashStatus,
    hint: elements.slashHint,
    inputAttributes,
    typeAction: (text: string) => {
      elements.input.value = text;
      listeners.get('input:input')?.(event({}));
    },
    keyInInput: (key: string) => {
      const pressed = { ...event({}), key, stopPropagation: () => {} };
      listeners.get('input:keydown')?.(pressed);
      return pressed;
    },
    clickOption: (id: string) => listeners.get('menu:click')?.(event({ 'data-slash': id })),
    bridge,
    sent,
    style,
    focused,
    focusOptions,
    saved,
    fields,
    selections,
    prevented: () => prevented,
    set typingInAction(next: boolean) {
      inputFocused = next;
    },
    set held(next: boolean) {
      held = next;
    },
    receive: (message: object) => onLine(JSON.stringify(message)),
    click: (attributes: Record<string, string>) => listeners.get('root:click')?.(event(attributes)),
    press: (key: string, attributes: Record<string, string> = {}, keys: Partial<KeyEventLike> = {}) =>
      listeners.get('keys:keydown')?.(event(attributes, key, keys)),
    pointerDown: () => listeners.get('keys:pointerdown')?.(event({})),
    keyDown: () => listeners.get('keys:keydown')?.(event({}, 'Enter')),
    submit: (attributes: Record<string, string>) => listeners.get('root:submit')?.(event(attributes)),
    type: () => listeners.get('root:input')?.(event({})),
    toggle: (open: boolean) =>
      listeners.get('root:toggle')?.({
        target: { matches: () => true, open, querySelector: node },
        preventDefault: () => {},
      }),
    change: (attributes: Record<string, string>, value: string, checked?: boolean) =>
      listeners.get('root:change')?.({ ...event(attributes), target: { ...target(attributes), value, checked } }),
  };
};

const DENIED: MicrophoneState = { kind: 'typed-input-only', reason: 'permission-denied' };
const CONSENT = { granted: true, grantedAt: '2026-11-04T00:00:00Z', providerIds: ['local'] } as const;
const SAVED_REVISION = 2;
const SAVED_VOICE = {
  microphone: 'push-to-talk',
  spokenOutput: 'off',
  locale: 'en',
  speed: 1,
  consentGrantedAt: CONSENT.grantedAt,
};
const settle = () => new Promise(setImmediate);
const deniedMicrophone: PageOptions['openMicrophone'] = () => ({ start: async () => DENIED, stop: () => {} });

const mount = (
  page: ReturnType<typeof fakePage>,
  saved: Partial<UiPreferences> = {},
  openMicrophone = deniedMicrophone,
  startDraft?: StartDraft,
  width = WIDE_WIDTH,
  extra: Partial<PageOptions> = {},
) => {
  const preferences = { ...DEFAULT_PREFERENCES, fontScale: MAX_FONT_SCALE, ...saved };
  let actions = 0;
  return mountPage({
    elements: page.elements,
    bridge: page.bridge,
    search: `?${new URLSearchParams({
      [PREFERENCES_QUERY]: JSON.stringify(preferences),
      ...(startDraft === undefined ? {} : { [START_QUERY]: JSON.stringify(startDraft) }),
    })}`,
    width: () => width,
    newActionId: () => `a${actions++}`,
    openMicrophone,
    ...extra,
  });
};

const HARBOR = SNAPSHOT.campaign.name;

const continueHarbor = (page: ReturnType<typeof fakePage>) => {
  page.click({ 'data-home': 'continue', 'data-name': HARBOR });
  const command = page.sent.findLast(({ type }) => type === 'OpenCampaign');
  page.receive({ type: 'Changed', command, result: { ok: true, value: SNAPSHOT.campaign } });
};

const submitted = (page: ReturnType<typeof fakePage>) =>
  page.sent.filter(({ type }) => type === 'SubmitPlayerAction').map((command) => 'input' in command && command.input);

test('rpg-42a.7 page renders the view and drives the client through the bridge', async () => {
  const page = fakePage();
  mount(page);
  assert.match(page.root.innerHTML, /role="status" data-connection="connecting">Connecting</);
  assert.equal(page.style[FONT_SCALE_PROPERTY], String(MAX_FONT_SCALE));
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  assert.match(page.root.innerHTML, /data-home="continue" data-name="Harbor"/);
  continueHarbor(page);
  assert.ok(page.sent.some((command) => command.type === 'SubscribeEvents'));
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.input.value = 'look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  assert.equal(page.input.value, '');
  page.press('Alt+2');
  assert.equal(page.focused[0], '#heading-status');
  assert.equal(page.focused.at(-1), '[data-region="sheet"]');
});

test('rpg-42a.91 the Talk to the GM toggle sends input out of character and never as an action', async () => {
  const page = fakePage();
  let click = () => {};
  const toggle = {
    textContent: '',
    pressed: '',
    setAttribute: (name: string, value: string) => {
      if (name === 'aria-pressed') toggle.pressed = value;
    },
    addEventListener: (_type: string, listener: () => void) => {
      click = listener;
    },
  };
  const elements = { ...page.elements, oocToggle: toggle } as unknown as PageElements;
  mountPage({
    elements,
    bridge: page.bridge,
    search: `?${new URLSearchParams({ [PREFERENCES_QUERY]: JSON.stringify({ ...DEFAULT_PREFERENCES, locale: 'pt-BR' }) })}`,
    width: () => WIDE_WIDTH,
    newActionId: (() => {
      let next = 0;
      return () => `o${next++}`;
    })(),
    openMicrophone: deniedMicrophone,
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.equal(toggle.textContent, 'Falar com o mestre');
  assert.equal(toggle.pressed, 'false');
  click();
  assert.equal(toggle.pressed, 'true');
  page.input.value = 'NPCs speak modern English';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), []);
  assert.deepEqual(
    page.sent.filter(({ type }) => type === 'SubmitOocMessage').map((command) => 'text' in command && command.text),
    ['NPCs speak modern English'],
  );
  assert.equal(page.input.value, '');
  page.receive({
    type: 'OocResult',
    command: 'SubmitOocMessage',
    actionId: 'o0',
    result: { ok: true, value: { reply: 'Posso guardar isso.', proposals: [] } },
  });
  assert.match(page.root.innerHTML, /Posso guardar isso\./);
});

test('rpg-42a.7 page retries only from the retry button', () => {
  const page = fakePage();
  const client = mount(page);
  page.receive({ ...READY, version: PROTOCOL_VERSION + 1 });
  page.click({});
  assert.equal(client.state().connection.status, 'disconnected');
  page.click({ 'data-action': 'retry' });
  assert.equal(client.state().connection.status, 'reconnecting');
});

test('A18 page renders voice and opens the mic at startup when saved settings enable it', async () => {
  const off = fakePage();
  const unused: string[] = [];
  mount(off, {}, (settings) => {
    unused.push(settings.microphone);
    return { start: async () => DENIED, stop: () => {} };
  });
  assert.deepEqual(unused, []);
  assert.doesNotMatch(off.root.innerHTML, /data-region="voice"/);

  const page = fakePage();
  const opened: string[] = [];
  mount(page, { voice: { ...DEFAULT_PREFERENCES.voice, microphone: 'push-to-talk', consent: CONSENT } }, (settings) => {
    opened.push(settings.microphone);
    return { start: async () => DENIED, stop: () => {} };
  });
  await settle();
  assert.deepEqual(opened, []);

  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, voice: SAVED_VOICE } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  assert.match(page.root.innerHTML, /Audio unavailable \(permission-denied\); type instead/);
  assert.match(
    page.root.innerHTML,
    /<section data-region="voice"[^>]*><p>Push to talk · Spoken output off · English · normal speed<\/p>/,
  );
  page.input.value = 'set mic to off. look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  assert.equal(page.input.value, '');
  assert.doesNotMatch(page.root.innerHTML, /Push to talk/);
  assert.doesNotMatch(page.root.innerHTML, /Audio unavailable|data-region="voice"/);
});

const saves = (page: ReturnType<typeof fakePage>) => page.sent.filter(({ type }) => type === 'SaveVoiceSettings');

test('A21 page asks for microphone consent, saves the answer through the engine and keeps text play', async () => {
  const page = fakePage();
  const opened: string[] = [];
  mount(page, { voice: { ...DEFAULT_PREFERENCES.voice, consent: CONSENT } }, (settings) => {
    opened.push(settings.microphone);
    return { start: async () => DENIED, stop: () => {} };
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.input.value = 'set mic to push-to-talk';
  page.press('Enter');
  await settle();
  assert.match(page.root.innerHTML, /Allow microphone capture for this campaign\?/);
  assert.deepEqual(opened, []);
  assert.deepEqual(saves(page), []);
  page.click({ 'data-voice': 'decline' });
  await settle();
  assert.doesNotMatch(page.root.innerHTML, /Allow microphone capture/);
  assert.deepEqual(opened, []);
  const declined = saves(page).at(-1);
  assert.ok(declined?.type === 'SaveVoiceSettings');
  assert.equal(declined.microphone, 'off');
  assert.equal(declined.consentGrantedAt, undefined);
  const refreshes = page.sent.filter(({ type }) => type === 'GetCampaignSnapshot').length;
  page.receive({ type: 'Accepted', actionId: declined.actionId });
  assert.equal(page.sent.filter(({ type }) => type === 'GetCampaignSnapshot').length, refreshes + 1);
  const { consentGrantedAt: _none, ...textOnly } = SAVED_VOICE;
  const saved = { ...SNAPSHOT, revision: SAVED_REVISION, voice: { ...textOnly, microphone: 'off' } };
  page.receive({ type: 'Snapshot', snapshot: saved });
  page.input.value = 'look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  const action = page.sent.findLast(({ type }) => type === 'SubmitPlayerAction');
  assert.ok(action?.type === 'SubmitPlayerAction');
  assert.equal(action.expectedRevision, SAVED_REVISION);

  page.input.value = 'set mic to hands-free';
  page.press('Enter');
  await settle();
  page.click({ 'data-voice': 'allow' });
  await settle();
  assert.deepEqual(opened, ['hands-free']);
  const granted = saves(page).at(-1);
  assert.ok(granted?.type === 'SaveVoiceSettings' && granted.consentGrantedAt);
  assert.equal(granted.microphone, 'hands-free');
  assert.equal(granted.expectedRevision, SAVED_REVISION);
  page.receive({ type: 'Rejected', actionId: granted.actionId, error: { code: 'Rejected', message: 'no' } });
  assert.match(page.root.innerHTML, /role="alert"><li>voice settings: no/);
  page.receive({ type: 'Snapshot', snapshot: { ...saved } });
  await settle();
  assert.doesNotMatch(page.root.innerHTML, /Push to talk/);
});

test('A21 page retries a voice save rejected as stale and keeps the mic off', async () => {
  const page = fakePage();
  const opened: string[] = [];
  mount(page, { voice: { ...DEFAULT_PREFERENCES.voice, consent: CONSENT } }, (settings) => {
    opened.push(settings.microphone);
    return { start: async () => DENIED, stop: () => {} };
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, voice: SAVED_VOICE } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  page.input.value = 'set mic to off. look around';
  page.press('Enter');
  await settle();
  const action = page.sent.findLast(({ type }) => type === 'SubmitPlayerAction');
  const first = saves(page).at(-1);
  assert.ok(action?.type === 'SubmitPlayerAction' && first?.type === 'SaveVoiceSettings');
  assert.equal(first.microphone, 'off');
  page.receive({ type: 'Accepted', actionId: action.actionId });
  page.receive({ type: 'Rejected', actionId: first.actionId, error: { code: 'StaleRevision', message: 'stale' } });
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, revision: SAVED_REVISION, voice: SAVED_VOICE } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  assert.doesNotMatch(page.root.innerHTML, /voice settings: stale/);
  assert.doesNotMatch(page.root.innerHTML, /Push to talk/);
  const retry = saves(page).at(-1);
  assert.ok(retry?.type === 'SaveVoiceSettings' && retry !== first);
  assert.equal(retry.expectedRevision, SAVED_REVISION);
  assert.equal(retry.microphone, 'off');
  page.receive({ type: 'Accepted', actionId: retry.actionId });
  const off = { ...SAVED_VOICE, microphone: 'off' };
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, revision: SAVED_REVISION + 1, voice: off } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  assert.doesNotMatch(page.root.innerHTML, /Push to talk/);
  assert.equal(saves(page).length, 2);
});

const TITLE = '[data-start-title]';
const ENTRY = '#start-entry';
const GUIDED_NAME = 'Ashfall';
const AT_SUMMARY: StartDraft = { ...INITIAL_DRAFT, path: 'guide', step: GUIDE_STEPS.length - 1 };
const OPTIONS = { genres: [], rulesets: [] };
const sentOf = (page: ReturnType<typeof fakePage>, type: string) =>
  page.sent.filter((command) => command.type === type);

test('rpg-42a.14 page opens the guided start from the keyboard and moves focus to each new step', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  assert.deepEqual(sentOf(page, 'PlanCampaign'), []);
  page.press(ALT_N.key, {}, ALT_N);
  assert.match(page.root.innerHTML, /data-start-title="path"/);
  assert.deepEqual(page.focused, [TITLE]);
  page.receive({ type: 'Campaigns', campaigns: [] });
  assert.deepEqual(page.focused, [TITLE, '[data-start-title=""]']);
  page.focused.length = 0;
  assert.equal(sentOf(page, 'PlanCampaign').length, 1);
  page.click({ 'data-start-option': '1' });
  assert.match(page.root.innerHTML, /Step 1 of 7: What is a tabletop RPG\?/);
  assert.deepEqual(page.focused, [TITLE]);
  assert.equal(page.saved.at(-1)?.path, 'guide');
  page.click({ 'data-start-control': 'back' });
  assert.match(page.root.innerHTML, /data-start-title="path"/);
  page.click({ 'data-start-control': 'close' });
  assert.doesNotMatch(page.root.innerHTML, /data-start-title/);
});

test('rpg-42a.14 page keeps Enter for the wizard and never sends it as a player action', async () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.press(ALT_N.key, {}, ALT_N);
  page.click({ 'data-start-option': '0' });
  page.input.value = 'look around';
  const before = page.prevented();
  page.press('Enter', { 'data-region': 'start' });
  await settle();
  assert.equal(page.prevented(), before);
  assert.deepEqual(submitted(page), []);
  page.fields[ENTRY] = 'A horror story';
  page.submit({ 'data-start-form': '' });
  assert.equal(page.saved.at(-1)?.intent, 'A horror story');
  assert.match(page.root.innerHTML, /data-start-title="begin"/);
  page.click({ 'data-start-control': 'next' });
  assert.match(page.root.innerHTML, /data-start-title="summary"/);
});

test('rpg-42a.14 page restores the saved step and starts with a renamed adventure', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, AT_SUMMARY);
  assert.match(page.root.innerHTML, /data-start-title="summary"/);
  page.receive(READY);
  const plan = sentOf(page, 'PlanCampaign').at(-1);
  page.receive({
    type: 'Planned',
    command: plan,
    result: { ok: true, value: { version: PROTOCOL_VERSION, options: OPTIONS, entries: [] } },
  });
  page.fields[ENTRY] = GUIDED_NAME;
  page.click({ 'data-start-control': 'start' });
  const created = sentOf(page, 'CreateCampaign');
  assert.equal(created.length, 1);
  assert.ok(created[0]?.type === 'CreateCampaign');
  assert.equal(created[0].name, GUIDED_NAME);
});

test('rpg-42a.14 page keeps focus on a toggled option and announces it as pressed', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, { ...AT_SUMMARY, step: GUIDE_STEPS.indexOf('features') });
  page.click({ 'data-start-option': '0' });
  assert.equal(page.focused.at(-1), '[data-start-option="0"]');
  assert.match(page.root.innerHTML, /data-start-option="0" aria-pressed="true"/);
  assert.equal(page.saved.at(-1)?.choices.diceVisualization, true);
});

test('rpg-42a.14 page keeps focus and the typed name when an engine reply redraws the wizard', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, AT_SUMMARY);
  page.receive(READY);
  const entry = page.root.querySelector(ENTRY);
  assert.ok(entry);
  entry.focus();
  entry.value = GUIDED_NAME;
  const plan = sentOf(page, 'PlanCampaign').at(-1);
  page.receive({
    type: 'Planned',
    command: plan,
    result: { ok: true, value: { version: PROTOCOL_VERSION, options: OPTIONS, entries: [] } },
  });
  assert.equal(page.focused.at(-1), ENTRY);
  assert.equal(page.fields[ENTRY], GUIDED_NAME);
});

test('rpg-42a.30 page edits a summary setting at its step and keeps the typed name when leaving the summary', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, AT_SUMMARY);
  page.receive(READY);
  page.fields[ENTRY] = GUIDED_NAME;
  page.click({ 'data-start-edit': String(GUIDE_STEPS.indexOf('rules')) });
  assert.match(page.root.innerHTML, /data-start-title="rules"/);
  assert.equal(page.focused.at(-1), TITLE);
  assert.equal(page.saved.at(-1)?.name, GUIDED_NAME);
  page.click({ 'data-start-edit': 'nope' });
  assert.match(page.root.innerHTML, /data-start-title="rules"/);
  const back = fakePage();
  mount(back, {}, deniedMicrophone, AT_SUMMARY);
  back.fields[ENTRY] = GUIDED_NAME;
  back.click({ 'data-start-control': 'back' });
  assert.equal(back.saved.at(-1)?.name, GUIDED_NAME);
  assert.match(back.root.innerHTML, /data-start-title="begin"/);
});

const shownPane = (html: string, region: string) =>
  new RegExp(`data-region="${region}" aria-labelledby="heading-${region}">`).test(html);

test('rpg-42a.18 page switches the compact pane from the pane buttons and the focus shortcuts', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, undefined, COMPACT_WIDTH);
  page.receive(READY);
  assert.ok(shownPane(page.root.innerHTML, 'campaigns'));
  assert.ok(!shownPane(page.root.innerHTML, 'conversation'));
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  assert.ok(shownPane(page.root.innerHTML, 'conversation'));
  assert.ok(!shownPane(page.root.innerHTML, 'campaigns'));
  page.root.querySelector('[data-pane="sheet"]')?.focus();
  page.click({ 'data-pane': 'sheet' });
  assert.ok(shownPane(page.root.innerHTML, 'sheet'));
  assert.ok(!shownPane(page.root.innerHTML, 'conversation'));
  assert.equal(page.focused.at(-1), '[data-pane="sheet"]');
  page.click({ 'data-pane': 'nowhere' });
  assert.ok(shownPane(page.root.innerHTML, 'sheet'));
  page.press('3', {}, { altKey: true });
  assert.ok(shownPane(page.root.innerHTML, 'panels'));
  assert.equal(page.focused.at(-1), '[data-region="panels"]');
});

test('rpg-42a.22 page goes home from the play header, focuses the adventures and keeps Enter off the action', async () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.match(page.root.innerHTML, /data-screen="play"/);
  assert.equal(page.focused.at(-1), '#heading-status');
  page.input.value = 'look around';
  const before = page.prevented();
  page.press('Enter', { 'data-region': 'status' });
  await settle();
  assert.equal(page.prevented(), before);
  assert.deepEqual(submitted(page), []);
  page.click({ 'data-nav': 'home' });
  assert.match(page.root.innerHTML, /data-screen="home"/);
  assert.equal(page.focused.at(-1), '#home-continue-0');
  assert.equal(page.sent.at(-1)?.type, 'ListCampaigns');
  page.press('Enter');
  await settle();
  assert.equal(page.prevented(), before);
  assert.deepEqual(submitted(page), []);
});

test('rpg-42a.22 Escape closes the open menu and returns focus to its toggle', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  const before = page.prevented();
  page.press('Escape');
  assert.equal(page.prevented(), before);
  page.press('Escape', { open: '' });
  assert.equal(page.prevented(), before + 1);
  assert.equal(page.focused.at(-1), 'summary');
});

test('rpg-42a.55 opening settings moves focus into the panel and Escape returns it to the toggle', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.toggle(true);
  assert.notEqual(page.focused.at(-1), '[data-settings-panel]');
  page.click({ 'data-settings-toggle': '' });
  page.toggle(true);
  assert.equal(page.focused.at(-1), '[data-settings-panel]');
  page.toggle(true);
  assert.equal(page.focused.filter((selector) => selector === '[data-settings-panel]').length, 1);
  page.press('Escape', { 'data-settings': '', open: '' });
  assert.equal(page.focused.at(-1), 'summary');
});

const MANY_CAMPAIGNS = 6;
const HOME_SEARCH = '#home-search';

test('rpg-42a.66 page renames a campaign from the typed name after confirmation', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  page.click({ 'data-home': 'rename', 'data-name': HARBOR });
  assert.match(page.root.innerHTML, /role="alertdialog"[\s\S]*<input id="home-rename-input"/);
  assert.equal(page.focused.at(-1), '#home-rename-input');
  page.fields['#home-rename-input'] = '  Lighthouse  ';
  page.click({ 'data-home': 'confirm' });
  const rename = sentOf(page, 'RenameCampaign').at(-1);
  assert.ok(rename?.type === 'RenameCampaign' && rename.name === HARBOR && rename.newName === 'Lighthouse');
  assert.doesNotMatch(page.root.innerHTML, /role="alertdialog"/);
  page.click({ 'data-home': 'rename', 'data-name': HARBOR });
  page.fields['#home-rename-input'] = '   ';
  page.click({ 'data-home': 'confirm' });
  assert.equal(sentOf(page, 'RenameCampaign').length, 1);
  assert.deepEqual(sentOf(page, 'DeleteCampaign'), []);
});

test('rpg-42a.13 page archives after confirmation with focus on the choice, then undoes it', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  page.click({ 'data-home': 'archive', 'data-name': HARBOR });
  assert.match(page.root.innerHTML, /role="alertdialog"/);
  assert.equal(page.focused.at(-1), '#home-cancel');
  page.click({ 'data-home': 'cancel' });
  assert.doesNotMatch(page.root.innerHTML, /role="alertdialog"/);
  assert.equal(page.focused.at(-1), '#home-more-0');
  assert.deepEqual(sentOf(page, 'ArchiveCampaign'), []);
  page.click({ 'data-home': 'archive', 'data-name': HARBOR });
  page.click({ 'data-home': 'confirm' });
  const archive = sentOf(page, 'ArchiveCampaign').at(-1);
  assert.ok(archive?.type === 'ArchiveCampaign' && archive.name === HARBOR);
  page.receive({ type: 'Changed', command: archive, result: { ok: true, value: true } });
  page.receive({ type: 'Campaigns', campaigns: [], archived: [SNAPSHOT.campaign] });
  assert.match(page.root.innerHTML, /<details data-archived>/);
  page.click({ 'data-home': 'undo' });
  assert.equal(sentOf(page, 'UnarchiveCampaign').length, 1);
  page.click({ 'data-home': 'unarchive', 'data-name': HARBOR });
  assert.equal(sentOf(page, 'UnarchiveCampaign').length, 2);
  page.click({ 'data-home': 'delete', 'data-name': HARBOR });
  page.click({ 'data-home': 'confirm' });
  const remove = sentOf(page, 'DeleteCampaign').at(-1);
  assert.ok(remove?.type === 'DeleteCampaign' && remove.confirm === HARBOR && remove.archived === undefined);
  page.click({ 'data-home': 'delete', 'data-name': HARBOR, 'data-archived': '' });
  page.click({ 'data-home': 'confirm' });
  const archivedRemove = sentOf(page, 'DeleteCampaign').at(-1);
  assert.ok(archivedRemove?.type === 'DeleteCampaign' && archivedRemove.archived === true);
});

test('rpg-42a.13 page searches as the player types and keeps Enter on the home controls', async () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  const many = Array.from({ length: MANY_CAMPAIGNS }, (_, index) => ({ id: `c${index}`, name: `Tale ${index}` }));
  page.receive({ type: 'Campaigns', campaigns: many });
  page.root.querySelector(HOME_SEARCH)?.focus();
  page.fields[HOME_SEARCH] = 'tale 3';
  page.type();
  assert.match(page.root.innerHTML, /<input id="home-search" type="search" value="tale 3">/);
  assert.doesNotMatch(page.root.innerHTML, /Tale 2/);
  assert.equal(page.focused.at(-1), HOME_SEARCH);
  const before = page.prevented();
  page.press('Enter', { 'data-region': 'campaigns' });
  await settle();
  assert.equal(page.prevented(), before);
  page.press('Alt+ArrowDown');
  assert.ok(sentOf(page, 'OpenCampaign').length === 1);
});

const ROLL = {
  version: PROTOCOL_VERSION,
  type: 'MechanicVisualized',
  resultId: 'r1',
  mechanic: 'dice',
  frames: [{ step: 0, reveal: { kind: 'die', sides: 20, face: 17 } }],
  final: { total: 17, outcome: 'success' },
};

test('UI15: page skips a roll, settles it after the animation and honours prefers-reduced-motion', () => {
  const timers: (() => void)[] = [];
  const schedule = (run: () => void, ms: number) => {
    if (ms !== ROLL_COLLAPSE_MS) timers.push(run);
  };
  const page = fakePage();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, { schedule });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive(ROLL);
  assert.match(page.root.innerHTML, /data-animated="true"/);
  assert.equal(timers.length, 1);
  page.click({ 'data-roll-skip': '' });
  assert.match(page.root.innerHTML, /data-animated="false"/);
  page.receive({ ...ROLL, resultId: 'r2' });
  assert.match(page.root.innerHTML, /data-animated="true"/);
  while (timers.length > 0) timers.shift()?.();
  assert.match(page.root.innerHTML, /data-animated="false"/);

  const reduced = fakePage();
  mount(reduced, {}, deniedMicrophone, undefined, WIDE_WIDTH, { schedule, prefersReducedMotion: () => true });
  reduced.receive(READY);
  reduced.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(reduced);
  reduced.receive(ROLL);
  assert.match(reduced.root.innerHTML, /data-animated="false"[\s\S]*17/);
});

test('UI15: page saves the chosen motion setting and re-renders with it', () => {
  const saved: UiPreferences[] = [];
  const page = fakePage();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, savePreferences: (preferences: UiPreferences) => saved.push(preferences) },
    schedule: () => {},
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive(ROLL);
  assert.match(page.root.innerHTML, /data-animated="true"/);
  page.click({ 'data-motion': 'off' });
  assert.equal(saved.at(-1)?.motion, 'off');
  assert.equal(saved.at(-1)?.fontScale, MAX_FONT_SCALE);
  assert.match(page.root.innerHTML, /data-motion="off" aria-pressed="true"/);
  assert.match(page.root.innerHTML, /data-animate="false"/);
  page.click({ 'data-motion': 'wild' });
  assert.equal(saved.length, 1);
});

test('rpg-42a.39 page saves the chosen language and re-renders in it', () => {
  const saved: UiPreferences[] = [];
  const page = fakePage();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, savePreferences: (preferences: UiPreferences) => saved.push(preferences) },
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.click({ 'data-locale': 'pt-BR' });
  assert.equal(saved.at(-1)?.locale, 'pt-BR');
  assert.match(page.root.innerHTML, /<summary id="settings-toggle" data-settings-toggle>Configurações<\/summary>/);
  page.click({ 'data-locale': 'xx' });
  assert.equal(saved.length, 1);
});

test('rpg-42a.39 page localizes the document outside its root on every language change', () => {
  const localized: string[] = [];
  const page = fakePage();
  mount(page, { locale: 'es' }, deniedMicrophone, undefined, WIDE_WIDTH, {
    localize: (locale: string) => localized.push(locale),
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.click({ 'data-locale': 'pt-BR' });
  assert.equal(localized[0], 'es');
  assert.equal(localized.at(-1), 'pt-BR');
});

test('UI15: page settles only the roll it scheduled', () => {
  const timers: (() => void)[] = [];
  const page = fakePage();
  const client = mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    schedule: (run, ms) => {
      if (ms !== ROLL_COLLAPSE_MS) timers.push(run);
    },
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive(ROLL);
  page.receive({ ...ROLL, resultId: 'r2' });
  timers.shift()?.();
  assert.equal(client.state().rolling, true);
  timers.shift()?.();
  assert.equal(client.state().rolling, false);
});

test('rpg-42a.102: the roll card collapses after the delay, waits while held and reopens from the badge', () => {
  const timers: [() => void, number][] = [];
  const page = fakePage();
  const client = mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    schedule: (run, ms) => timers.push([run, ms]),
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive(ROLL);
  const collapse = () => {
    const index = timers.findIndex(([, ms]) => ms === ROLL_COLLAPSE_MS);
    assert.notEqual(index, -1);
    timers.splice(index, 1)[0]?.[0]();
  };
  page.held = true;
  collapse();
  assert.equal(client.state().rollsCollapsed, false);
  page.held = false;
  collapse();
  assert.equal(client.state().rollsCollapsed, true);
  assert.match(page.root.innerHTML, /data-roll-badge/);
  page.click({ 'data-roll-badge': '' });
  assert.equal(client.state().rollsCollapsed, false);
  assert.ok(timers.some(([, ms]) => ms === ROLL_COLLAPSE_MS));
});

const mountRolling = () => {
  const timers: [() => void, number][] = [];
  const page = fakePage();
  const client = mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    schedule: (run, ms) => timers.push([run, ms]),
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive(ROLL);
  const fire = (ms: number) => {
    const index = timers.findLastIndex(([, delay]) => delay === ms);
    assert.notEqual(index, -1);
    timers.splice(index, 1)[0]?.[0]();
  };
  return { page, client, timers, fire };
};

test('rpg-42a.102: a new roll before the timer fires keeps the card and starts a fresh delay', () => {
  const { page, client, timers, fire } = mountRolling();
  page.receive({ ...ROLL, resultId: 'r2' });
  fire(ROLL_COLLAPSE_MS);
  assert.equal(client.state().rollsCollapsed, false);
  assert.ok(timers.some(([, ms]) => ms === ROLL_COLLAPSE_MS));
});

test('rpg-42a.102: reopening from the badge focuses the card and a redraw keeps focus on the badge', () => {
  const { page, client, fire } = mountRolling();
  fire(ROLL_COLLAPSE_MS);
  page.root.querySelector('[data-roll-badge=""]')?.focus();
  page.focused.length = 0;
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  assert.equal(page.focused.at(-1), '[data-roll-badge=""]');
  page.click({ 'data-roll-badge': '' });
  assert.equal(client.state().rollsCollapsed, false);
  assert.equal(page.focused.at(-1), '[data-rolls]');
  assert.match(page.root.innerHTML, /<section data-rolls tabindex="-1"/);
});

const MIGHT_TYPED = '14';

test('rpg-42a.102: reopening from the badge keeps unsaved sheet input', () => {
  const { page, fire } = mountRolling();
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.receive({ type: 'View', campaignId: CAMPAIGN, view: EDITABLE_SHEET });
  page.click({ 'data-sheet-action': 'edit' });
  page.fields[MIGHT_INPUT] = MIGHT_TYPED;
  fire(ROLL_COLLAPSE_MS);
  assert.equal(page.fields[MIGHT_INPUT], MIGHT_TYPED);
  page.click({ 'data-roll-badge': '' });
  assert.equal(page.fields[MIGHT_INPUT], MIGHT_TYPED);
  assert.equal(page.focused.at(-1), '[data-rolls]');
});

test('rpg-42a.102: the badge highlight clears after the settle delay', () => {
  const { client, fire } = mountRolling();
  fire(ROLL_COLLAPSE_MS);
  assert.equal(client.state().rollBadgeFresh, true);
  fire(SETTLE_MS);
  assert.equal(client.state().rollBadgeFresh, false);
});

test('rpg-42a.19 page keeps the focused entry and caret when the same step redraws', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, { ...INITIAL_DRAFT, path: 'describe' });
  page.root.querySelector(ENTRY)?.focus();
  page.fields[ENTRY] = 'A horror story';
  page.selections[ENTRY] = [2, 5];
  page.focused.length = 0;
  page.receive(READY);
  assert.deepEqual(page.selections[ENTRY], [2, 5]);
  assert.equal(page.fields[ENTRY], 'A horror story');
  assert.equal(page.focused.at(-1), ENTRY);
});

test('rpg-42a.19 page keeps focus on the submit button when the same step redraws', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, { ...INITIAL_DRAFT, path: 'describe' });
  assert.match(page.root.innerHTML, /<button type="submit" id="start-submit"/);
  page.root.querySelector('#start-submit')?.focus();
  page.focused.length = 0;
  page.receive(READY);
  assert.equal(page.focused.at(-1), '#start-submit');
});

const EDITABLE_SHEET = {
  campaignId: CAMPAIGN,
  viewId: 'sheet',
  components: [
    { kind: 'field', id: 'might', label: 'Might', value: 3, group: 'core', editable: true },
    { kind: 'field', id: 'title', label: 'Title', value: 'Scout', group: 'custom', editable: true },
  ],
};
const MIGHT_INPUT = '#sheet-field-might';
const edits = (page: ReturnType<typeof fakePage>) =>
  page.sent.flatMap((command) =>
    command.type === 'EditSheetField' ? [{ fieldId: command.fieldId, value: command.value }] : [],
  );

const playingSheet = () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.receive({ type: 'View', campaignId: CAMPAIGN, view: EDITABLE_SHEET });
  return page;
};

const TITLE_INPUT = '#sheet-field-title';
const SHEET_FORM = { 'data-sheet-form': '' };
const SHEET_EDIT = '#sheet-edit';

test('rpg-42a.29 page edits the whole sheet with one save and shows inline and engine messages', () => {
  const page = playingSheet();
  assert.doesNotMatch(page.root.innerHTML, /data-sheet-form/);
  page.click({ 'data-sheet-action': 'edit' });
  assert.match(page.root.innerHTML, /<form data-sheet-form novalidate/);
  assert.equal(page.focused.at(-1), '[data-sheet-form] input');
  page.fields[MIGHT_INPUT] = 'lots';
  page.fields[TITLE_INPUT] = 'Warden';
  page.submit(SHEET_FORM);
  assert.deepEqual(edits(page), []);
  assert.match(page.root.innerHTML, /<p role="alert" id="sheet-error-might">Enter a number\.<\/p>/);
  assert.equal(page.fields[TITLE_INPUT], 'Warden');
  page.fields[MIGHT_INPUT] = '99';
  page.submit(SHEET_FORM);
  assert.deepEqual(edits(page), [{ fieldId: 'might', value: 99 }]);
  assert.doesNotMatch(page.root.innerHTML, /data-sheet-form/);
  assert.equal(page.focused.at(-1), SHEET_EDIT);
  page.receive({ type: 'Rejected', actionId: 'a0', error: { code: 'Rejected', message: 'might must be at most 20' } });
  assert.match(page.root.innerHTML, /<p role="alert" id="sheet-error-might">might must be at most 20<\/p>/);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.deepEqual(edits(page), [{ fieldId: 'might', value: 99 }]);
});

test('rpg-42a.29 Escape and Cancel leave the sheet editor without sending', () => {
  const page = playingSheet();
  page.click({ 'data-sheet-action': 'edit' });
  page.fields[MIGHT_INPUT] = '5';
  page.press('Escape', SHEET_FORM);
  assert.doesNotMatch(page.root.innerHTML, /data-sheet-form/);
  assert.equal(page.focused.at(-1), SHEET_EDIT);
  page.click({ 'data-sheet-action': 'edit' });
  page.click({ 'data-sheet-action': 'cancel' });
  assert.doesNotMatch(page.root.innerHTML, /data-sheet-form/);
  assert.deepEqual(edits(page), []);
});

test('rpg-42a.21 page keeps Enter and the typed values for sheet inputs', async () => {
  const page = playingSheet();
  page.input.value = 'look around';
  const before = page.prevented();
  page.press('Enter', { 'data-region': 'sheet' });
  await settle();
  assert.equal(page.prevented(), before);
  assert.deepEqual(submitted(page), []);
  page.click({ 'data-sheet-action': 'edit' });
  page.root.querySelector(MIGHT_INPUT)?.focus();
  page.fields[MIGHT_INPUT] = '7';
  page.fields[TITLE_INPUT] = 'Warden';
  page.receive({ type: 'View', campaignId: CAMPAIGN, view: EDITABLE_SHEET });
  assert.equal(page.fields[MIGHT_INPUT], '7');
  assert.equal(page.fields[TITLE_INPUT], 'Warden');
  assert.equal(page.focused.at(-1), MIGHT_INPUT);
});

const GM_FORM = { 'data-gm-form': '' };
const GM_FIELD = (name: string) => `[data-gm-form] [name="${name}"]`;

test('rpg-42a.37 page saves the GM form, omits empty fields and keeps typed values across redraws', () => {
  const page = playingSheet();
  page.fields[GM_FIELD('model')] = ' opus ';
  page.fields[GM_FIELD('summaryModel')] = '';
  page.fields[GM_FIELD('sessionBudgetTokens')] = '500';
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.equal(page.fields[GM_FIELD('model')], ' opus ');
  page.submit(GM_FORM);
  const saves = page.sent.filter(({ type }) => type === 'SaveGmSettings');
  assert.equal(saves.length, 1);
  assert.ok(saves[0]?.type === 'SaveGmSettings');
  assert.equal(saves[0].model, 'opus');
  assert.equal(saves[0].sessionBudgetTokens, 500);
  assert.equal('summaryModel' in saves[0], false);
  assert.equal(page.prevented() > 0, true);
});

test('rpg-42a.58 page saves the rules strictness with the GM form and omits it when left on the default', () => {
  const page = playingSheet();
  page.fields[GM_FIELD('rulesStrictness')] = 'relaxed';
  page.submit(GM_FORM);
  page.fields[GM_FIELD('rulesStrictness')] = '';
  page.submit(GM_FORM);
  const saves = page.sent.filter(({ type }) => type === 'SaveGmSettings');
  assert.equal(saves.length, 2);
  assert.ok(saves[0]?.type === 'SaveGmSettings' && saves[1]?.type === 'SaveGmSettings');
  assert.equal(saves[0].rulesStrictness, 'relaxed');
  assert.equal('rulesStrictness' in saves[1], false);
});

const GM_DEFAULTS_FORM = { 'data-gm-defaults-form': '' };
const GM_DEFAULTS_FIELD = (name: string) => `[data-gm-defaults-form] [name="${name}"]`;

test('rpg-42a.37 page saves the app default apart and never copies it into the campaign', () => {
  const page = playingSheet();
  page.fields[GM_DEFAULTS_FIELD('model')] = ' sonnet ';
  page.fields[GM_DEFAULTS_FIELD('sessionBudgetTokens')] = '';
  page.submit(GM_DEFAULTS_FORM);
  const defaults = page.sent.filter(({ type }) => type === 'SaveGmDefaults');
  assert.equal(defaults.length, 1);
  assert.ok(defaults[0]?.type === 'SaveGmDefaults');
  assert.equal(defaults[0].model, 'sonnet');
  assert.equal('sessionBudgetTokens' in defaults[0], false);
  assert.equal(
    page.sent.some(({ type }) => type === 'SaveGmSettings'),
    false,
  );
  page.submit(GM_FORM);
  const save = page.sent.find(({ type }) => type === 'SaveGmSettings');
  assert.ok(save?.type === 'SaveGmSettings');
  assert.equal('model' in save, false);
  assert.equal('summaryModel' in save, false);
  assert.equal('sessionBudgetTokens' in save, false);
});

const VOICE_PROVIDER: VoiceProviderStatus = {
  id: 'kokoro',
  languages: ['en'],
  voices: ['af_heart', 'am_adam'],
  narrator: 'af_heart',
  installed: false,
  bytes: 0,
  offer: { source: 'https://models.example/kokoro', bytes: 100, sizeMiB: 0 },
};

const fakeVoiceBridge = () => {
  let installed = false;
  let progress = (_bytes: number) => {};
  const previews: unknown[] = [];
  const playbackCommands: string[] = [];
  const engine: { summary: unknown } = { summary: undefined };
  const bridge: VoiceBridge = {
    check: async () => ({ providers: [{ ...VOICE_PROVIDER, installed }], cacheBytes: 0 }),
    download: async () => {
      progress(50);
      installed = true;
    },
    remove: async () => {
      installed = false;
    },
    preview: async (request) => {
      previews.push(request);
      return { chunks: [new Uint8Array([1])], synthesisMs: 5, cacheHit: false };
    },
    clearCache: async () => {},
    playback: async (command) => {
      playbackCommands.push(command);
      return true;
    },
    diagnostics: async () => engine.summary as never,
    onProgress: (listener) => {
      progress = listener;
    },
  };
  return { bridge, previews, playbackCommands, engine };
};

const spokenOutputs = (page: ReturnType<typeof fakePage>) =>
  page.sent
    .filter(({ type }) => type === 'SaveVoiceSettings')
    .map((command) => 'spokenOutput' in command && command.spokenOutput);

test('rpg-cm63.7 page turns voice on in one step and changes mode mid-campaign without restart', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  const played: number[] = [];
  const preferences: unknown[] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge, savePreferences: (saved) => preferences.push(saved) },
    audio: {
      play: async (_chunks, volume) => {
        played.push(volume);
        return { decodeMs: 1 };
      },
    },
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  assert.match(page.root.innerHTML, /data-voice-step="consent"/);
  assert.equal(page.focused.at(-1), '[data-voice-step] [data-primary]');
  page.click({ 'data-voice-setup': 'accept' });
  await settle();
  await settle();
  assert.match(page.root.innerHTML, /data-voice-step="ready"/);
  assert.deepEqual(voice.previews, [{ providerId: 'kokoro', voiceId: 'af_heart', language: 'en', speed: 1 }]);
  assert.deepEqual(played, [1]);
  assert.deepEqual(spokenOutputs(page), ['full']);
  page.click({ 'data-voice-setup': 'finish' });
  assert.doesNotMatch(page.root.innerHTML, /data-voice-step=/);
  assert.equal(page.focused.at(-1), '#settings-toggle');
  page.change({ 'data-voice-field': 'spokenOutput' }, 'cinematic');
  page.change({ 'data-voice-field': 'volume' }, '0.25');
  page.change({ 'data-voice-field': 'narratorVoice' }, 'am_adam');
  assert.deepEqual(spokenOutputs(page), ['full', 'cinematic']);
  assert.match(page.root.innerHTML, /<option value="cinematic" selected>/);
  assert.deepEqual((preferences.at(-1) as UiPreferences).speech, {
    volume: 0.25,
    npcVoices: {},
    narratorVoice: 'am_adam',
  });
  page.click({ 'data-voice-setup': 'off' });
  assert.deepEqual(spokenOutputs(page), ['full', 'cinematic', 'off']);
});

test('rpg-42a.145 voice download progress keeps keyboard focus on the dialog', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  let tick = (_bytes: number) => {};
  const bridge: VoiceBridge = {
    ...voice.bridge,
    download: () => new Promise<void>(() => {}),
    onProgress: (listener) => {
      tick = listener;
    },
  };
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, { bridge: { ...page.bridge, voice: bridge } });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  page.click({ 'data-voice-setup': 'accept' });
  await settle();
  assert.match(page.root.innerHTML, /data-voice-step="downloading"/);
  tick(10);
  await settle();
  const before = page.focused.length;
  tick(20);
  await settle();
  assert.equal(page.focused.length, before + 1);
  assert.equal(page.focused.at(-1), '[data-voice-step=""]');
});

test('rpg-cm63.7 page without a voice bridge keeps text play and reports voice unavailable', async () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  continueHarbor(page);
  await settle();
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  assert.match(page.root.innerHTML, /data-voice-step="unavailable"/);
  assert.deepEqual(spokenOutputs(page), []);
});

test('rpg-42a.40 desktop voice locale defaults to the campaign language when it has a voice', async () => {
  const page = fakePage();
  const voice = installedVoiceBridge();
  mount(page, { voice: { ...DEFAULT_PREFERENCES.voice, consent: CONSENT } }, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge },
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, language: 'pt-BR' } });
  await settle();
  assert.match(page.root.innerHTML, /<select id="voice-language"[^>]*>[\s\S]*?<option value="pt-BR" selected>/);
});

const installedVoiceBridge = () => {
  const voice = fakeVoiceBridge();
  return {
    ...voice,
    bridge: {
      ...voice.bridge,
      check: async () => ({ providers: [{ ...VOICE_PROVIDER, installed: true }], cacheBytes: 0 }),
    },
  };
};

test('rpg-cm63.15 page assigns a voice to a known character or to an Other name and previews a choice', async () => {
  const page = fakePage();
  const voice = installedVoiceBridge();
  const preferences: unknown[] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge, savePreferences: (saved) => preferences.push(saved) },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, speakers: [{ id: 'guard', name: 'Guard' }] } });
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  await settle();
  page.click({ 'data-voice-setup': 'finish' });
  assert.match(page.root.innerHTML, /<select id="voice-npc-speaker"><option value="Guard" selected>Guard<\/option>/);
  assert.doesNotMatch(page.root.innerHTML, /<option value="Ash"/);
  page.fields['#voice-npc-voice'] = 'am_adam';
  page.click({ 'data-voice-preview': 'character' });
  await settle();
  assert.equal((voice.previews.at(-1) as { voiceId: string }).voiceId, 'am_adam');
  page.fields['#voice-npc-speaker'] = 'Guard';
  page.fields['#voice-npc-name'] = 'Ignored';
  page.fields['#voice-npc-voice'] = 'am_adam';
  page.click({ 'data-voice-npc': 'add' });
  page.fields['#voice-npc-speaker'] = '';
  page.fields['#voice-npc-name'] = 'Wren';
  page.fields['#voice-npc-voice'] = 'af_heart';
  page.click({ 'data-voice-npc': 'add' });
  assert.deepEqual((preferences.at(-1) as UiPreferences).speech.npcVoices, {
    [CAMPAIGN]: { Guard: 'am_adam', Wren: 'af_heart' },
  });
  assert.doesNotMatch(page.root.innerHTML, /voice-npc-speaker/);
  const assigned = saves(page).at(-1);
  assert.ok(assigned?.type === 'SaveVoiceSettings');
  assert.deepEqual(assigned.npcVoices, {
    Guard: { providerId: 'kokoro', voiceId: 'am_adam' },
    Wren: { providerId: 'kokoro', voiceId: 'af_heart' },
  });
});

test('rpg-cm63.14 page forgets a deleted campaign voice overrides in the saved preferences', async () => {
  const page = fakePage();
  const voice = installedVoiceBridge();
  const preferences: unknown[] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge, savePreferences: (saved) => preferences.push(saved) },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, speakers: [{ id: 'guard', name: 'Guard' }] } });
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  await settle();
  page.click({ 'data-voice-setup': 'finish' });
  page.fields['#voice-npc-speaker'] = 'Guard';
  page.fields['#voice-npc-voice'] = 'am_adam';
  page.click({ 'data-voice-npc': 'add' });
  assert.deepEqual((preferences.at(-1) as UiPreferences).speech.npcVoices, { [CAMPAIGN]: { Guard: 'am_adam' } });
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  page.click({ 'data-home': 'delete', 'data-name': HARBOR });
  page.click({ 'data-home': 'confirm' });
  assert.deepEqual((preferences.at(-1) as UiPreferences).speech.npcVoices, {});
});

test('rpg-cm63.14 page keys NPC voices by the current snapshot while a voice save is pending', async () => {
  const page = fakePage();
  const voice = installedVoiceBridge();
  const preferences: unknown[] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge, savePreferences: (saved) => preferences.push(saved) },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  continueHarbor(page);
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  await settle();
  page.click({ 'data-voice-setup': 'finish' });
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.change({ 'data-voice-field': 'spokenOutput' }, 'cinematic');
  await settle();
  assert.ok(saves(page).length > 0);
  const other = 'c2';
  const ember = { id: other, name: 'Ember' };
  page.click({ 'data-home': 'continue', 'data-name': ember.name });
  page.receive({
    type: 'Changed',
    command: page.sent.findLast(({ type }) => type === 'OpenCampaign'),
    result: { ok: true, value: ember },
  });
  page.receive({
    type: 'Snapshot',
    snapshot: { ...SNAPSHOT, campaignId: other, revision: 2, speakers: [{ id: 'guard', name: 'Guard' }] },
  });
  page.fields['#voice-npc-speaker'] = 'Guard';
  page.fields['#voice-npc-voice'] = 'am_adam';
  page.click({ 'data-voice-npc': 'add' });
  assert.deepEqual((preferences.at(-1) as UiPreferences).speech.npcVoices, { [other]: { Guard: 'am_adam' } });
});

test('rpg-cm63.14 page forgets an archived deleted campaign voice overrides', async () => {
  const page = fakePage();
  const voice = installedVoiceBridge();
  const preferences: unknown[] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge, savePreferences: (saved) => preferences.push(saved) },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, speakers: [{ id: 'guard', name: 'Guard' }] } });
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  await settle();
  page.click({ 'data-voice-setup': 'finish' });
  page.fields['#voice-npc-speaker'] = 'Guard';
  page.fields['#voice-npc-voice'] = 'am_adam';
  page.click({ 'data-voice-npc': 'add' });
  page.receive({ type: 'Campaigns', campaigns: [], archived: [SNAPSHOT.campaign] });
  page.click({ 'data-home': 'delete', 'data-name': HARBOR, 'data-archived': '' });
  page.click({ 'data-home': 'confirm' });
  assert.deepEqual((preferences.at(-1) as UiPreferences).speech.npcVoices, {});
});

test('rpg-cm63.17 page sends pause, resume, skip and stop to the engine from the voice controls', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  page.click({ 'data-voice-setup': 'accept' });
  await settle();
  await settle();
  page.click({ 'data-voice-setup': 'finish' });
  for (const command of ['pause', 'resume', 'skip', 'stop']) page.click({ 'data-voice-playback': command });
  assert.deepEqual(voice.playbackCommands, ['pause', 'resume', 'skip', 'stop']);
});

test('rpg-cm63.13 page saves the sound toggle and volume per channel and shows them', () => {
  const saved: UiPreferences[] = [];
  const page = fakePage();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, savePreferences: (preferences: UiPreferences) => saved.push(preferences) },
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  assert.doesNotMatch(page.root.innerHTML, /data-sound-toggle="music" checked/);
  page.change({ 'data-sound-toggle': 'music' }, 'on', true);
  assert.deepEqual(saved.at(-1)?.sound.music, { enabled: true, volume: 0.5 });
  assert.match(page.root.innerHTML, /data-sound-toggle="music" checked/);
  page.change({ 'data-sound-volume': 'music' }, '0.25');
  assert.deepEqual(saved.at(-1)?.sound.music, { enabled: true, volume: 0.25 });
  assert.match(page.root.innerHTML, /id="sound-music-volume" type="range" min="0" max="1" step="0.05" value="0.25"/);
  assert.equal(saved.at(-1)?.sound.ambience.enabled, false);
  page.change({ 'data-sound-toggle': 'music' }, 'off', false);
  assert.equal(saved.at(-1)?.sound.music.enabled, false);
});

test('rpg-cm63.13 page ignores an unknown sound channel and an out-of-range volume', () => {
  const saved: UiPreferences[] = [];
  const page = fakePage();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, savePreferences: (preferences: UiPreferences) => saved.push(preferences) },
  });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.change({ 'data-sound-toggle': 'thunder' }, 'on', true);
  page.change({ 'data-sound-volume': 'music' }, '7');
  page.change({ 'data-sound-volume': 'music' }, 'loud');
  assert.deepEqual(saved, []);
});

test('rpg-cm63.22 page refreshes the engine speech metrics in troubleshooting when a new revision arrives', async () => {
  const page = fakePage();
  const voice = installedVoiceBridge();
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  assert.doesNotMatch(page.root.innerHTML, /Spoken replies/);
  voice.engine.summary = { samples: 2, cacheHitRate: 0, errors: {}, stages: {}, peakQueueDepth: 3 };
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, revision: SNAPSHOT.revision + 1 } });
  await settle();
  assert.match(page.root.innerHTML, /<dt>Spoken replies<\/dt><dd>2<\/dd>/);
  assert.match(page.root.innerHTML, /<dt>Peak speech queue<\/dt><dd>3<\/dd>/);
});

test('rpg-42a.67 page sends SetCampaignLanguage when a story language is chosen and ignores unknown ones', () => {
  const page = playingSheet();
  page.click({ 'data-story-language': 'es' });
  page.click({ 'data-story-language': 'xx' });
  const sets = page.sent.filter(({ type }) => type === 'SetCampaignLanguage');
  assert.equal(sets.length, 1);
  assert.ok(sets[0]?.type === 'SetCampaignLanguage');
  assert.equal(sets[0].language, 'es');
});

const MUSIC_ON = { ...DEFAULT_SOUND_SETTINGS, music: { enabled: true, volume: 0.25 } };
const PREVIEW_MS = 2000;

const fakeSound = () => {
  const calls: unknown[][] = [];
  const sound: DesktopSound = {
    update: (settings, scene, sceneId) =>
      calls.push(sceneId === undefined ? ['update', settings, scene] : ['update', settings, scene, sceneId]),
    speaking: (active) => calls.push(['speaking', active]),
    refresh: async () => {
      calls.push(['refresh']);
    },
    dispose: () => {},
  };
  const last = (name: string) => calls.filter(([call]) => call === name).at(-1);
  return { sound, last, speaking: () => last('speaking')?.[1] };
};

test('rpg-cm63.33 page hands the saved sound settings and the scene to playback only while a campaign is open', () => {
  const page = fakePage();
  const { sound, last } = fakeSound();
  mount(page, { sound: MUSIC_ON }, deniedMicrophone, undefined, WIDE_WIDTH, { sound });
  assert.deepEqual(last('update'), ['update', MUSIC_ON, undefined]);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.deepEqual(last('update'), ['update', MUSIC_ON, { location: 'docks', mood: ['docks'] }, 's1']);
});

test('rpg-cm63.41 page prefers the persisted location kind and mood tags over the scene title', () => {
  const page = fakePage();
  const { sound, last } = fakeSound();
  mount(page, { sound: MUSIC_ON }, deniedMicrophone, undefined, WIDE_WIDTH, { sound });
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  const currentScene = { ...SNAPSHOT.currentScene, locationKind: 'tavern', moodTags: ['tense'] };
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, currentScene } });
  assert.deepEqual(last('update'), ['update', MUSIC_ON, { location: 'tavern', mood: ['tense'] }, 's1']);
});

test('rpg-cm63.33 page ducks the background while a voice preview plays and releases it afterwards', async () => {
  const page = fakePage();
  const { sound, speaking } = fakeSound();
  const voice = installedVoiceBridge();
  const scheduled: [() => void, number][] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge },
    audio: { play: async () => ({ decodeMs: 1, durationMs: PREVIEW_MS }) },
    schedule: (run, ms) => scheduled.push([run, ms]),
    sound,
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.click({ 'data-voice-setup': 'on' });
  await settle();
  page.click({ 'data-voice-setup': 'accept' });
  await settle();
  await settle();
  assert.equal(speaking(), true);
  const release = scheduled.findLast(([, ms]) => ms === PREVIEW_MS + DUCK_RELEASE_MS);
  assert.ok(release);
  release[0]();
  assert.equal(speaking(), false);
});

test('rpg-cm63.39 page downloads the sound pack only after consent, then refreshes playback', async () => {
  const page = fakePage();
  const { sound, last } = fakeSound();
  const downloads: unknown[] = [];
  let installed = false;
  const offer = { source: 'https://cdn.example.org/sounds', bytes: 40_894_464, sizeMiB: 39 };
  const soundBridge: NonNullable<PageOptions['bridge']['sound']> = {
    status: async () => ({ installed, bytes: 0, offer }),
    download: async (consent) => {
      downloads.push(consent);
      installed = true;
    },
    file: async () => undefined,
    onProgress: () => {},
    onSpeaking: () => {},
  };
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, { bridge: { ...page.bridge, sound: soundBridge }, sound });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.click({ 'data-sound-setup': 'accept' });
  await settle();
  assert.deepEqual(downloads, []);
  page.focused.length = 0;
  page.click({ 'data-sound-setup': 'download' });
  assert.equal(page.focused.at(-1), '[data-sound-setup="accept"]');
  assert.match(page.root.innerHTML, /39 MB/);
  assert.deepEqual(downloads, []);
  page.click({ 'data-sound-setup': 'accept' });
  await settle();
  assert.deepEqual(downloads, [{ accepted: true, ...offer }]);
  assert.deepEqual(last('refresh'), ['refresh']);
  assert.match(page.root.innerHTML, /Sound pack installed/);
});

const soundPackPage = async (installed: boolean) => {
  const page = fakePage();
  const { sound } = fakeSound();
  const downloads: unknown[] = [];
  const offer = { source: 'https://cdn.example.org/sounds', bytes: 40_894_464, sizeMiB: 39 };
  const soundBridge: NonNullable<PageOptions['bridge']['sound']> = {
    status: async () => ({ installed, bytes: 0, offer }),
    download: async (consent) => {
      downloads.push(consent);
    },
    file: async () => undefined,
    onProgress: () => {},
    onSpeaking: () => {},
  };
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, { bridge: { ...page.bridge, sound: soundBridge }, sound });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  return { page, downloads };
};

test('rpg-cm63.68 turning a sound channel on without the pack asks for download consent and downloads nothing', async () => {
  const { page, downloads } = await soundPackPage(false);
  assert.doesNotMatch(page.root.innerHTML, /data-sound-setup="accept"/);
  page.change({ 'data-sound-toggle': 'ambience' }, 'on', true);
  assert.match(page.root.innerHTML, /data-sound-setup="accept"/);
  assert.deepEqual(downloads, []);
});

test('rpg-cm63.68 turning a sound channel off or on with the pack installed asks for nothing', async () => {
  const missing = await soundPackPage(false);
  missing.page.change({ 'data-sound-toggle': 'ambience' }, 'off', false);
  assert.doesNotMatch(missing.page.root.innerHTML, /data-sound-setup="accept"/);
  const installed = await soundPackPage(true);
  installed.page.change({ 'data-sound-toggle': 'ambience' }, 'on', true);
  assert.doesNotMatch(installed.page.root.innerHTML, /data-sound-setup="accept"/);
});

test('rpg-cm63.39 page keeps the typed entry and its focus when the sound download settles in the background', async () => {
  const page = fakePage();
  const { sound } = fakeSound();
  let finish: () => void = () => {};
  const offer = { source: 'https://cdn.example.org/sounds', bytes: 40_894_464, sizeMiB: 39 };
  const soundBridge: NonNullable<PageOptions['bridge']['sound']> = {
    status: async () => ({ installed: false, bytes: 0, offer }),
    download: () => new Promise<void>((resolve) => (finish = resolve)),
    file: async () => undefined,
    onProgress: () => {},
    onSpeaking: () => {},
  };
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, { bridge: { ...page.bridge, sound: soundBridge }, sound });
  page.receive(READY);
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  await settle();
  page.click({ 'data-sound-setup': 'download' });
  page.click({ 'data-sound-setup': 'accept' });
  page.root.querySelector(ENTRY)?.focus();
  page.fields[ENTRY] = 'I open the door';
  page.focused.length = 0;
  finish();
  await settle();
  assert.equal(page.fields[ENTRY], 'I open the door');
  assert.equal(page.focused.at(-1), ENTRY);
});

test('rpg-42a.74 page accepts the roll offer from its button', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({
    type: 'Snapshot',
    snapshot: {
      ...SNAPSHOT,
      rollOffer: { offerId: 'tam-attack', ruleId: 'attack.melee', target: 'Old Tam', label: 'Attack' },
    },
  });
  assert.match(page.root.innerHTML, /data-roll-offer="tam-attack"/);
  page.click({ 'data-roll-offer': 'tam-attack' });
  const command = page.sent.findLast(({ type }) => type === 'SubmitPlayerAction');
  assert.ok(command && 'rollOfferId' in command);
  assert.equal(command.rollOfferId, 'tam-attack');
});

test('rpg-42a.153 the roll offer never takes focus when it appears or when the page re-renders', () => {
  const OFFER = '[data-roll-offer';
  const tookFocus = (page: ReturnType<typeof fakePage>) => page.focused.some((selector) => selector.startsWith(OFFER));
  const idle = fakePage();
  startPlay(idle, SNAPSHOT);
  idle.receive({ type: 'Snapshot', snapshot: OFFER_SNAPSHOT });
  idle.receive({ type: 'Snapshot', snapshot: OFFER_SNAPSHOT });
  assert.equal(tookFocus(idle), false);
  const empty = fakePage();
  startPlay(empty, SNAPSHOT);
  empty.typingInAction = true;
  empty.receive({ type: 'Snapshot', snapshot: OFFER_SNAPSHOT });
  assert.equal(tookFocus(empty), false);
  const typing = fakePage();
  startPlay(typing, SNAPSHOT);
  typing.typingInAction = true;
  typing.typeAction('I open');
  typing.receive({ type: 'Snapshot', snapshot: OFFER_SNAPSHOT });
  assert.equal(tookFocus(typing), false);
});

test('rpg-42a.153 Enter in an empty action box or on the page never accepts a roll offer', async () => {
  const page = fakePage();
  startPlay(page, OFFER_SNAPSHOT);
  page.input.value = '';
  page.elements.form.requestSubmit();
  page.press('Enter');
  page.press('Enter', { 'data-region': 'conversation' });
  page.keyInInput('Enter');
  await settle();
  assert.deepEqual(submitted(page), []);
  assert.equal(page.sent.filter((command) => 'rollOfferId' in command).length, 0);
});

test('rpg-42a.101 page retries a failed narration from the notice button', async () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.input.value = 'look around';
  page.press('Enter');
  await settle();
  const first = page.sent.findLast(({ type }) => type === 'SubmitPlayerAction');
  assert.ok(first?.type === 'SubmitPlayerAction');
  page.receive({ type: 'NarrationFailed', actionId: first.actionId, failure: { kind: 'auth' } });
  page.receive({ type: 'Accepted', actionId: first.actionId });
  page.receive({
    type: 'Snapshot',
    snapshot: {
      ...SNAPSHOT,
      revision: 2,
      turns: [
        {
          id: 't0',
          campaignId: CAMPAIGN,
          sceneId: 's1',
          actionId: first.actionId,
          actorId: 'hero',
          input: 'look around',
          narration: '',
        },
      ],
    },
  });
  assert.match(page.root.innerHTML, /data-retry-turn/);
  const before = page.sent.length;
  page.click({ 'data-retry-turn': '' });
  const retried = page.sent.slice(before).find(({ type }) => type === 'SubmitPlayerAction');
  assert.ok(retried?.type === 'SubmitPlayerAction' && retried.actionId === first.actionId);
});

const startPlay = (
  page: ReturnType<typeof fakePage>,
  snapshot: object = SNAPSHOT,
  saved: Partial<UiPreferences> = {},
) => {
  mount(page, saved);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot });
};

const OFFER_SNAPSHOT = {
  ...SNAPSHOT,
  rollOffer: { offerId: 'tam-attack', ruleId: 'attack.melee', target: 'Old Tam', label: 'Attack' },
};

test('rpg-42a.93 typing a slash opens an ARIA listbox that filters as you type and announces the count', () => {
  const page = fakePage();
  startPlay(page);
  page.typeAction('/');
  assert.equal(page.inputAttributes['aria-expanded'], 'true');
  assert.equal(page.inputAttributes['aria-activedescendant'], 'slash-option-gm');
  assert.equal(page.menu.hidden, false);
  assert.match(page.menu.innerHTML, /role="option" id="slash-option-gm" aria-selected="true"/);
  assert.match(page.menu.innerHTML, /\/gm[\s\S]*&lt;message&gt;[\s\S]*Talk to the GM out of character\./);
  assert.match(page.menu.innerHTML, /id="slash-option-roll" aria-selected="false"/);
  assert.equal(page.status.textContent, '2 commands available');
  page.typeAction('/ro');
  assert.doesNotMatch(page.menu.innerHTML, /slash-option-gm/);
  assert.equal(page.inputAttributes['aria-activedescendant'], 'slash-option-roll');
  assert.equal(page.status.textContent, '1 command available');
  page.typeAction('/zzz');
  assert.equal(page.status.textContent, 'No matching command');
  assert.equal(page.inputAttributes['aria-expanded'], 'false');
  page.typeAction('look around');
  assert.equal(page.menu.hidden, true);
  assert.equal(page.status.textContent, '');
  assert.equal(page.inputAttributes['aria-activedescendant'], undefined);
});

test('rpg-42a.93 Up and Down move the active option, Tab completes and Escape closes', () => {
  const page = fakePage();
  startPlay(page);
  page.typeAction('/');
  assert.equal(page.keyInInput('ArrowDown').key, 'ArrowDown');
  assert.equal(page.inputAttributes['aria-activedescendant'], 'slash-option-roll');
  page.keyInInput('ArrowDown');
  assert.equal(page.inputAttributes['aria-activedescendant'], 'slash-option-gm');
  page.keyInInput('ArrowUp');
  assert.equal(page.inputAttributes['aria-activedescendant'], 'slash-option-roll');
  page.keyInInput('Tab');
  assert.equal(page.input.value, '/roll ');
  assert.equal(page.menu.hidden, true);
  page.typeAction('/');
  page.keyInInput('Escape');
  assert.equal(page.inputAttributes['aria-expanded'], 'false');
  assert.equal(page.input.value, '/');
  assert.equal(page.keyInInput('Escape').key, 'Escape');
});

test('rpg-42a.93 Enter or a click on an option runs a command without arguments and completes one with arguments', () => {
  const page = fakePage();
  startPlay(page, OFFER_SNAPSHOT);
  page.typeAction('/ro');
  page.keyInInput('Enter');
  const roll = page.sent.findLast(({ type }) => type === 'SubmitPlayerAction');
  assert.ok(roll && 'rollOfferId' in roll);
  assert.equal(roll.rollOfferId, 'tam-attack');
  page.typeAction('/');
  page.keyInInput('Enter');
  assert.equal(page.input.value, '/gm ');
  assert.equal(page.sent.filter(({ type }) => type === 'SubmitOocMessage').length, 0);
  page.typeAction('/');
  page.clickOption('gm');
  assert.equal(page.input.value, '/gm ');
});

test('rpg-42a.93 an unknown slash command shows a localized hint and is never sent to the GM', async () => {
  const page = fakePage();
  startPlay(page);
  page.input.value = '/x marks the spot';
  page.elements.form.requestSubmit();
  await settle();
  assert.match(page.hint.textContent, /Unknown command \/x\. It was not sent to the GM/);
  assert.equal(page.input.value, '/x marks the spot');
  assert.deepEqual(submitted(page), []);
  assert.equal(page.sent.filter(({ type }) => type === 'SubmitOocMessage').length, 0);
  page.typeAction('look');
  assert.equal(page.hint.textContent, '');
});

test('rpg-42a.93 the localized command name works and the English name works in every locale', async () => {
  const page = fakePage();
  startPlay(page, OFFER_SNAPSHOT, { locale: 'pt-BR' });
  page.typeAction('/');
  assert.match(page.menu.innerHTML, /\/rolar/);
  assert.equal(page.status.textContent, '2 comandos disponíveis');
  for (const typed of ['/rolar', '/roll']) {
    page.input.value = typed;
    page.elements.form.requestSubmit();
    await settle();
  }
  assert.equal(page.sent.filter((command) => 'rollOfferId' in command).length, 2);
});

test('rpg-42a.88 page lists the installed narrator voices on the begin step, previews one and keeps the pick', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  const preferences: { speech?: { narratorVoice?: string } }[] = [];
  const BEGIN: StartDraft = {
    ...INITIAL_DRAFT,
    path: 'guide',
    step: GUIDE_STEPS.indexOf('begin'),
    choices: { voiceOutput: true },
  };
  mount(page, {}, deniedMicrophone, BEGIN, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: voice.bridge, savePreferences: (saved) => preferences.push(saved) },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  await settle();
  assert.match(page.root.innerHTML, /data-start-preview="4"/);
  page.change({ 'data-start-voice': '' }, '5');
  assert.match(page.root.innerHTML, /data-start-preview="5"/);
  page.click({ 'data-start-preview': '5' });
  await settle();
  assert.deepEqual(
    voice.previews.map((request) => (request as { voiceId: string }).voiceId),
    ['am_adam'],
  );
  assert.equal(preferences.at(-1)?.speech?.narratorVoice, 'am_adam');
  assert.equal(page.saved.at(-1)?.choices.narratorVoice, 'am_adam');
});

test('rpg-42a.99 page lists only voices of the chosen story language and defaults to that language narrator', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  const brazilian: VoiceProviderStatus = {
    ...VOICE_PROVIDER,
    id: 'kokoro-mlx',
    languages: ['pt-BR'],
    voices: ['pf_dora', 'pm_alex'],
    narrator: 'pf_dora',
    installed: true,
  };
  const both = async () => ({ providers: [{ ...VOICE_PROVIDER, installed: true }, brazilian], cacheBytes: 0 });
  const BEGIN: StartDraft = {
    ...INITIAL_DRAFT,
    path: 'guide',
    step: GUIDE_STEPS.indexOf('begin'),
    choices: { voiceOutput: true, language: 'pt-BR' },
  };
  mount(page, {}, deniedMicrophone, BEGIN, WIDE_WIDTH, {
    bridge: { ...page.bridge, voice: { ...voice.bridge, check: both } },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  await settle();
  assert.match(page.root.innerHTML, /<option value="\d+" selected>Dora/);
  assert.doesNotMatch(page.root.innerHTML, /Heart|Adam/);
});

test('rpg-asjw.22 page defaults the guided start narrator to the interface language when no story language is chosen', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  const brazilian: VoiceProviderStatus = {
    ...VOICE_PROVIDER,
    id: 'kokoro-mlx',
    languages: ['pt-BR'],
    voices: ['pf_dora', 'pm_alex'],
    narrator: 'pf_dora',
    installed: true,
  };
  const both = async () => ({ providers: [{ ...VOICE_PROVIDER, installed: true }, brazilian], cacheBytes: 0 });
  const BEGIN: StartDraft = {
    ...INITIAL_DRAFT,
    path: 'guide',
    step: GUIDE_STEPS.indexOf('begin'),
    choices: { voiceOutput: true },
  };
  mount(
    page,
    { locale: 'pt-BR', voice: { ...DEFAULT_PREFERENCES.voice, locale: 'en' } },
    deniedMicrophone,
    BEGIN,
    WIDE_WIDTH,
    {
      bridge: { ...page.bridge, voice: { ...voice.bridge, check: both } },
      audio: { play: async () => ({ decodeMs: 1 }) },
    },
  );
  page.receive(READY);
  await settle();
  assert.match(page.root.innerHTML, /<option value="\d+" selected>Dora/);
  assert.doesNotMatch(page.root.innerHTML, /Heart|Adam/);
});

test('rpg-42a.99 page previews and keeps a story-language voice while the voice locale differs', async () => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  const preferences: { speech?: { narratorVoice?: string } }[] = [];
  const brazilian: VoiceProviderStatus = {
    ...VOICE_PROVIDER,
    id: 'kokoro-mlx',
    languages: ['pt-BR'],
    voices: ['pf_dora', 'pm_alex'],
    narrator: 'pf_dora',
    installed: true,
  };
  const both = async () => ({ providers: [{ ...VOICE_PROVIDER, installed: true }, brazilian], cacheBytes: 0 });
  const BEGIN: StartDraft = {
    ...INITIAL_DRAFT,
    path: 'guide',
    step: GUIDE_STEPS.indexOf('begin'),
    choices: { voiceOutput: true, language: 'pt-BR' },
  };
  mount(page, {}, deniedMicrophone, BEGIN, WIDE_WIDTH, {
    bridge: {
      ...page.bridge,
      voice: { ...voice.bridge, check: both },
      savePreferences: (saved) => preferences.push(saved),
    },
    audio: { play: async () => ({ decodeMs: 1 }) },
  });
  page.receive(READY);
  await settle();
  page.change({ 'data-start-voice': '' }, '5');
  page.click({ 'data-start-preview': '5' });
  await settle();
  const request = voice.previews.at(-1) as { voiceId: string; providerId: string; language: string };
  assert.deepEqual([request.voiceId, request.providerId, request.language], ['pm_alex', 'kokoro-mlx', 'pt-BR']);
  assert.equal(preferences.at(-1)?.speech?.narratorVoice, 'pm_alex');
});

const REPLAY_TURN = {
  id: 't1',
  campaignId: CAMPAIGN,
  sceneId: 's1',
  actionId: 'r1',
  actorId: 'hero',
  input: 'look',
  narration: 'The gate opens.',
};
const REPLAY_BUTTON = { 'data-replay': 'r1' };

const replayPage = async (
  spoken: boolean,
  turn: object = REPLAY_TURN,
  speakers: readonly object[] = [],
  language?: string,
) => {
  const page = fakePage();
  const voice = fakeVoiceBridge();
  const stops: string[] = [];
  const timers: (() => void)[] = [];
  mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    bridge: {
      ...page.bridge,
      voice: {
        ...voice.bridge,
        check: async () => {
          const { providers, cacheBytes } = await voice.bridge.check();
          return {
            providers: providers.map((provider) => ({
              ...provider,
              languages: [...provider.languages, ...(language === undefined ? [] : [language])],
            })),
            cacheBytes,
          };
        },
      },
    },
    audio: { play: async () => ({ decodeMs: 1, durationMs: 10 }), stop: () => stops.push('stop') },
    schedule: (run) => timers.push(run),
  });
  page.receive(READY);
  continueHarbor(page);
  page.receive({
    type: 'Snapshot',
    snapshot: {
      ...SNAPSHOT,
      speakers,
      turns: [turn],
      ...(language === undefined ? {} : { language, voice: { ...DEFAULT_PREFERENCES.voice, locale: 'en' } }),
    },
  });
  await settle();
  if (spoken) {
    page.click({ 'data-voice-setup': 'on' });
    await settle();
    page.click({ 'data-voice-setup': 'accept' });
    await settle();
    await settle();
    page.click({ 'data-voice-setup': 'finish' });
  }
  const replays = () => voice.previews.filter((request) => (request as { text?: string }).text !== undefined);
  return { page, voice, stops, timers, replays };
};

test('rpg-cm63.46 page replays a narration turn through the voice bridge and stops on a second press or Escape', async () => {
  const { page, voice, stops, timers, replays } = await replayPage(true);
  assert.match(page.root.innerHTML, /data-replay="r1" aria-label="Play this passage"/);
  page.click(REPLAY_BUTTON);
  await settle();
  assert.deepEqual(replays(), [
    {
      providerId: 'kokoro',
      voiceId: 'af_heart',
      language: 'en',
      speed: 1,
      text: 'The gate opens.',
      style: '',
      pronunciations: {},
    },
  ]);
  assert.deepEqual(voice.playbackCommands, ['stop']);
  assert.match(page.root.innerHTML, /aria-label="Stop this passage"/);
  page.click(REPLAY_BUTTON);
  assert.deepEqual(stops, ['stop']);
  assert.match(page.root.innerHTML, /aria-label="Play this passage"/);
  page.click(REPLAY_BUTTON);
  await settle();
  page.press('Escape');
  assert.equal(stops.length, 2);
  assert.match(page.root.innerHTML, /aria-label="Play this passage"/);
  for (const run of timers.splice(0)) run();
  await settle();
  assert.equal(replays().length, 2);
});

test('rpg-42a.111 page replays in the campaign story language when it differs from the voice locale', async () => {
  const { page, replays } = await replayPage(true, REPLAY_TURN, [], 'pt-BR');
  page.click(REPLAY_BUTTON);
  await settle();
  assert.equal((replays()[0] as { language: string }).language, 'pt-BR');
});

test('rpg-cm63.50 page replays narration longer than the speech limit as several requests', async () => {
  const sentence = `${'a'.repeat(1999)}. `;
  const { page, replays } = await replayPage(true, { ...REPLAY_TURN, narration: sentence.repeat(3).trim() });
  page.click(REPLAY_BUTTON);
  await settle();
  assert.equal(replays().length, 1);
  assert.equal((replays()[0] as { text: string }).text, sentence.trim());
});

test('rpg-cm63.66 page keeps the replay button when no voice is installed and opens voice setup on press', async () => {
  const { page, replays } = await replayPage(false);
  assert.match(page.root.innerHTML, /data-replay="r1"/);
  assert.doesNotMatch(page.root.innerHTML, /data-voice-step/);
  page.click(REPLAY_BUTTON);
  await settle();
  assert.match(page.root.innerHTML, /data-voice-step="consent"/);
  assert.deepEqual(replays(), []);
});

test('rpg-cm63.66 page keeps the replay button and plays when spoken output is off', async () => {
  const { page, replays } = await replayPage(true);
  page.click({ 'data-voice-setup': 'off' });
  await settle();
  assert.match(page.root.innerHTML, /data-replay="r1"/);
  page.click(REPLAY_BUTTON);
  await settle();
  assert.equal(replays().length, 1);
});

const SEGMENT_DELIVERY = { emotion: 'angry' };

const replayedSegments = async (mode?: string) => {
  const turn = {
    ...REPLAY_TURN,
    segments: [
      { text: 'The gate opens.' },
      { speakerId: 'guard', text: 'Halt!', delivery: SEGMENT_DELIVERY },
      { speakerId: 'stranger', text: 'Easy.' },
    ],
  };
  const { page, replays, timers } = await replayPage(true, turn, [
    { id: 'guard', name: 'Guard' },
    { id: 'stranger', name: 'Stranger' },
  ]);
  page.fields['#voice-npc-speaker'] = 'Guard';
  page.fields['#voice-npc-voice'] = 'am_adam';
  page.click({ 'data-voice-npc': 'add' });
  if (mode !== undefined) {
    page.change({ 'data-voice-field': 'spokenOutput' }, mode);
    await settle();
  }
  page.click(REPLAY_BUTTON);
  for (let line = 0; line < 3; line += 1) {
    await settle();
    for (const run of timers.splice(0)) run();
  }
  await settle();
  return replays().map((request) => {
    const { voiceId, text, delivery } = request as { voiceId: string; text: string; delivery?: object };
    return [voiceId, text, delivery];
  });
};

test('rpg-cm63.49 page replays every stored segment with the voice assigned to its speaker, without delivery', async () => {
  assert.deepEqual(await replayedSegments(), [
    ['af_heart', 'The gate opens.', undefined],
    ['am_adam', 'Halt!', undefined],
    ['af_heart', 'Easy.', undefined],
  ]);
});

test('rpg-cm63.49 page replays the stored delivery only in cinematic output', async () => {
  assert.deepEqual(await replayedSegments('cinematic'), [
    ['af_heart', 'The gate opens.', undefined],
    ['am_adam', 'Halt!', SEGMENT_DELIVERY],
    ['af_heart', 'Easy.', undefined],
  ]);
});

const ROLL_REPORT_FORM = { 'data-roll-report-form': '' };
const ROLL_REPORT_INPUT = '#roll-report-input';
const PHYSICAL_OFFER = {
  offerId: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack',
  expression: '1d20',
};

test('rpg-42a.96 page sends the typed total with the offer id and ignores an empty field', () => {
  const page = playingSheet();
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, rollOffer: PHYSICAL_OFFER } });
  page.fields[ROLL_REPORT_INPUT] = '';
  page.submit(ROLL_REPORT_FORM);
  assert.equal(
    page.sent.some((command) => 'reportedRoll' in command),
    false,
  );
  page.fields[ROLL_REPORT_INPUT] = '14';
  page.submit(ROLL_REPORT_FORM);
  const command = page.sent.findLast(({ type }) => type === 'SubmitPlayerAction');
  assert.ok(command && 'reportedRoll' in command);
  assert.deepEqual(command.reportedRoll, [14]);
  assert.equal(command.rollOfferId, 'tam-attack');
});

test('rpg-42a.96 page saves who rolls with the GM form and omits it when left on the default', () => {
  const page = playingSheet();
  page.fields[GM_FIELD('whoRolls')] = 'me';
  page.submit(GM_FORM);
  page.fields[GM_FIELD('whoRolls')] = '';
  page.submit(GM_FORM);
  const saves = page.sent.filter(({ type }) => type === 'SaveGmSettings');
  assert.ok(saves[0]?.type === 'SaveGmSettings' && saves[1]?.type === 'SaveGmSettings');
  assert.equal(saves[0].whoRolls, 'me');
  assert.equal('whoRolls' in saves[1], false);
});

const MEMORY_FORM = { 'data-memory': 'correct', 'data-memory-index': '0' };
const MEMORY_INPUT = '#memory-panel-value-0';

test('rpg-42a.61 page sends the typed correction for a remembered fact and ignores an empty field', () => {
  const page = playingSheet();
  const fact = { entityId: 'p1', entityName: 'Mira', kind: 'alive', key: '', value: 'alive', corrected: false };
  const memory = { person: [fact], place: [], thread: [] };
  page.receive({
    type: 'StoryResult',
    command: 'GetStoryMemory',
    result: { ok: true, value: { version: 1, campaignId: CAMPAIGN, revision: 4, memory } },
  });
  page.fields[MEMORY_INPUT] = '';
  page.submit(MEMORY_FORM);
  assert.equal(
    page.sent.some(({ type }) => type === 'CorrectStoryFact'),
    false,
  );
  page.fields[MEMORY_INPUT] = 'dead';
  page.submit(MEMORY_FORM);
  const command = page.sent.findLast(({ type }) => type === 'CorrectStoryFact');
  assert.ok(command && 'entityId' in command);
  assert.equal(command.entityId, 'p1');
  assert.equal(command.value, 'dead');
});

test('rpg-42a.61 page keeps a half-typed correction when the view updates', () => {
  const page = playingSheet();
  const fact = { entityId: 'p1', entityName: 'Mira', kind: 'alive', key: '', value: 'alive', corrected: false };
  const memory = { person: [fact], place: [], thread: [] };
  page.receive({
    type: 'StoryResult',
    command: 'GetStoryMemory',
    result: { ok: true, value: { version: 1, campaignId: CAMPAIGN, revision: 4, memory } },
  });
  page.fields[MEMORY_INPUT] = 'dea';
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.equal(page.fields[MEMORY_INPUT], 'dea');
});

test('rpg-42a.68 page runs the import from the rules step buttons through the bridge', async () => {
  const page = fakePage();
  const requests: unknown[] = [];
  const results = [
    { status: 'preview', lines: ['Rule pack: d20-lite.'] },
    { status: 'declined', lines: ['Import declined.'] },
  ] as const;
  const atRules: StartDraft = {
    ...INITIAL_DRAFT,
    path: 'guide',
    step: GUIDE_STEPS.indexOf('rules'),
    choices: { ruleset: { id: 'd20-lite', edition: 'original' } },
  };
  mountPage({
    elements: page.elements,
    bridge: {
      ...page.bridge,
      importRulebook: async (request) => {
        requests.push(request);
        return results[requests.length - 1] ?? { status: 'cancelled' };
      },
    },
    search: `?${new URLSearchParams({
      [PREFERENCES_QUERY]: JSON.stringify(DEFAULT_PREFERENCES),
      [START_QUERY]: JSON.stringify(atRules),
    })}`,
    width: () => WIDE_WIDTH,
    newActionId: () => 'a',
    openMicrophone: deniedMicrophone,
  });
  page.receive(READY);
  page.click({ 'data-start-import': 'pick' });
  await settle();
  assert.match(page.root.innerHTML, /data-import-report/);
  page.click({ 'data-start-import': 'decline' });
  await settle();
  assert.deepEqual(requests, [
    { kind: 'pick', packId: 'd20-lite' },
    { kind: 'decide', decision: 'decline' },
  ]);
  assert.match(page.root.innerHTML, /Import declined\./);
});

test('rpg-42a.159 the play heading takes focus without the ring after a pointer load and with it after a keyboard load', () => {
  const pointer = fakePage();
  mount(pointer);
  pointer.receive(READY);
  pointer.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  pointer.pointerDown();
  continueHarbor(pointer);
  pointer.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.equal(pointer.focused.at(-1), '#heading-status');
  assert.deepEqual(pointer.focusOptions.at(-1), { focusVisible: false });

  const keyboard = fakePage();
  mount(keyboard);
  keyboard.receive(READY);
  keyboard.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  keyboard.keyDown();
  continueHarbor(keyboard);
  keyboard.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.equal(keyboard.focused.at(-1), '#heading-status');
  assert.deepEqual(keyboard.focusOptions.at(-1), { focusVisible: true });
});

test('rpg-42a.159 a load with no input yet does not draw the heading ring', () => {
  const page = fakePage();
  mount(page);
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  continueHarbor(page);
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  assert.deepEqual(page.focusOptions.at(-1), { focusVisible: false });
});
