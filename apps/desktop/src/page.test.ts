import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ClientCommand, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { MicrophoneState } from '../../../packages/voice/src/microphone.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE, type UiPreferences } from './accessibility.ts';
import { FONT_SCALE_PROPERTY, mountPage, type PageElements, type PageOptions } from './page.ts';
import { PREFERENCES_QUERY } from './preload.ts';
import type { Transport } from './renderer.ts';

const CAMPAIGN = 'c1';
const WIDE_WIDTH = 1600;
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

type Listener = (event: { target: unknown; key?: string; preventDefault(): void }) => void;

const target = (attributes: Record<string, string>) => ({
  closest: (selector: string) => {
    const name = /\[([a-z-]+)/.exec(selector)?.[1] ?? '';
    return Object.hasOwn(attributes, name) ? { getAttribute: (key: string) => attributes[key] ?? null } : null;
  },
});

const fakePage = () => {
  const listeners = new Map<string, Listener>();
  const style: Record<string, string> = {};
  const focused: string[] = [];
  const sent: ClientCommand[] = [];
  let onLine = (_line: string) => {};
  const bridge: Transport = {
    connect: () => {},
    send: (line) => {
      sent.push(JSON.parse(line) as ClientCommand);
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onClose: () => {},
  };
  const on = (prefix: string) => (type: string, listener: Listener) => listeners.set(prefix + type, listener);
  const elements = {
    root: {
      innerHTML: '',
      style: { setProperty: (name: string, value: string) => (style[name] = value) },
      addEventListener: on('root:'),
      querySelector: (selector: string) => ({
        setAttribute: () => {},
        focus: () => focused.push(selector),
      }),
    },
    form: { addEventListener: on('form:'), requestSubmit: () => listeners.get('form:submit')?.(event({})) },
    input: { value: '' },
    keys: { addEventListener: on('keys:') },
  };
  const event = (attributes: Record<string, string>, key?: string) => ({
    target: target(attributes),
    preventDefault: () => {},
    ...(key === undefined ? {} : { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }),
  });
  return {
    elements: elements as unknown as PageElements,
    root: elements.root,
    input: elements.input,
    bridge,
    sent,
    style,
    focused,
    receive: (message: object) => onLine(JSON.stringify(message)),
    click: (attributes: Record<string, string>) => listeners.get('root:click')?.(event(attributes)),
    press: (key: string) => listeners.get('keys:keydown')?.(event({}, key)),
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
) => {
  const preferences = { ...DEFAULT_PREFERENCES, fontScale: MAX_FONT_SCALE, ...saved };
  let actions = 0;
  return mountPage({
    elements: page.elements,
    bridge: page.bridge,
    search: `?${new URLSearchParams({ [PREFERENCES_QUERY]: JSON.stringify(preferences) })}`,
    width: () => WIDE_WIDTH,
    newActionId: () => `a${actions++}`,
    openMicrophone,
  });
};

const submitted = (page: ReturnType<typeof fakePage>) =>
  page.sent.filter(({ type }) => type === 'SubmitPlayerAction').map((command) => 'input' in command && command.input);

test('rpg-42a.7 page renders the view and drives the client through the bridge', async () => {
  const page = fakePage();
  mount(page);
  assert.match(page.root.innerHTML, /Connecting to engine/);
  assert.equal(page.style[FONT_SCALE_PROPERTY], String(MAX_FONT_SCALE));
  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  assert.match(page.root.innerHTML, /data-campaign="c1"/);
  page.click({ 'data-campaign': CAMPAIGN });
  assert.ok(page.sent.some((command) => command.type === 'SubscribeEvents'));
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.input.value = 'look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  assert.equal(page.input.value, '');
  page.press('Alt+2');
  assert.deepEqual(page.focused, ['[data-region="sheet"]']);
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
  assert.match(off.root.innerHTML, /data-region="voice"[^>]*>.*Voice off: type to play/);

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
  page.click({ 'data-campaign': CAMPAIGN });
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, voice: SAVED_VOICE } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  assert.match(page.root.innerHTML, /Audio unavailable \(permission-denied\); type instead/);
  assert.match(page.root.innerHTML, /Settings: microphone push-to-talk, output off, en, 1x/);
  page.input.value = 'set mic to off. look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  assert.equal(page.input.value, '');
  assert.match(page.root.innerHTML, /Voice off: type to play/);
  assert.doesNotMatch(page.root.innerHTML, /Audio unavailable/);
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
  page.click({ 'data-campaign': CAMPAIGN });
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
  assert.match(page.root.innerHTML, /Settings: microphone off/);
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
  page.click({ 'data-campaign': CAMPAIGN });
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
  assert.match(page.root.innerHTML, /Settings: microphone off/);
  const retry = saves(page).at(-1);
  assert.ok(retry?.type === 'SaveVoiceSettings' && retry !== first);
  assert.equal(retry.expectedRevision, SAVED_REVISION);
  assert.equal(retry.microphone, 'off');
  page.receive({ type: 'Accepted', actionId: retry.actionId });
  const off = { ...SAVED_VOICE, microphone: 'off' };
  page.receive({ type: 'Snapshot', snapshot: { ...SNAPSHOT, revision: SAVED_REVISION + 1, voice: off } });
  await settle();
  assert.deepEqual(opened, ['push-to-talk']);
  assert.match(page.root.innerHTML, /Settings: microphone off/);
  assert.equal(saves(page).length, 2);
});
