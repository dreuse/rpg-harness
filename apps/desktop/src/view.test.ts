import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE, type RendererAction } from './accessibility.ts';
import { PREFERENCES_QUERY } from './preload.ts';
import { type DesktopState, initialState, viewModel } from './renderer.ts';
import { bindKeys, escapeHtml, keyName, queryPreferences, renderView } from './view.ts';

const WIDE_WIDTH = 1600;
const COMPACT_WIDTH = 480;
const CAMPAIGN = 'c1';
const HOSTILE = '<img src=x onerror="alert(1)">&\'';
const ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;';

const state: DesktopState = {
  ...initialState,
  connection: { status: 'disconnected', attempts: 1, lastError: HOSTILE },
  campaigns: [{ id: CAMPAIGN, name: HOSTILE }],
  selected: CAMPAIGN,
  snapshot: {
    version: PROTOCOL_VERSION,
    campaignId: CAMPAIGN,
    revision: 1,
    campaign: { id: CAMPAIGN, name: HOSTILE },
    characters: [],
    currentScene: undefined,
    turns: [
      {
        id: 't0',
        campaignId: CAMPAIGN,
        sceneId: 's1',
        actionId: 'a0',
        actorId: 'h',
        input: HOSTILE,
        narration: HOSTILE,
      },
    ],
  },
  views: { sheet: { campaignId: CAMPAIGN, viewId: 'sheet', components: [{ kind: 'field', id: 'n', label: HOSTILE }] } },
  panels: {
    version: PROTOCOL_VERSION,
    campaignId: CAMPAIGN,
    revision: 1,
    inventory: [{ id: 'rope', name: HOSTILE }],
    quests: [{ id: 'q', title: HOSTILE, status: 'open', objectives: [] }],
    citations: [],
    recap: { scene: HOSTILE, latest: undefined },
  },
  rejected: [{ actionId: 'a9', input: HOSTILE, message: HOSTILE }],
};

test('UI08 escapeHtml neutralises markup characters', () => {
  assert.equal(escapeHtml(HOSTILE), ESCAPED);
});

test('UI08 renderView escapes every untrusted text and labels regions', () => {
  const html = renderView(viewModel(state, WIDE_WIDTH), DEFAULT_PREFERENCES.locale);
  assert.doesNotMatch(html, /<img/);
  assert.equal(html.split(ESCAPED).length - 1, 10);
  for (const region of ['Campaigns', 'Engine status', 'Conversation', 'Character sheet', 'Panels'])
    assert.match(html, new RegExp(`aria-label="${region}"`));
  assert.match(html, /data-layout="wide"/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-action="retry"/);
  assert.ok(html.includes(`>${ESCAPED}: no value<`));
});

test('UI08 renderView follows layout, font scale and reduced motion', () => {
  const html = renderView(
    viewModel(state, COMPACT_WIDTH, { ...DEFAULT_PREFERENCES, fontScale: MAX_FONT_SCALE, reducedMotion: true }),
    DEFAULT_PREFERENCES.locale,
  );
  assert.match(html, /data-layout="compact"/);
  assert.match(html, new RegExp(`--font-scale: ${MAX_FONT_SCALE}`));
  assert.match(html, /data-animate="false"/);
  assert.doesNotMatch(html, /aria-label="Campaigns"/);
});

test('UI08 keyName joins modifiers in binding order', () => {
  assert.equal(keyName({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }), 'Enter');
  assert.equal(keyName({ key: '1', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false }), 'Alt+1');
  assert.equal(
    keyName({ key: 'Enter', altKey: false, ctrlKey: true, metaKey: false, shiftKey: true }),
    'Ctrl+Shift+Enter',
  );
});

const keydown = (key: string, altKey = false) => {
  let prevented = false;
  return {
    event: {
      key,
      altKey,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    },
    prevented: () => prevented,
  };
};

test('UI08 bindKeys runs bound renderer actions and respects the keyboard preference', () => {
  let listener = (_event: ReturnType<typeof keydown>['event']) => {};
  const target = {
    addEventListener: (type: string, given: typeof listener) => {
      assert.equal(type, 'keydown');
      listener = given;
    },
  };
  const ran: RendererAction[] = [];
  let preferences = DEFAULT_PREFERENCES;
  bindKeys(
    target,
    () => preferences,
    (action) => ran.push(action),
  );
  const focus = keydown('1', true);
  listener(focus.event);
  const plain = keydown('x');
  listener(plain.event);
  preferences = { ...DEFAULT_PREFERENCES, keyboard: false };
  const disabled = keydown('F5');
  listener(disabled.event);
  assert.deepEqual(ran, ['focusConversation']);
  assert.equal(focus.prevented(), true);
  assert.equal(plain.prevented(), false);
  assert.equal(disabled.prevented(), false);
});

test('UI08 queryPreferences reads the window query and falls back on bad input', () => {
  const saved = { ...DEFAULT_PREFERENCES, reducedMotion: true };
  const search = `?${new URLSearchParams({ [PREFERENCES_QUERY]: JSON.stringify(saved) })}`;
  assert.deepEqual(queryPreferences(search), saved);
  assert.deepEqual(queryPreferences(''), DEFAULT_PREFERENCES);
  assert.deepEqual(queryPreferences(`?${PREFERENCES_QUERY}=%7Bbroken`), DEFAULT_PREFERENCES);
});
