import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_DRAFT, START_STEPS, type StartDraft } from '../../../packages/client-protocol/src/guided-start.ts';
import { type CampaignSummary, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import type { VisualizationEvent } from '../../../packages/client-protocol/src/visualization.ts';
import type { RulesUsage } from '../../../packages/domain/src/rules-usage.ts';
import { DEFAULT_PREFERENCES, MAX_FONT_SCALE, type RendererAction } from './accessibility.ts';
import { PREFERENCES_QUERY, START_QUERY } from './preload.ts';
import { type DesktopState, initialState, OPENING_ACTION_ID, PLAY_REGIONS, viewModel } from './renderer.ts';
import {
  bindKeys,
  cssEscape,
  escapeHtml,
  KEEP_DEFAULT,
  keyName,
  queryPreferences,
  queryStart,
  renderView,
} from './view.ts';
import type { DesktopVoiceView } from './voice.ts';

const WIDE_WIDTH = 1600;
const MEDIUM_WIDTH = 1000;
const COMPACT_WIDTH = 480;
const PID = 4242;
const DIAGNOSTICS = /<details data-diagnostics>[\s\S]*?<\/details>/;
const INTERNALS = /engine|process|\bpid\b|fake|4242/i;
const CAMPAIGN = 'c1';
const HOSTILE = '<img src=x onerror="alert(1)">&\'';
const ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;';

const state: DesktopState = {
  ...initialState,
  connection: { status: 'disconnected', attempts: 1, lastError: HOSTILE },
  campaigns: [
    {
      id: CAMPAIGN,
      name: HOSTILE,
      health: 'ok',
      lastPlayedAt: null,
      sceneTitle: null,
      characters: [],
      ruleset: null,
      genre: null,
      lastNarration: null,
      turnCount: 0,
    },
  ],
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
  assert.doesNotMatch(html, /data-region="campaigns"/);
  for (const [region, heading] of [
    ['conversation', 'Conversation'],
    ['sheet', 'Character sheet'],
    ['panels', 'Journal'],
  ])
    assert.match(
      html,
      new RegExp(
        `<section data-region="${region}" aria-labelledby="heading-${region}"><h2 id="heading-${region}">${heading}</h2>`,
      ),
    );
  assert.match(
    html,
    /<section data-region="status" aria-labelledby="heading-status"><button[^>]*data-nav="home"[^>]*>Home<\/button><hgroup><h1 id="heading-status" tabindex="-1">/,
  );
  assert.match(html, /data-layout="wide"/);
  assert.match(html, /role="status"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-action="retry"/);
  assert.ok(html.includes(`<dt>${ESCAPED}</dt><dd>no value</dd>`));
});

test('UI08 renderView follows layout, font scale and reduced motion', () => {
  const html = renderView(
    viewModel(state, COMPACT_WIDTH, { ...DEFAULT_PREFERENCES, fontScale: MAX_FONT_SCALE, reducedMotion: true }),
    DEFAULT_PREFERENCES.locale,
  );
  assert.match(html, /data-layout="compact"/);
  assert.match(html, new RegExp(`--font-scale: ${MAX_FONT_SCALE}`));
  assert.match(html, /data-animate="false"/);
  assert.doesNotMatch(html, /data-region="campaigns"/);
});

const connected = (status: DesktopState['connection']['status'], lastError?: string): DesktopState => ({
  ...initialState,
  connection: { status, attempts: 1, engine: { pid: PID, gm: 'fake' }, ...(lastError ? { lastError } : {}) },
});

test('rpg-42a.18 player-facing text has no PID, process or engine wording; details stay in diagnostics', () => {
  for (const status of ['connecting', 'connected', 'disconnected', 'reconnecting'] as const)
    for (const locale of ['en', 'es']) {
      const html = renderView(viewModel(connected(status, `Engine ${PID} exited.`), WIDE_WIDTH), locale);
      assert.doesNotMatch(html.replace(DIAGNOSTICS, ''), INTERNALS, `${status} ${locale}`);
    }
  const html = renderView(viewModel(connected('disconnected', 'boom'), WIDE_WIDTH), 'en');
  assert.match(html, /<p role="status" data-connection="disconnected">Offline<\/p>/);
  const diagnostics = DIAGNOSTICS.exec(html)?.[0] ?? '';
  assert.match(diagnostics, /<summary>Connection details<\/summary>/);
  assert.match(diagnostics, new RegExp(`<dd>${PID}</dd>`));
  assert.match(diagnostics, /<dd>Built-in narrator\. Install Claude Code or set ANTHROPIC_API_KEY/);
  assert.match(diagnostics, /<dd>boom<\/dd>/);
});

test('rpg-42a.33 diagnostics name the active game master in plain words', () => {
  const routes = [
    ['claude-code', /Claude Code on this computer/],
    ['api', /Claude with your API key/],
  ] as const;
  for (const [gm, words] of routes) {
    const state: DesktopState = {
      ...initialState,
      connection: { status: 'connected', attempts: 0, engine: { pid: PID, gm } },
    };
    const html = renderView(viewModel(state, WIDE_WIDTH), 'en');
    assert.match(DIAGNOSTICS.exec(html)?.[0] ?? '', words);
  }
});

const FULL_RULES_REGIONS = PLAY_REGIONS.filter((region) => region !== 'character');

test('rpg-42a.18 every pane has a heading and an empty state', () => {
  const html = renderView(viewModel(initialState, WIDE_WIDTH), 'en');
  for (const region of ['status', 'campaigns'])
    assert.match(html, new RegExp(`aria-labelledby="heading-${region}"><(hgroup><)?h[12] [^>]*id="heading-${region}"`));
  assert.ok(html.includes('<p data-empty>No adventures yet. Start a new adventure to play.</p>'));
  const playing = renderView(viewModel({ ...initialState, selected: CAMPAIGN }, WIDE_WIDTH), 'en');
  for (const region of FULL_RULES_REGIONS)
    assert.match(playing, new RegExp(`aria-labelledby="heading-${region}"><h2 id="heading-${region}">`));
  for (const text of [
    'Your story starts here. Type what your character does, then press Send.',
    'No character sheet yet.',
    'Nothing in your journal yet.',
  ])
    assert.ok(playing.includes(`<p data-empty>${text}</p>`), text);
  const filled = renderView(viewModel(state, WIDE_WIDTH), 'en');
  assert.doesNotMatch(filled, /data-empty/);
});

test('rpg-42a.18 the header shows the campaign name and scene title', () => {
  const snapshot = state.snapshot as NonNullable<DesktopState['snapshot']>;
  const scene = {
    ...state,
    snapshot: { ...snapshot, currentScene: { id: 's1', campaignId: CAMPAIGN, title: 'Docks' } },
  };
  const html = renderView(viewModel(scene, WIDE_WIDTH), 'en');
  assert.ok(html.includes(`<hgroup><h1 id="heading-status" tabindex="-1">${ESCAPED}</h1><p>Docks</p></hgroup>`));
});

test('rpg-42a.18 player, narrator and system lines have distinct speakers', () => {
  const pending = {
    ...state,
    outbox: [{ campaignId: CAMPAIGN, actionId: 'a1', input: 'wait' }],
  } as unknown as DesktopState;
  const html = renderView(viewModel(pending, WIDE_WIDTH), 'en');
  assert.ok(html.includes(`<p data-speaker="player"><span data-speaker-label>You</span>${ESCAPED}</p>`));
  assert.ok(html.includes(`<p data-speaker="gm"><span data-speaker-label>Narrator</span>${ESCAPED}</p>`));
  assert.match(
    html,
    /<li data-action-id="a1" aria-busy="true"><p data-speaker="player">.*wait<\/p><p data-speaker="system">pending<\/p><\/li>/,
  );
});

test('rpg-42a.18 compact width shows one pane at a time with a pane switcher, wider widths show every pane', () => {
  const compact = renderView(viewModel(state, COMPACT_WIDTH), 'en', 'sheet');
  assert.match(compact, /<nav aria-label="Panes">/);
  for (const region of FULL_RULES_REGIONS)
    assert.match(
      compact,
      new RegExp(`<button type="button" data-pane="${region}"${region === 'sheet' ? ' aria-current="true"' : ''}>`),
    );
  assert.match(compact, /data-region="sheet" aria-labelledby="heading-sheet">/);
  assert.match(compact, /data-region="status" aria-labelledby="heading-status">/);
  for (const region of ['conversation', 'panels'])
    assert.match(compact, new RegExp(`data-region="${region}" aria-labelledby="heading-${region}" hidden>`));
  assert.match(
    renderView(viewModel(state, COMPACT_WIDTH), 'en'),
    /data-region="sheet" aria-labelledby="heading-sheet" hidden>/,
  );
  for (const width of [MEDIUM_WIDTH, WIDE_WIDTH]) {
    const html = renderView(viewModel(state, width), 'en', 'sheet');
    assert.doesNotMatch(html, /<nav|hidden>/);
    for (const region of FULL_RULES_REGIONS) assert.match(html, new RegExp(`data-region="${region}"`));
  }
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
  rulesets: [
    { id: 'narrative', edition: 'original', blurb: 'Light rules.', recommended: true, readyMade: true, sheet: [] },
  ],
};
const guideAt = (step: string, choices = {}): StartDraft => ({
  ...INITIAL_DRAFT,
  path: 'guide',
  step: START_STEPS.guide.indexOf(step as (typeof START_STEPS.guide)[number]),
  choices,
});
const ONE_CAMPAIGN = state.campaigns;
const startHtml = (draft: StartDraft, plan?: DesktopState['start']['plan']) =>
  renderView(
    viewModel({ ...initialState, start: { open: true, draft, options: START_OPTIONS, plan } }, WIDE_WIDTH),
    DEFAULT_PREFERENCES.locale,
  );

test('rpg-42a.14 guided start is a labelled region with a focusable step heading and named controls', () => {
  const closed = renderView(
    viewModel(
      { ...initialState, campaigns: ONE_CAMPAIGN, start: { ...initialState.start, created: HOSTILE } },
      WIDE_WIDTH,
    ),
    'en',
  );
  assert.match(closed, /<section data-region="start" aria-label="New adventure">/);
  assert.match(closed, /<button type="button" data-start-open="open" data-primary>New adventure<\/button>/);
  assert.ok(closed.includes(`<p role="status">Created campaign ${ESCAPED}.</p>`));
  const genre = startHtml(guideAt('genre', { genre: 'evil' }));
  assert.match(genre, /<h2 tabindex="-1" data-start-title="genre">Step 2 of 6: Pick a tone and genre<\/h2>/);
  assert.doesNotMatch(genre, /<img/);
  assert.match(genre, /data-start-option="0" aria-pressed="true"/);
  for (const control of ['back', 'skip', 'close']) assert.match(genre, new RegExp(`data-start-control="${control}">`));
  assert.doesNotMatch(genre, /data-start-control="start"/);
  const path = startHtml(INITIAL_DRAFT);
  assert.match(path, /data-start-option="1" aria-labelledby="start-option-1-label"/);
  assert.doesNotMatch(path, /data-start-option="\d" aria-pressed/);
  const character = startHtml(guideAt('character', { genre: 'evil' }));
  assert.match(
    character,
    /<label for="start-entry">Describe your character<\/label><input id="start-entry" name="start-entry" value="">/,
  );
  const summary = startHtml(guideAt('summary'), { ok: false, error: { code: 'UnknownEdition', message: HOSTILE } });
  assert.ok(summary.includes(`<p role="alert">Import your rulebook. ${ESCAPED}</p>`));
  assert.match(summary, /data-start-control="start" data-primary disabled>Start</);
});

const startSection = (html: string) => /<section data-region="start"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const primaries = (html: string) => (startSection(html).match(/data-primary/g) ?? []).length;
const REVIEW_PLAN: DesktopState['start']['plan'] = {
  ok: true,
  value: {
    version: PROTOCOL_VERSION,
    options: START_OPTIONS,
    entries: [
      { field: 'ruleset', value: HOSTILE, provenance: 'explicit' },
      { field: 'voiceOutput', value: 'off', provenance: 'default' },
    ],
  },
};

test('rpg-42a.30 start choices are cards with a separate title and description named for screen readers', () => {
  const path = startHtml(INITIAL_DRAFT);
  assert.doesNotMatch(path, / - /);
  assert.match(
    path,
    /<li><button type="button" data-start-option="0" aria-labelledby="start-option-0-label" aria-describedby="start-option-0-detail"><span id="start-option-0-label" data-option-label>Describe it<\/span><span id="start-option-0-detail" data-option-detail>Write one sentence about the game you want\.<\/span><\/button><\/li>/,
  );
  assert.match(path, /<ul data-start-options>/);
  const genre = startHtml(guideAt('genre'));
  assert.match(genre, /data-start-option="0" aria-pressed="false" aria-labelledby="start-option-0-label"/);
  assert.ok(genre.includes(`<span id="start-option-0-label" data-option-label>${ESCAPED}</span>`));
});

test('rpg-42a.30 Close sits in the wizard header and each step has at most one primary action', () => {
  const path = startHtml(INITIAL_DRAFT);
  assert.match(
    path,
    /<div data-start-head><h2 tabindex="-1" data-start-title="path">New adventure<\/h2><button type="button" data-start-control="close">Close<\/button><\/div>/,
  );
  assert.equal((path.match(/data-start-control="close"/g) ?? []).length, 1);
  assert.equal(primaries(path), 0);
  assert.equal(primaries(startHtml(guideAt('genre'))), 0);
  const primer = startHtml(guideAt('primer'));
  assert.equal(primaries(primer), 1);
  assert.match(primer, /<button type="button" data-start-control="next" data-primary>Next<\/button>/);
  const described = startHtml({ ...INITIAL_DRAFT, path: 'describe' });
  assert.equal(primaries(described), 1);
  assert.match(described, /<form id="start-form" data-start-form="start-entry">/);
  assert.match(
    described,
    /<div data-actions><button type="button" data-start-control="back">Back<\/button><button type="button" data-start-control="skip">Skip<\/button><button type="submit" id="start-submit" form="start-form" data-primary>Next<\/button><\/div>/,
  );
});

test('rpg-42a.30 summary is a grouped review list with chosen and default marked and an edit per setting', () => {
  const summary = startHtml(guideAt('summary'), REVIEW_PLAN);
  assert.doesNotMatch(summary, /type="submit"|>Save</);
  assert.match(summary, /<h3 id="start-review-0">Your story<\/h3><ul aria-labelledby="start-review-0">/);
  assert.match(summary, /<h3 id="start-review-1">Extras<\/h3>/);
  assert.ok(
    summary.includes(
      `<li data-provenance="chosen"><span data-review-label>Rules</span><span data-review-value>${ESCAPED}</span><span data-review-badge>Chosen</span><button type="button" data-start-edit="2" aria-label="Edit Rules">Edit</button></li>`,
    ),
  );
  assert.match(
    summary,
    /<li data-provenance="default"><span data-review-label>Voice narration<\/span><span data-review-value>off<\/span><span data-review-badge>Default<\/span><button type="button" data-start-edit="4" aria-label="Edit Voice narration">Edit<\/button><\/li>/,
  );
  assert.doesNotMatch(summary, /<p>Rules: /);
  assert.equal(primaries(summary), 1);
  assert.match(
    summary,
    /<div data-actions><button type="button" data-start-control="back">Back<\/button><button type="button" data-start-control="start" data-primary>Start<\/button><\/div>/,
  );
  assert.match(summary, /<label for="start-entry">Adventure name<\/label><input id="start-entry"/);
});

test('rpg-42a.17 the open wizard hides the first adventure button and play hides the created notice', () => {
  assert.doesNotMatch(startHtml(INITIAL_DRAFT), /Start your first adventure/);
  assert.match(renderView(viewModel(initialState, WIDE_WIDTH), 'en'), /Start your first adventure/);
  const playing = renderView(
    viewModel({ ...state, start: { ...initialState.start, created: CAMPAIGN } }, WIDE_WIDTH),
    'en',
  );
  assert.doesNotMatch(playing, /Created campaign/);
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

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const VOICE_OFF: DesktopVoiceView = {
  mode: { kind: 'typed-input-only' },
  preferences: { microphone: 'off', spokenOutput: 'off', locale: 'en', speed: 1 },
  subtitle: undefined,
  fallback: undefined,
  issues: [],
  asking: false,
};
const HOUR_MS = 3_600_000;
const summary = (name: string, overrides: Partial<CampaignSummary> = {}): CampaignSummary => ({
  id: `id-${name}`,
  name,
  health: 'ok',
  lastPlayedAt: null,
  sceneTitle: null,
  characters: [],
  ruleset: null,
  genre: null,
  lastNarration: null,
  turnCount: 0,
  ...overrides,
});
const HARBOR = summary('Harbor', {
  lastPlayedAt: new Date(NOW - HOUR_MS).toISOString(),
  sceneTitle: 'Docks',
  characters: [{ id: 'hero', name: 'Ash' }],
  genre: { id: 'fantasy', version: '1.0.0', provenance: 'derived' },
  lastNarration: 'The tide turns.',
});
const home = (overrides: Partial<DesktopState> = {}, width = WIDE_WIDTH) =>
  renderView(viewModel({ ...initialState, ...overrides }, width, DEFAULT_PREFERENCES, NOW), 'en');

test('rpg-42a.13 the home shows one line and the guided start when there are no adventures', () => {
  const html = home();
  assert.ok(html.includes('<p data-empty>No adventures yet. Start a new adventure to play.</p>'));
  assert.match(
    html,
    /data-region="campaigns"[^>]*><h2[^>]*>Your adventures<\/h2><p data-empty>[^<]*<\/p><button type="button" data-start-open="home" data-primary>Start your first adventure<\/button>/,
  );
  assert.doesNotMatch(html, /home-search|data-archived|data-start-open="open"/);
});

test('rpg-42a.13 a home card shows where the adventure stopped and continues it', () => {
  const html = home({ campaigns: [HARBOR] });
  assert.match(html, /<article aria-labelledby="home-card-0"><h3 id="home-card-0">Harbor<\/h3>/);
  assert.ok(html.includes('<p data-meta>Ash · Docks · 1 hour ago</p><p data-narration>The tide turns.</p>'));
  assert.doesNotMatch(html, / - /);
  assert.match(
    html,
    /<button type="button" id="home-continue-0" data-home="continue" data-name="Harbor" aria-label="Continue Harbor" data-primary>Continue<\/button><details data-menu><summary id="home-more-0" aria-label="More actions for Harbor">More<\/summary><div><button type="button" id="home-archive-0" data-home="archive"[^>]*>Archive<\/button><button type="button" id="home-delete-0" data-home="delete"[^>]*>Delete<\/button><\/div><\/details>/,
  );
  assert.doesNotMatch(html, /home-search/);
});

test('rpg-42a.22 the home is a landing view with an app header, a primary new adventure and no play panes', () => {
  for (const width of [COMPACT_WIDTH, MEDIUM_WIDTH, WIDE_WIDTH]) {
    const html = home(
      { campaigns: [summary('Older', { lastPlayedAt: new Date(NOW - 2 * HOUR_MS).toISOString() }), HARBOR] },
      width,
    );
    assert.match(html, /<main data-screen="home"/);
    assert.match(html, /<h1 id="heading-status" tabindex="-1">RPG Harness<\/h1>/);
    assert.match(html, /<button type="button" data-start-open="open" data-primary>New adventure<\/button>/);
    assert.match(html, /data-region="campaigns" aria-labelledby="heading-campaigns">/);
    assert.ok(html.indexOf('>Harbor<') < html.indexOf('>Older<'));
    for (const region of PLAY_REGIONS) assert.doesNotMatch(html, new RegExp(`data-region="${region}"`));
    assert.doesNotMatch(html, /<nav|data-nav|data-settings|No adventure selected/);
  }
});

test('rpg-42a.22 the home shows the voice bar while voice is on and hides it while off', () => {
  const model = viewModel({ ...initialState, campaigns: ONE_CAMPAIGN }, WIDE_WIDTH);
  const on = { ...VOICE_OFF, preferences: { ...VOICE_OFF.preferences, microphone: 'push-to-talk' as const } };
  assert.match(renderView(model, 'en', undefined, on), /<\/main><section data-region="voice"[^>]*><p>Push to talk · /);
  assert.doesNotMatch(renderView(model, 'en', undefined, VOICE_OFF), /data-region="voice"/);
});

test('rpg-42a.22 the play view has a home button and a settings menu holding motion and voice', () => {
  const html = renderView(viewModel(state, WIDE_WIDTH), 'en', undefined, VOICE_OFF);
  assert.match(html, /<main data-screen="play"/);
  assert.match(
    html,
    /<section data-region="status" aria-labelledby="heading-status"><button type="button" id="nav-home" data-nav="home" aria-label="Back to home">Home<\/button><hgroup><h1 id="heading-status" tabindex="-1">/,
  );
  assert.match(
    html,
    /<details data-settings><summary id="settings-toggle">Settings<\/summary><div><fieldset data-language-control><legend>Language<\/legend>[\s\S]*<\/fieldset><fieldset data-motion-control><legend>Motion<\/legend>[\s\S]*<\/fieldset><p data-voice-summary>Voice off · English · normal speed<\/p><p>[^<]*set mic to push-to-talk[^<]*<\/p><fieldset data-sound>[\s\S]*<\/fieldset><form data-gm-form>[\s\S]*<\/form><\/div><\/details>/,
  );
  assert.doesNotMatch(html, /data-region="voice"|data-region="campaigns"|data-start-open/);
  assert.ok(html.indexOf('data-settings') < html.indexOf('data-columns'));
});

test('rpg-42a.37 settings hold a GM model form with hints, usage and a soft budget warning', () => {
  const snapshot = state.snapshot as NonNullable<DesktopState['snapshot']>;
  const usage = {
    turns: 2,
    inputTokens: 600,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100,
    costUsd: 0.01,
    pricedTurns: 2,
  };
  const gm = {
    settings: { model: 'opus', summaryModel: 'haiku', sessionBudgetTokens: 500 },
    campaignSettings: { model: 'opus', sessionBudgetTokens: 500 },
    defaults: { summaryModel: 'haiku' },
    session: usage,
    campaign: usage,
  };
  const html = renderView(viewModel({ ...state, snapshot: { ...snapshot, gm } }, WIDE_WIDTH), 'en');
  assert.match(html, /<form data-gm-form><fieldset><legend>GM model for this campaign<\/legend>/);
  assert.match(html, /<form data-gm-form>[\s\S]*?<input name="model" list="gm-models" value="opus" placeholder=""/);
  assert.match(
    html,
    /<form data-gm-form>[\s\S]*?<input name="summaryModel" list="gm-models" value="" placeholder="haiku"/,
  );
  assert.match(
    html,
    /<form data-gm-form>[\s\S]*?<input name="sessionBudgetTokens" type="number" min="1" step="1" value="500" placeholder=""/,
  );
  assert.match(html, /<form data-gm-defaults-form><fieldset><legend>App default GM model<\/legend>/);
  assert.match(html, /<form data-gm-defaults-form>[\s\S]*?<input name="summaryModel" list="gm-models" value="haiku"/);
  assert.match(html, /<form data-gm-defaults-form>[\s\S]*?<button type="submit">Save app default<\/button>/);
  assert.match(html, /<option value="haiku">cheaper and faster<\/option>/);
  assert.match(html, /<option value="default">Balanced \(recommended\): quality, creativity and speed<\/option>/);
  assert.doesNotMatch(html, /Claude Code default/);
  assert.match(html, /This session: 2 GM turns, 700 tokens/);
  assert.match(html, /<p role="status">This session used more than the 500 token budget\. Play goes on\.<\/p>/);
  const spanish = renderView(viewModel(state, WIDE_WIDTH), 'es');
  assert.match(spanish, /<legend>Modelo del GM para esta campaña<\/legend>/);
  assert.match(spanish, /<legend>Modelo del GM por defecto de la app<\/legend>/);
  assert.match(spanish, /<option value="opus">narración más rica, cuesta más<\/option>/);
  assert.doesNotMatch(spanish, /GM turns/);
});

test('rpg-42a.58 the campaign GM form offers the rules strictness in English, Spanish and Portuguese', () => {
  const usage = {
    turns: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    pricedTurns: 0,
  };
  const snapshot = state.snapshot as NonNullable<DesktopState['snapshot']>;
  const gm = {
    settings: {},
    campaignSettings: { rulesStrictness: 'relaxed' as const },
    defaults: {},
    session: usage,
    campaign: usage,
  };
  const model = viewModel({ ...state, snapshot: { ...snapshot, gm } }, WIDE_WIDTH);
  const english = renderView(model, 'en');
  assert.match(english, /<form data-gm-form>[\s\S]*?<select name="rulesStrictness"/);
  assert.match(english, /<option value="">Default \(as written when the game has a ruleset\)<\/option>/);
  assert.match(english, /<option value="as-written">As written: the engine decides every outcome<\/option>/);
  assert.match(english, /<option value="relaxed" selected>Relaxed: skip trivial checks<\/option>/);
  assert.match(english, /<option value="off">Off: the story decides<\/option>/);
  assert.doesNotMatch(english.split('data-gm-defaults-form')[1] ?? '', /rulesStrictness/);
  assert.match(renderView(model, 'pt-BR'), /<option value="relaxed" selected>Relaxado: pula testes triviais<\/option>/);
  assert.match(renderView(model, 'pt-BR'), /Rigor das regras/);
  assert.match(renderView(model, 'es'), /<option value="off">Desactivado: manda la historia<\/option>/);
});

test('rpg-42a.22 the sheet names the existing character even before it has stats', () => {
  const snapshot = state.snapshot as NonNullable<DesktopState['snapshot']>;
  const hero = {
    ...state,
    views: {},
    snapshot: { ...snapshot, characters: [{ id: 'h', campaignId: CAMPAIGN, name: 'The Wanderer' }] },
  };
  const html = renderView(viewModel(hero, WIDE_WIDTH), 'en');
  assert.match(
    html,
    /<h2 id="heading-sheet">Character sheet<\/h2><h3>The Wanderer<\/h3><p data-empty>No stats tracked yet\.<\/p>/,
  );
  assert.doesNotMatch(html, /No character sheet yet/);
});

test('rpg-42a.22 the opening narration shows without a player prompt bubble', () => {
  const snapshot = state.snapshot as NonNullable<DesktopState['snapshot']>;
  const opening = {
    ...state,
    snapshot: { ...snapshot, turns: [{ ...snapshot.turns[0], actionId: OPENING_ACTION_ID, input: 'Begin.' }] },
  } as DesktopState;
  const html = renderView(viewModel(opening, WIDE_WIDTH), 'en');
  assert.match(html, /<li data-action-id="opening"><p data-speaker="gm">/);
  assert.doesNotMatch(html, /Begin\./);
});

test('rpg-42a.13 many adventures get a labelled search box and a no-match line', () => {
  const many = [...Array.from({ length: 5 }, (_, index) => summary(`Tale ${index}`)), HARBOR];
  const html = home({ campaigns: many, home: { query: 'zzz' } });
  assert.match(
    html,
    /<label for="home-search">Search adventures<\/label><input id="home-search" type="search" value="zzz">/,
  );
  assert.match(html, /<p data-empty>No adventures match your search\.<\/p>/);
  assert.doesNotMatch(html, /home-card-/);
});

test('rpg-42a.13 unhealthy adventures show the problem and a backup hint instead of continue', () => {
  const html = home({
    campaigns: [summary('Junk', { id: null, health: 'unreadable' }), summary('Old', { health: 'needs-migration' })],
  });
  assert.match(
    html,
    /<h3 id="home-card-0">Junk<\/h3><p data-problem>This save cannot be read\. Restore it from a backup with rpg restore &lt;file&gt;\.<\/p>/,
  );
  assert.match(html, /<h3 id="home-card-1">Old<\/h3><p data-problem>This save needs a newer version of the app\./);
  assert.doesNotMatch(html, /data-home="continue"/);
  assert.match(html, /<summary id="home-more-0" aria-label="More actions for Junk">/);
  assert.match(html, /id="home-delete-0" data-home="delete" data-name="Junk"/);
});

test('rpg-42a.13 archive and delete ask first, archive offers undo and archived adventures stay collapsed', () => {
  const asking = home({ campaigns: [HARBOR], home: { query: '', confirm: { kind: 'delete', name: 'Harbor' } } });
  assert.match(
    asking,
    /<div role="alertdialog" aria-labelledby="home-confirm-text"><p id="home-confirm-text">Delete Harbor for good\? This cannot be undone\.<\/p><button type="button" id="home-confirm" data-home="confirm">Delete<\/button><button type="button" id="home-cancel" data-home="cancel">Cancel<\/button><\/div>/,
  );
  const undo = home({ campaigns: [], archived: [summary('Spire')], home: { query: '', undo: 'Spire' } });
  assert.match(
    undo,
    /<p role="status">Archived Spire\. <button type="button" id="home-undo" data-home="undo">Undo<\/button><\/p>/,
  );
  assert.match(
    undo,
    /<details data-archived><summary>Archived adventures \(1\)<\/summary><ul><li><article aria-labelledby="home-archived-0"><h3 id="home-archived-0">Spire<\/h3>/,
  );
  assert.match(
    undo,
    /id="home-unarchive-0" data-home="unarchive" data-name="Spire" aria-label="Restore Spire" data-primary>Restore<\/button><details data-menu><summary id="home-archived-more-0" [^>]*>More<\/summary><div><button type="button" id="home-archived-delete-0" data-home="delete"/,
  );
  const failed = home({ campaigns: [HARBOR], home: { query: '', error: 'Campaign Harbor is open in this engine.' } });
  assert.match(failed, /<p role="alert">Campaign Harbor is open in this engine\.<\/p>/);
});

const rolled = (resultId: string, face: number): VisualizationEvent => ({
  version: PROTOCOL_VERSION,
  type: 'MechanicVisualized',
  resultId,
  mechanic: 'dice',
  frames: [{ step: 0, reveal: { kind: 'die', sides: 20, face } }],
  final: { total: face, outcome: HOSTILE },
});

test('UI15: the conversation shows the latest roll with a skip button and a recent roll history', () => {
  const rolling = { ...state, rolls: [rolled('r2', 12), rolled('r1', 3)], rolling: true };
  const html = renderView(viewModel(rolling, WIDE_WIDTH), DEFAULT_PREFERENCES.locale);
  assert.match(html, /<section data-rolls aria-label="Dice"><figure data-roll data-animated="true"/);
  assert.match(html, /data-roll-skip/);
  assert.match(html, /<details data-roll-history><summary>Recent rolls<\/summary><ol><li>d20 3, total 3, /);
  assert.doesNotMatch(html, /<img/);
  const still = renderView(viewModel(rolling, WIDE_WIDTH, { ...DEFAULT_PREFERENCES, motion: 'off' }), 'en');
  assert.match(still, /data-animated="false"/);
  assert.doesNotMatch(renderView(viewModel(state, WIDE_WIDTH), 'en'), /data-rolls/);
});

test('UI15: changed sheet values carry a highlight marker', () => {
  const changed = { ...state, sheetChanged: ['n'] };
  assert.match(renderView(viewModel(changed, WIDE_WIDTH), 'en'), /<div data-stat="n" data-changed>/);
  assert.doesNotMatch(renderView(viewModel(state, WIDE_WIDTH), 'en'), /data-changed/);
});

test('UI15: the motion control offers full, reduced and off and marks the current setting', () => {
  assert.doesNotMatch(home({ campaigns: [HARBOR] }), /data-motion-control/);
  const html = renderView(viewModel(state, WIDE_WIDTH, { ...DEFAULT_PREFERENCES, motion: 'reduced' }), 'en');
  assert.match(html, /<fieldset data-motion-control><legend>Motion<\/legend>/);
  assert.match(html, /<button type="button" data-motion="full" aria-pressed="false">Full<\/button>/);
  assert.match(html, /<button type="button" data-motion="reduced" aria-pressed="true">Reduced<\/button>/);
  assert.match(html, /<button type="button" data-motion="off" aria-pressed="false">Off<\/button>/);
});

test('rpg-42a.39 the language control names each locale in its own language and marks the current one', () => {
  const html = renderView(viewModel(state, WIDE_WIDTH, { ...DEFAULT_PREFERENCES, locale: 'pt-BR' }), 'pt-BR');
  assert.match(html, /<fieldset data-language-control><legend>Idioma<\/legend>/);
  assert.match(html, /<button type="button" data-locale="en" lang="en" aria-pressed="false">English<\/button>/);
  assert.match(html, /<button type="button" data-locale="es" lang="es" aria-pressed="false">Español<\/button>/);
  assert.match(
    html,
    /<button type="button" data-locale="pt-BR" lang="pt-BR" aria-pressed="true">Português \(Brasil\)<\/button>/,
  );
});

const sheetState = (sheetErrors: DesktopState['sheetErrors'] = {}): DesktopState => ({
  ...state,
  sheetErrors,
  views: {
    sheet: {
      campaignId: CAMPAIGN,
      viewId: 'sheet',
      components: [
        { kind: 'field', id: 'might', label: 'Might', value: 3, group: 'core', editable: true },
        { kind: 'field', id: 'hidden', label: 'Hidden', value: false, group: 'custom', editable: true },
        {
          kind: 'field',
          id: 'armor',
          label: 'Armor',
          value: 5,
          group: 'computed',
          editable: false,
          explanation: HOSTILE,
        },
      ],
    },
  },
});

test('rpg-42a.21: the sheet renders one titled group per SheetView group', () => {
  const html = renderView(viewModel(sheetState(), WIDE_WIDTH), 'en');
  assert.match(
    html,
    /<section data-sheet-group="core" aria-labelledby="sheet-group-core"><h4 id="sheet-group-core">Core<\/h4>/,
  );
  assert.match(html, /<h4 id="sheet-group-custom">Custom<\/h4>/);
  assert.match(html, /<h4 id="sheet-group-computed">Computed<\/h4>/);
  assert.match(renderView(viewModel(sheetState(), WIDE_WIDTH), 'es'), /<h4 id="sheet-group-computed">Calculado<\/h4>/);
});

const editing = (sheetErrors: DesktopState['sheetErrors'] = {}) => ({ ...sheetState(sheetErrors), sheetEditing: true });

test('rpg-42a.29: the sheet shows read-only stat blocks and one Edit action', () => {
  const html = renderView(viewModel(sheetState(), WIDE_WIDTH), 'en');
  assert.match(html, /<dl data-stats><div data-stat="might"><dt>Might<\/dt><dd>3<\/dd><\/div><\/dl>/);
  assert.match(html, /<div data-stat="hidden"><dt>Hidden<\/dt><dd>no<\/dd><\/div>/);
  assert.equal(html.match(/data-sheet-action="edit"/g)?.length, 1);
  assert.match(html, /<button type="button" id="sheet-edit" data-sheet-action="edit">Edit sheet<\/button>/);
  assert.doesNotMatch(html, /<input id="sheet-field-|data-sheet-form/);
  const readOnly = {
    ...sheetState(),
    views: { sheet: { ...sheetState().views.sheet, components: [] } },
  } as DesktopState;
  assert.doesNotMatch(renderView(viewModel(readOnly, WIDE_WIDTH), 'en'), /sheet-edit/);
});

test('rpg-42a.29: editing shows native inputs with one Save and one Cancel for the sheet', () => {
  const components = editing().views.sheet?.components ?? [];
  const bounded: DesktopState = {
    ...editing(),
    views: {
      sheet: {
        campaignId: CAMPAIGN,
        viewId: 'sheet',
        components: components.map((component) =>
          component.id === 'might' ? { ...component, min: 1, max: 20 } : component,
        ),
      },
    },
  };
  const html = renderView(viewModel(bounded, WIDE_WIDTH), 'en');
  assert.match(html, /<form data-sheet-form novalidate aria-label="Edit sheet">/);
  assert.match(
    html,
    /<div data-stat="might"><label for="sheet-field-might">Might<\/label><input id="sheet-field-might" name="might" type="number" step="any" required min="1" max="20" value="3"><\/div>/,
  );
  assert.match(html, /<input id="sheet-field-hidden" name="hidden" type="checkbox">/);
  assert.match(html, /<div data-stat="armor"><span>Armor<\/span><span><span tabindex="0"/);
  assert.match(
    html,
    /<div data-actions><button type="submit" id="sheet-save" data-primary>Save<\/button><button type="button" id="sheet-cancel" data-sheet-action="cancel">Cancel<\/button><\/div><\/form>/,
  );
  assert.equal(html.slice(html.indexOf('<form data-sheet-form')).match(/type="submit"/g)?.length, 1);
  assert.doesNotMatch(html, /id="sheet-edit"/);
  assert.match(
    renderView(viewModel(editing(), WIDE_WIDTH), 'en'),
    /name="might" type="number" step="any" required value="3">/,
  );
});

test('rpg-42a.21: a rejected sheet edit shows an alert tied to its input', () => {
  const html = renderView(viewModel(editing({ might: HOSTILE }), WIDE_WIDTH), 'en');
  assert.match(
    html,
    /<input id="sheet-field-might" name="might" type="number" step="any" required value="3" aria-invalid="true" aria-describedby="sheet-error-might"><p role="alert" id="sheet-error-might">/,
  );
  assert.ok(html.includes(`<p role="alert" id="sheet-error-might">${ESCAPED}</p>`));
});

test('rpg-42a.21: a computed value shows its explanation on hover and keyboard focus', () => {
  const html = renderView(viewModel(sheetState(), WIDE_WIDTH), 'en');
  assert.ok(
    html.includes(
      `<dd><span tabindex="0" aria-describedby="sheet-explain-armor">5</span><span role="tooltip" id="sheet-explain-armor">${ESCAPED}</span></dd>`,
    ),
  );
});

test('rpg-42a.21: cssEscape makes any id safe inside a CSS selector', () => {
  assert.equal(cssEscape('might'), 'might');
  assert.equal(cssEscape('a b"]'), 'a\\20 b\\22 \\5d ');
  assert.equal(cssEscape('1st'), '\\31 st');
});

test('rpg-42a.27 a committed turn with blank narration shows a no-reply line', () => {
  const blank = [{ actionId: 'a1', input: 'wait', narration: '', pending: false }];
  const model = { ...viewModel(state, WIDE_WIDTH), conversation: blank };
  assert.match(renderView(model, 'en'), /<p data-speaker="system">No reply was recorded for this turn\.<\/p>/);
  assert.match(renderView(model, 'es'), /<p data-speaker="system">No se registró respuesta para este turno\.<\/p>/);
});

const withRules = (rules: RulesUsage, extra: Partial<DesktopState> = {}): DesktopState => {
  const { snapshot } = state;
  assert.ok(snapshot !== undefined);
  return { ...state, ...extra, snapshot: { ...snapshot, rules } };
};
const DICELESS_SHEETLESS: RulesUsage = { resolution: 'adjudicated', sheet: 'none' };
const NO_SHEET_DICE: RulesUsage = { resolution: 'dice', sheet: 'none' };
const SHEET_NO_DICE: RulesUsage = { resolution: 'adjudicated', sheet: 'full' };

test('rpg-42a.38 a diceless sheetless game hides the sheet panel, dice card and motion setting', () => {
  const diceless = withRules(DICELESS_SHEETLESS, { rolls: [rolled('r1', 3)], rolling: true });
  for (const width of [WIDE_WIDTH, MEDIUM_WIDTH, COMPACT_WIDTH]) {
    const model = viewModel(diceless, width);
    const html = renderView(model, 'en');
    assert.doesNotMatch(
      html,
      /data-region="sheet"|data-rolls|data-roll\b|data-motion-control|data-stat/,
      String(width),
    );
    assert.doesNotMatch(html, /No character sheet yet|No stats tracked|Character sheet|>Dice</, String(width));
    assert.deepEqual(model.layout.columns.flat().toSorted(), ['conversation', 'panels'], String(width));
    assert.ok(model.layout.columns.every((column) => column.length > 0));
  }
  assert.deepEqual(viewModel(diceless, MEDIUM_WIDTH).layout.columns, [['conversation'], ['panels']]);
  assert.deepEqual(viewModel(diceless, COMPACT_WIDTH).layout.columns, [['conversation', 'panels']]);
  assert.doesNotMatch(renderView(viewModel(diceless, WIDE_WIDTH), 'en'), /does not use dice|data-rules-note/);
});

test('rpg-42a.38 dice and sheet are hidden independently without a header notice', () => {
  const noSheet = renderView(viewModel(withRules(NO_SHEET_DICE, { rolls: [rolled('r1', 3)] }), WIDE_WIDTH), 'en');
  assert.doesNotMatch(noSheet, /data-region="sheet"/);
  assert.match(noSheet, /data-rolls/);
  assert.match(noSheet, /data-motion-control/);
  const noDice = renderView(viewModel(withRules(SHEET_NO_DICE, { rolls: [rolled('r1', 3)] }), WIDE_WIDTH), 'en');
  assert.match(noDice, /data-region="sheet"/);
  assert.doesNotMatch(noDice, /data-rolls|data-motion-control/);
  const full = renderView(viewModel(state, WIDE_WIDTH), 'en');
  assert.match(full, /data-region="sheet"/);
});

test('rpg-42a.38 no locale shows a permanent dice or sheet notice', () => {
  for (const locale of ['es', 'pt-BR'])
    assert.doesNotMatch(
      renderView(viewModel(withRules(DICELESS_SHEETLESS), WIDE_WIDTH, { ...DEFAULT_PREFERENCES, locale }), locale),
      /data-rules-note/,
    );
});

const IDENTITY_VIEW = {
  campaignId: CAMPAIGN,
  viewId: 'sheet',
  components: [
    { kind: 'field', id: 'name', label: 'Name', value: 'Mara' },
    { kind: 'field', id: 'description', label: 'Description', value: 'A lighthouse keeper.' },
  ],
} as const;

test('rpg-42a.54 a sheetless game shows a Character panel in the sheet slot and an empty journal says so once', () => {
  const { panels: _journal, ...withoutJournal } = withRules(DICELESS_SHEETLESS, { views: { sheet: IDENTITY_VIEW } });
  const sheetless: DesktopState = withoutJournal;
  const model = viewModel(sheetless, WIDE_WIDTH);
  assert.deepEqual(model.layout.columns, [['conversation'], ['character', 'panels']]);
  const html = renderView(model, 'en');
  assert.match(
    html,
    /<section data-region="character" aria-labelledby="[^"]+"><h2 id="[^"]+">Character<\/h2><h3>Mara<\/h3><p>A lighthouse keeper\.<\/p><\/section>/,
  );
  const journal = html.slice(html.indexOf('data-region="panels"'));
  assert.doesNotMatch(journal, /Mara/);
  assert.match(journal, /Nothing in your journal yet\./);
  assert.doesNotMatch(html, /data-region="sheet"|data-stat/);
  const full = renderView(
    viewModel(withRules({ resolution: 'dice', sheet: 'full' }, { views: { sheet: IDENTITY_VIEW } }), WIDE_WIDTH),
    'en',
  );
  assert.doesNotMatch(full, /data-region="character"/);
  assert.doesNotMatch(
    renderView(viewModel(withRules(DICELESS_SHEETLESS), WIDE_WIDTH), 'en'),
    /data-region="character"/,
  );
});

const BUILT_IN_RULESETS = ['narrative', 'd20-lite', 'dice-pool-lite'].map((id) => ({
  id,
  edition: 'original',
  blurb: `${id} original`,
  recommended: id === 'narrative',
  readyMade: true,
  sheet: [],
}));
const INTERNAL_IDS = /d20-lite|dice-pool-lite|narrative|original/;
const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');

test('rpg-42a.54 the rules and summary steps show player names, a Recommended badge first, and no import command', () => {
  const options = { ...START_OPTIONS, rulesets: BUILT_IN_RULESETS };
  const choice = { id: 'narrative', edition: 'original' };
  const plan = {
    ok: true,
    value: {
      version: PROTOCOL_VERSION,
      options,
      entries: [{ field: 'ruleset', value: 'narrative original', provenance: 'explicit' }],
    },
  } as const;
  for (const [draft, shownPlan] of [
    [guideAt('rules'), undefined],
    [guideAt('summary', { ruleset: choice }), plan],
  ] as const) {
    const html = renderView(
      viewModel({ ...initialState, start: { open: true, draft, options, plan: shownPlan } }, WIDE_WIDTH),
      'en',
    );
    assert.doesNotMatch(visibleText(html), INTERNAL_IDS);
    assert.doesNotMatch(html, /rpg import|data-start-import/);
  }
  const rules = renderView(
    viewModel(
      { ...initialState, start: { open: true, draft: guideAt('rules'), options, plan: undefined } },
      WIDE_WIDTH,
    ),
    'en',
  );
  assert.match(
    rules,
    /<ul data-start-options><li><button[^>]*><span[^>]*data-option-label>Story only: no dice, no sheet <span data-option-badge>Recommended<\/span><\/span>/,
  );
  assert.match(rules, /Classic d20/);
  assert.match(rules, /Dice pool/);
});

test('rpg-42a.67 settings hold a story language control beside the app language, marking the campaign language', () => {
  const snapshot = state.snapshot as NonNullable<DesktopState['snapshot']>;
  const html = renderView(viewModel({ ...state, snapshot: { ...snapshot, language: 'es' } }, WIDE_WIDTH), 'en');
  assert.match(
    html,
    /<fieldset data-language-control>[\s\S]*<\/fieldset><fieldset data-story-language-control><legend>Story language<\/legend>/,
  );
  assert.match(html, /<button type="button" data-story-language="en" lang="en" aria-pressed="false">English<\/button>/);
  assert.match(html, /<button type="button" data-story-language="es" lang="es" aria-pressed="true">Español<\/button>/);
  assert.match(html, /data-story-language="pt-BR"/);
  const spanish = renderView(viewModel(state, WIDE_WIDTH, { ...DEFAULT_PREFERENCES, locale: 'es' }), 'es');
  assert.match(spanish, /<fieldset data-story-language-control><legend>Idioma de la historia<\/legend>/);
});
