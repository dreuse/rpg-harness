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
const settle = () => new Promise(setImmediate);
const deniedMicrophone: PageOptions['openMicrophone'] = () => ({ start: async () => DENIED, stop: () => {} });

const mount = (
  page: ReturnType<typeof fakePage>,
  saved: Partial<UiPreferences> = {},
  openMicrophone = deniedMicrophone,
) => {
  const preferences = { ...DEFAULT_PREFERENCES, fontScale: MAX_FONT_SCALE, ...saved };
  return mountPage({
    elements: page.elements,
    bridge: page.bridge,
    search: `?${new URLSearchParams({ [PREFERENCES_QUERY]: JSON.stringify(preferences) })}`,
    width: () => WIDE_WIDTH,
    newActionId: () => 'a0',
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
  assert.deepEqual(opened, ['push-to-talk']);
  await settle();
  assert.match(page.root.innerHTML, /Audio unavailable \(permission-denied\); type instead/);

  page.receive(READY);
  page.receive({ type: 'Campaigns', campaigns: [SNAPSHOT.campaign] });
  page.click({ 'data-campaign': CAMPAIGN });
  page.receive({ type: 'Snapshot', snapshot: SNAPSHOT });
  page.input.value = 'set mic to off. look around';
  page.press('Enter');
  await settle();
  assert.deepEqual(submitted(page), ['look around']);
  assert.equal(page.input.value, '');
  assert.match(page.root.innerHTML, /Voice off: type to play/);
  assert.doesNotMatch(page.root.innerHTML, /Audio unavailable/);
});
