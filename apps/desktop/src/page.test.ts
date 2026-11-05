import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDE_STEPS, INITIAL_DRAFT, type StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import { type ClientCommand, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { MicrophoneState } from '../../../packages/voice/src/microphone.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE, type UiPreferences } from './accessibility.ts';
import { FONT_SCALE_PROPERTY, mountPage, type PageElements, type PageOptions } from './page.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import type { KeyEventLike } from './view.ts';

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
  const sent: ClientCommand[] = [];
  const saved: StartDraft[] = [];
  const fields: Record<string, string> = {};
  const selections: Record<string, [number, number]> = {};
  let prevented = 0;
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
      focus: () => {
        focused.push(selector);
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
  const on = (prefix: string) => (type: string, listener: Listener) => listeners.set(prefix + type, listener);
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
      querySelector: (selector: string) => (selector === FOCUSED ? active : node(selector)),
    },
    form: { addEventListener: on('form:'), requestSubmit: () => listeners.get('form:submit')?.(event({})) },
    input: { value: '' },
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
    bridge,
    sent,
    style,
    focused,
    saved,
    fields,
    selections,
    prevented: () => prevented,
    receive: (message: object) => onLine(JSON.stringify(message)),
    click: (attributes: Record<string, string>) => listeners.get('root:click')?.(event(attributes)),
    press: (key: string, attributes: Record<string, string> = {}, keys: Partial<KeyEventLike> = {}) =>
      listeners.get('keys:keydown')?.(event(attributes, key, keys)),
    submit: (attributes: Record<string, string>) => listeners.get('root:submit')?.(event(attributes)),
    type: () => listeners.get('root:input')?.(event({})),
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
    /<p data-voice-summary>Push to talk · Spoken output off · English · normal speed<\/p>/,
  );
  page.input.value = 'set mic to off. look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  assert.equal(page.input.value, '');
  assert.match(page.root.innerHTML, /<p data-voice-summary>Voice off · English · normal speed<\/p>/);
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
  assert.match(page.root.innerHTML, /<p data-voice-summary>Voice off · /);
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
  assert.match(page.root.innerHTML, /<p data-voice-summary>Voice off · /);
  const retry = saves(page).at(-1);
  assert.ok(retry?.type === 'SaveVoiceSettings' && retry !== first);
  assert.equal(retry.expectedRevision, SAVED_REVISION);
  assert.equal(retry.microphone, 'off');
  page.receive({ type: 'Accepted', actionId: retry.actionId });
  const off = { ...SAVED_VOICE, microphone: 'off' };
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, revision: SAVED_REVISION + 1, voice: off } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  assert.match(page.root.innerHTML, /<p data-voice-summary>Voice off · /);
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
  assert.match(page.root.innerHTML, /Step 1 of 6: What is a tabletop RPG\?/);
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

const MANY_CAMPAIGNS = 6;
const HOME_SEARCH = '#home-search';

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
  const schedule = (run: () => void) => {
    timers.push(run);
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

test('UI15: page settles only the roll it scheduled', () => {
  const timers: (() => void)[] = [];
  const page = fakePage();
  const client = mount(page, {}, deniedMicrophone, undefined, WIDE_WIDTH, {
    schedule: (run) => {
      timers.push(run);
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

test('rpg-42a.19 page keeps focus on the save button when the same step redraws', () => {
  const page = fakePage();
  mount(page, {}, deniedMicrophone, { ...INITIAL_DRAFT, path: 'describe' });
  assert.match(page.root.innerHTML, /<button type="submit" id="start-save">/);
  page.root.querySelector('#start-save')?.focus();
  page.focused.length = 0;
  page.receive(READY);
  assert.equal(page.focused.at(-1), '#start-save');
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
