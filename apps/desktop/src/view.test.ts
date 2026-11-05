import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_DRAFT, START_STEPS, type StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE, type RendererAction } from './accessibility.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import { type DesktopState, initialState, viewModel } from './renderer.ts';
import { bindKeys, escapeHtml, KEEP_DEFAULT, keyName, queryPreferences, queryStart, renderView } from './view.ts';

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

const START_OPTIONS = {
  genres: [{ id: 'evil', name: HOSTILE, blurb: HOSTILE, characters: [{ name: HOSTILE, summary: HOSTILE }] }],
  rulesets: [{ id: 'narrative', edition: 'original', blurb: 'Light rules.', recommended: true, sheet: [] }],
};
const guideAt = (step: string, choices = {}): StartDraft => ({
  ...INITIAL_DRAFT,
  path: 'guide',
  step: START_STEPS.guide.indexOf(step as (typeof START_STEPS.guide)[number]),
  choices,
});
const startHtml = (draft: StartDraft, plan?: DesktopState['start']['plan']) =>
  renderView(
    viewModel({ ...initialState, start: { open: true, draft, options: START_OPTIONS, plan } }, WIDE_WIDTH),
    DEFAULT_PREFERENCES.locale,
  );

test('rpg-42a.14 guided start is a labelled region with a focusable step heading and named controls', () => {
  const closed = renderView(
    viewModel({ ...initialState, start: { ...initialState.start, created: HOSTILE } }, WIDE_WIDTH),
    'en',
  );
  assert.match(closed, /<section data-region="start" aria-label="New adventure">/);
  assert.match(closed, /<button type="button" data-start-open="open">New adventure<\/button>/);
  assert.ok(closed.includes(`<p role="status">Created campaign ${ESCAPED}.</p>`));
  const genre = startHtml(guideAt('genre', { genre: 'evil' }));
  assert.match(genre, /<h2 tabindex="-1" data-start-title="genre">Step 2 of 6: Pick a tone and genre<\/h2>/);
  assert.doesNotMatch(genre, /<img/);
  assert.match(genre, /data-start-option="0" aria-pressed="true"/);
  for (const control of ['back', 'skip', 'close']) assert.match(genre, new RegExp(`data-start-control="${control}">`));
  assert.doesNotMatch(genre, /data-start-control="start"/);
  const path = startHtml(INITIAL_DRAFT);
  assert.match(path, /data-start-option="1">Guide me - /);
  assert.doesNotMatch(path, /aria-pressed/);
  const character = startHtml(guideAt('character', { genre: 'evil' }));
  assert.match(
    character,
    /<label for="start-entry">Describe your character<\/label><input id="start-entry" name="start-entry" value="">/,
  );
  const summary = startHtml(guideAt('summary'), { ok: false, error: { code: 'UnknownEdition', message: HOSTILE } });
  assert.ok(summary.includes(`<p role="alert">Import your rulebook. ${ESCAPED}</p>`));
  assert.match(summary, /data-start-control="start" disabled>Start</);
});

test('rpg-42a.14 bindKeys keeps the browser default when the action asks for it', () => {
  let listener = (_event: ReturnType<typeof keydown>['event']) => {};
  bindKeys(
    { addEventListener: (_type: string, given: typeof listener) => (listener = given) },
    () => DEFAULT_PREFERENCES,
    () => KEEP_DEFAULT,
  );
  const enter = keydown('Enter');
  listener(enter.event);
  assert.equal(enter.prevented(), false);
});

test('rpg-42a.14 queryStart restores the saved wizard step and falls back on bad input', () => {
  const draft = guideAt('rules');
  assert.deepEqual(queryStart(`?${new URLSearchParams({ [START_QUERY]: JSON.stringify(draft) })}`), draft);
  assert.deepEqual(queryStart(''), INITIAL_DRAFT);
  assert.deepEqual(queryStart(`?${START_QUERY}=%7Bbroken`), INITIAL_DRAFT);
});

test('rpg-42a.14 keyName reads letter and digit keys from the physical key when Alt changes the character', () => {
  const alt = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(keyName({ ...alt, key: '˜', code: 'KeyN' }), 'Alt+N');
  assert.equal(keyName({ ...alt, key: 'n', code: 'KeyN' }), 'Alt+N');
  assert.equal(keyName({ ...alt, key: '¡', code: 'Digit1' }), 'Alt+1');
  assert.equal(keyName({ ...alt, altKey: false, key: 'Enter', code: 'Enter' }), 'Enter');
});
