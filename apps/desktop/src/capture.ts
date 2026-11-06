import { join } from 'node:path';
import { SMOKE_ENV, WINDOW_HEIGHT, WINDOW_WIDTH } from './main.ts';
import { BRIDGE_KEY } from './preload.ts';
import { COMPACT_MAX_WIDTH, MEDIUM_MAX_WIDTH } from './renderer.ts';
import { decodePng } from './ux-check.ts';

export const CAPTURE_ENV = 'RPG_DESKTOP_CAPTURE_DIR';
export const CAPTURE_STATUS = 'rpg-desktop-capture: ';
export const CAPTURE_LAYOUTS = [
  { name: 'compact', width: COMPACT_MAX_WIDTH },
  { name: 'medium', width: MEDIUM_MAX_WIDTH },
  { name: 'wide', width: WINDOW_WIDTH },
] as const;

const COLOR_SCHEME = 'prefers-color-scheme';
const CONTRAST = 'prefers-contrast';
const REDUCED_MOTION = { name: 'prefers-reduced-motion', value: 'reduce' };
const DEFAULT_CONTRAST = 'no-preference';
const MORE_CONTRAST = 'more';
const LIGHT = 'light';
const DARK = 'dark';
const theme = (name: string, scheme: string, contrast: string) => ({
  name,
  features: [{ name: COLOR_SCHEME, value: scheme }, { name: CONTRAST, value: contrast }, REDUCED_MOTION],
});

export const CAPTURE_THEMES = [
  theme(LIGHT, LIGHT, DEFAULT_CONTRAST),
  theme(DARK, DARK, DEFAULT_CONTRAST),
  theme('high-contrast-light', LIGHT, MORE_CONTRAST),
  theme('high-contrast-dark', DARK, MORE_CONTRAST),
];

const DEBUGGER_VERSION = '1.3';
const EMULATE_MEDIA = 'Emulation.setEmulatedMedia';
const PNG_EXTENSION = '.png';
const HOME_PREFIX = 'home-';
const PLAYING_PREFIX = '';
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 50;
const CONTINUE_FIRST_CAMPAIGN = `new Promise((resolve) => {
  document.querySelector('[data-home="continue"]')?.click();
  const deadline = Date.now() + ${SETTLE_TIMEOUT_MS};
  const poll = () => (document.querySelector('[data-region="conversation"] li') || Date.now() > deadline ? resolve() : setTimeout(poll, ${SETTLE_POLL_MS}));
  poll();
})`;
type MediaFeature = { readonly name: string; readonly value: string };
const MEDIA_JOIN = ' and ';
const mediaQuery = (features: readonly MediaFeature[]) =>
  features.map(({ name, value }) => `(${name}: ${value})`).join(MEDIA_JOIN);
const FOCUS_SETTLED = `new Promise((resolve, reject) => {
  const deadline = Date.now() + ${SETTLE_TIMEOUT_MS};
  const check = () => {
    const before = document.activeElement;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.activeElement === before) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for focus to settle'));
      check();
    }));
  };
  check();
})`;
const settleProbe = (layout: string, features: readonly MediaFeature[]) =>
  `(async () => { await ${until(
    `document.querySelector('main[data-layout="${layout}"]') && matchMedia(${JSON.stringify(mediaQuery(features))}).matches`,
  )}; await ${FOCUS_SETTLED}; })()`;
const FOCUS_EMULATION = 'Emulation.setFocusEmulationEnabled';
const HIDDEN_CARET = '* { caret-color: transparent !important; }';
const prepare = async ({ webContents }: CaptureWindow) => {
  webContents.debugger.attach(DEBUGGER_VERSION);
  await webContents.debugger.sendCommand(FOCUS_EMULATION, { enabled: true });
  await webContents.insertCSS(HIDDEN_CARET);
};
const SCREENSHOT = 'Page.captureScreenshot';
const SCREENSHOT_PARAMS = { format: 'png' };
const BASE64 = 'base64';
const screenshot = async ({ webContents }: CaptureWindow) => {
  const { data } = (await webContents.debugger.sendCommand(SCREENSHOT, SCREENSHOT_PARAMS)) as { data: string };
  return Buffer.from(data, BASE64);
};

export type CaptureWindow = {
  setContentSize(width: number, height: number): void;
  readonly webContents: {
    readonly debugger: {
      attach(version: string): void;
      sendCommand(method: string, params: object): Promise<unknown>;
    };
    executeJavaScript(code: string): Promise<unknown>;
    insertCSS(css: string): Promise<string>;
  };
};

export const captureScreens = async (
  window: CaptureWindow,
  dir: string,
  write: (path: string, data: Uint8Array) => void,
): Promise<string[]> => {
  const { webContents } = window;
  await prepare(window);
  const files: string[] = [];
  const shoot = async (prefix: string) => {
    for (const { name: themeName, features } of CAPTURE_THEMES) {
      await webContents.debugger.sendCommand(EMULATE_MEDIA, { features });
      for (const { name, width } of CAPTURE_LAYOUTS) {
        window.setContentSize(width, WINDOW_HEIGHT);
        await webContents.executeJavaScript(settleProbe(name, features));
        const file = join(dir, `${prefix}${name}-${themeName}${PNG_EXTENSION}`);
        write(file, await screenshot(window));
        files.push(file);
      }
    }
  };
  await shoot(HOME_PREFIX);
  await webContents.executeJavaScript(CONTINUE_FIRST_CAMPAIGN);
  await shoot(PLAYING_PREFIX);
  return files;
};

export const JOURNEY_ENV = 'RPG_DESKTOP_JOURNEY';
const MACOS = 'darwin';
export const headlessRun = (env: NodeJS.ProcessEnv, platform: string) => {
  const hidden = Boolean(env[SMOKE_ENV]);
  return { hidden, accessory: hidden && platform === MACOS };
};

export const JOURNEY_ERROR = 'rpg-desktop-journey-error: ';
export const JOURNEY_ACTION = 'I try to climb the wall';
export const JOURNEY_EDIT = { fieldId: 'might', value: 8 } as const;
export const SHOT_DATA_EXTENSION = '.json';

const JOURNEY_TIMEOUT_MS = 60000;
const WIDE_LAYOUT = 'wide';
const JOURNEY_RULESET = 'Classic d20';
const PORTUGUESE_RULESET = 'd20 clássico';
const JOURNEY_GUIDE = 'Guide me';
const JOURNEY_FEATURE = 'Dice animation';
const DICELESS_RULESET = 'Story only';
const DICELESS_NAME = 'Mara';
const DICE_QUESTION = 'Who rolls the dice';
const DICELESS_CHARACTER = 'A lighthouse keeper named Mara who hears the sea talk.';
const UNUSED_PARTS = '[data-region="sheet"], [data-rolls], [data-motion-control]';
const PORTUGUESE_GUIDE = 'Me guie';
const PORTUGUESE_FEATURE = 'Animação de dados';
const JOURNEY_CHARACTER = 'A scout named Wren with might 6, agility 5, wits 7 and presence 4.';
const RANDOM_REGIONS = '[data-rolls], [data-voice-progress], [data-voice-diagnostics]';
const CONNECTED = `document.querySelector('[role=status][data-connection="connected"]')`;
const PLAY_READY = `document.querySelector('main[data-screen="play"] [data-region="conversation"] li:not([aria-busy])') && document.querySelector('[data-region="sheet"] h3')`;
const DICELESS_PLAY_READY = `document.querySelector('main[data-screen="play"] [data-region="conversation"] li:not([aria-busy])') && document.querySelector('[data-region="character"] h3')`;
const GM_REPLIED = `((gm) => gm && gm.textContent.trim() !== gm.querySelector('[data-speaker-label]').textContent.trim())(document.querySelector('[data-region="conversation"] li:last-child [data-speaker="gm"]'))`;
const LIVE_ROLL = '[data-roll-skip], [data-roll][data-animated="true"]';
const SETTLED = `!document.querySelector('[data-roll-skip], [data-changed], [aria-busy]')`;

const until = (condition: string) => `new Promise((resolve, reject) => {
  const deadline = Date.now() + ${JOURNEY_TIMEOUT_MS};
  const poll = () => {
    if (${condition}) return resolve(true);
    if (Date.now() > deadline) return reject(new Error(${JSON.stringify(`timed out waiting for ${condition}`)}));
    setTimeout(poll, ${SETTLE_POLL_MS});
  };
  poll();
})`;
const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).click();`;
const clickOption = (text: string) =>
  `[...document.querySelectorAll('[data-start-option]')].find((option) => option.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})).click();`;
const optionNamed = (text: string) =>
  `[...document.querySelectorAll('[data-start-option]')].find((option) => option.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))`;
const chooseOption = (text: string, step: string) =>
  `await ${until(optionNamed(text))}; ${clickOption(text)} await ${until(`document.querySelector('[data-start-title="${step}"]')`)};`;
const nextStep = (step: string) =>
  `${click('[data-start-control="next"]')} await ${until(`document.querySelector('[data-start-title="${step}"]')`)};`;
const steps = (...parts: readonly string[]) => `(async () => { ${parts.join(' ')} })()`;

const JOURNEY_LISTENER = `window.${BRIDGE_KEY}.onLine((line) => { const message = JSON.parse(line); if (message.type === 'Snapshot') window.journeySnapshot = message.snapshot; });`;
const SHEET_INPUT_SELECTOR = `#sheet-field-${JOURNEY_EDIT.fieldId}`;
const SHEET_VALUE = `document.querySelector('[data-stat="${JOURNEY_EDIT.fieldId}"] dd')?.textContent === '${JOURNEY_EDIT.value}'`;

type JourneyStep = {
  readonly script: string;
  readonly shot?: string;
  readonly layouts?: boolean;
  readonly check?: string;
};

const WIDE_ONLY = CAPTURE_LAYOUTS.filter(({ name }) => name === WIDE_LAYOUT);
export const journeyLayouts = ({ layouts }: JourneyStep) => (layouts === true ? CAPTURE_LAYOUTS : WIDE_ONLY);
export const journeyShotName = (shot: string, layout: string, theme: string) =>
  layout === WIDE_LAYOUT ? `${shot}-${theme}` : `${shot}-${layout}-${theme}`;

const FINISH_VOICE_SETUP = steps(
  click('[data-voice-setup="finish"]'),
  `await ${until(`!document.querySelector('[data-voice-step]')`)};`,
  `document.querySelector('[data-settings]').open = true;`,
  `document.querySelector('[data-voice-basic]').scrollIntoView({ block: 'start' });`,
);
const OPEN_ADVANCED_VOICE = steps(
  `document.querySelector('[data-settings]').open = true;`,
  `document.querySelector('[data-voice-npcs]').scrollIntoView({ block: 'start' });`,
);
const OPEN_SOUND = steps(
  `document.querySelector('[data-settings]').open = true;`,
  click('#sound-music'),
  `const volume = document.querySelector('#sound-music-volume'); volume.value = '0.25'; volume.dispatchEvent(new Event('change', { bubbles: true }));`,
  `if (!document.querySelector('#sound-music').checked || document.querySelector('#sound-music-volume').value !== '0.25') throw new Error('the sound toggle or volume did not persist');`,
  `document.querySelector('[data-sound]').scrollIntoView({ block: 'start' });`,
);
const OPEN_GM_SETTINGS = steps(
  `document.querySelector('[data-settings]').open = true;`,
  `document.querySelector('[data-gm-form]').scrollIntoView({ block: 'start' });`,
);
const CHOOSE_STORY_LANGUAGE = steps(
  `document.querySelector('[data-settings]').open = true;`,
  click('[data-story-language="es"]'),
  `await ${until(`document.querySelector('[data-story-language="es"][aria-pressed="true"]')`)};`,
  `document.querySelector('[data-settings]').open = true;`,
  `document.querySelector('[data-language-control]').scrollIntoView({ block: 'start' });`,
);
const SET_UP_VOICE = steps(
  `document.querySelector('[data-settings]').open = true;`,
  click('[data-voice-setup="on"]'),
  `await ${until(`document.querySelector('[data-voice-step="consent"]')`)};`,
  click('[data-voice-setup="accept"]'),
  `await ${until(`document.querySelector('[data-voice-step="ready"]')`)};`,
);

const FIRST_HOME = until(`${CONNECTED} && document.querySelector('main[data-screen="home"] [data-start-open]')`);
const OPEN_START = steps(
  click('[data-start-open]'),
  `await ${until(`document.querySelector('[data-start-title="path"]')`)};`,
);
const guideToRules = (guideOption: string, genre = 'fantasy') => [
  clickOption(guideOption),
  `await ${until(`document.querySelector('[data-start-title="primer"]')`)};`,
  nextStep('genre'),
  `${clickOption(genre)} await ${until(`document.querySelector('[data-start-title="rules"]')`)};`,
];
const guideFromRules = (feature: string, ruleset: string) => [
  `${clickOption(ruleset)} await ${until(`document.querySelector('[data-start-title="character"]')`)};`,
  `document.querySelector('#start-entry').value = ${JSON.stringify(JOURNEY_CHARACTER)};`,
  `document.querySelector('[data-start-form]').requestSubmit();`,
  `await ${until(`document.querySelector('[data-start-title="features"]')`)};`,
  `${clickOption(feature)} await ${until(`document.querySelector('[data-start-option][aria-pressed="true"]')`)};`,
  nextStep('begin'),
];
const spokenStory = (label: string, on: boolean) =>
  steps(
    `[...document.querySelectorAll('[data-start-option]')].find((option) => option.querySelector('[data-option-label]').textContent.trim() === ${JSON.stringify(label)}).click();`,
    `await ${until(`document.querySelector('#start-voice') ${on ? '!==' : '==='} null`)};`,
  );
const BEGIN_TO_SUMMARY = steps(
  nextStep('summary'),
  `await ${until(`document.querySelector('[data-start-control="start"]:not([disabled])')`)};`,
);
const guide = (guideOption: string, feature: string, ruleset: string) =>
  steps(...guideToRules(guideOption), ...guideFromRules(feature, ruleset));
const PORTUGUESE_TO_RULES = steps(...guideToRules(PORTUGUESE_GUIDE, 'fantasia'));
const FIRST_TURN = steps(
  JOURNEY_LISTENER,
  click('[data-start-control="start"]'),
  `await ${until(`document.querySelector('#home-continue-0')`)};`,
  click('#home-continue-0'),
  `await ${until(PLAY_READY)};`,
  `document.querySelector('#action-input').value = ${JSON.stringify(JOURNEY_ACTION)};`,
  `document.querySelector('#action-form').requestSubmit();`,
  `await ${until(`document.querySelector('[data-rolls] [data-roll]') && ${GM_REPLIED} && ${SETTLED}`)};`,
);

const OOC_NOTE = 'Please keep the tone light.';
const OOC_PANEL_SELECTOR = '[data-ooc-panel]';
const OOC_TOGGLE = '#ooc-toggle';
const OPEN_OOC = steps(
  `document.querySelector('[data-settings]').open = false;`,
  click(OOC_TOGGLE),
  `await ${until(`document.querySelector(${JSON.stringify(OOC_PANEL_SELECTOR)}) && document.querySelector('${OOC_TOGGLE}[aria-pressed="true"]')`)};`,
);
const ASK_OOC = steps(
  `document.querySelector('#action-input').value = ${JSON.stringify(OOC_NOTE)};`,
  `document.querySelector('#action-form').requestSubmit();`,
  `await ${until(`document.querySelector('[data-speaker="ooc-gm"]') && document.querySelector('[data-ooc="confirm"]') && ${SETTLED}`)};`,
);
const APPLY_OOC = steps(
  click('[data-ooc="confirm"]'),
  `await ${until(`document.querySelector('[data-ooc-status="applied"]') && ${SETTLED}`)};`,
  click(OOC_TOGGLE),
  `await ${until(`document.querySelector('${OOC_TOGGLE}[aria-pressed="false"]')`)};`,
);
const oocSteps = (prefix: string): readonly JourneyStep[] => [
  { script: OPEN_OOC, shot: `${prefix}ooc-toggle` },
  { script: ASK_OOC, shot: `${prefix}ooc-proposal` },
  { script: APPLY_OOC, shot: `${prefix}ooc-applied` },
];
const NPC_ROLL_ACTION = 'Tam steps out from the bar and brings the cudgel down on me.';
const NPC_ROLL_TURN = steps(
  `document.querySelector('#action-input').value = ${JSON.stringify(NPC_ROLL_ACTION)};`,
  `document.querySelector('#action-form').requestSubmit();`,
  `await ${until(`document.querySelector('[data-rolls] [data-roll]') && ${GM_REPLIED} && ${SETTLED}`)};`,
);

const COLLAPSED_ROLL = steps(`await ${until(`document.querySelector('[data-roll-badge]') && ${SETTLED}`)};`);

const DICELESS_TO_RULES = steps(
  chooseOption(JOURNEY_GUIDE, 'primer'),
  nextStep('genre'),
  chooseOption('fantasy', 'rules'),
);
const DICELESS_TO_SUMMARY = steps(
  chooseOption(DICELESS_RULESET, 'character'),
  `document.querySelector('#start-entry').value = ${JSON.stringify(DICELESS_CHARACTER)};`,
  `document.querySelector('[data-start-form]').requestSubmit();`,
  `await ${until(`document.querySelector('[data-start-title="features"]')`)};`,
  `if ([...document.querySelectorAll('[data-start-option]')].some((option) => option.textContent.includes(${JSON.stringify(JOURNEY_FEATURE)}))) throw new Error('diceless guided start offers dice animation');`,
  nextStep('begin'),
  `if ([...document.querySelectorAll('[data-start-options] h3, h3')].some((heading) => heading.textContent === ${JSON.stringify(DICE_QUESTION)})) throw new Error('diceless begin step asks who rolls the dice');`,
);
const DICELESS_PLAY = steps(
  JOURNEY_LISTENER,
  click('[data-start-control="start"]'),
  `await ${until(`document.querySelector('#home-continue-0')`)};`,
  click('#home-continue-0'),
  `await ${until(`${DICELESS_PLAY_READY} && window.journeySnapshot`)};`,
  `document.querySelector('#action-input').value = ${JSON.stringify(JOURNEY_ACTION)};`,
  `document.querySelector('#action-form').requestSubmit();`,
  `await ${until(`window.journeySnapshot?.turns.length > 1 && ${GM_REPLIED} && ${SETTLED}`)};`,
  `if (document.querySelector(${JSON.stringify(UNUSED_PARTS)})) throw new Error('diceless play shows a sheet, dice or motion setting');`,
  `if (document.querySelector('[data-region="character"] h3').textContent !== ${JSON.stringify(DICELESS_NAME)} || !document.querySelector('[data-region="character"] p').textContent.includes(${JSON.stringify(DICELESS_CHARACTER)})) throw new Error('diceless play lacks the character name and description');`,
);

const REPORT_FORM = '[data-roll-report-form]';
const REPORT_INPUT = '#roll-report-input';
const REPORTED_TOTAL = 14;
const OPEN_REPORT = steps(
  `await ${until(`${CONNECTED} && document.querySelector('#home-continue-0')`)};`,
  click('#home-continue-0'),
  `await ${until(`document.querySelector(${JSON.stringify(REPORT_FORM)}) && ${SETTLED}`)};`,
);
const OFFER_BUTTON = '[data-roll-offer]';
const OPEN_ROLL_OFFER = steps(
  `await ${until(`${CONNECTED} && document.querySelector('#home-continue-0')`)};`,
  click('#home-continue-0'),
  `await ${until(`document.querySelector(${JSON.stringify(OFFER_BUTTON)}) && ${SETTLED}`)};`,
);
const SLASH_MENU = '#slash-menu';
const SLASH_OPTION = '[data-slash]';
const OPEN_SLASH_MENU = steps(
  `const input = document.querySelector('#action-input'); input.focus(); input.value = '/'; input.dispatchEvent(new Event('input', { bubbles: true }));`,
  `await ${until(`!document.querySelector(${JSON.stringify(SLASH_MENU)}).hidden && document.querySelector(${JSON.stringify(`${SLASH_MENU} ${SLASH_OPTION}`)}) && ${SETTLED}`)};`,
);
const SLASH_MENU_PLACEMENT = `(() => {
  const menuElement = document.querySelector(${JSON.stringify(SLASH_MENU)});
  if (menuElement.hidden) throw new Error('slash menu is hidden at ' + innerWidth + 'px');
  const menu = menuElement.getBoundingClientRect();
  const input = document.querySelector('#action-input').getBoundingClientRect();
  const clipped = menu.top < 0 || menu.left < 0 || menu.right > innerWidth || menu.bottom > innerHeight;
  if (clipped || menu.bottom > input.top) throw new Error('slash menu is clipped or overlaps the input at ' + innerWidth + 'px');
})()`;
const SUBMIT_REPORT = steps(
  `document.querySelector(${JSON.stringify(REPORT_INPUT)}).value = '${REPORTED_TOTAL}';`,
  `document.querySelector(${JSON.stringify(REPORT_FORM)}).requestSubmit();`,
  `await ${until(`document.querySelector('[data-rolls] [data-roll][data-reported]') && ${GM_REPLIED} && ${SETTLED}`)};`,
);

const GM_FAILURE_NOTICE = '[data-gm-failure]';
const OPEN_FIRST_CAMPAIGN = steps(
  `await ${until(`${CONNECTED} && document.querySelector('#home-continue-0')`)};`,
  click('#home-continue-0'),
  `await ${until(PLAY_READY)};`,
);
const FAIL_A_TURN = steps(
  `document.querySelector('#action-input').value = ${JSON.stringify(JOURNEY_ACTION)};`,
  `document.querySelector('#action-form').requestSubmit();`,
  `await ${until(`document.querySelector(${JSON.stringify(GM_FAILURE_NOTICE)}) && ${SETTLED}`)};`,
);
const RETRY_FAILED_TURN = steps(
  click('[data-retry-turn]'),
  `await ${until(`${GM_REPLIED} && !document.querySelector(${JSON.stringify(GM_FAILURE_NOTICE)}) && ${SETTLED}`)};`,
);

const OWN_FILES_OPTION = 'My own files';
const OWN_FILE_NAME = 'two-dice.md';
const CHOOSE_OWN_FILES = steps(
  `${clickOption(OWN_FILES_OPTION)} await ${until(`document.querySelector('[data-start-import="pickOwn"]')`)};`,
);
const ADD_OWN_FILES = steps(
  click('[data-start-import="pickOwn"]'),
  `await ${until(`document.body.textContent.includes(${JSON.stringify(OWN_FILE_NAME)})`)};`,
);
const OWN_TO_SUMMARY = steps(
  nextStep('character'),
  `document.querySelector('#start-entry').value = ${JSON.stringify(JOURNEY_CHARACTER)};`,
  `document.querySelector('[data-start-form]').requestSubmit();`,
  `await ${until(`document.querySelector('[data-start-title="features"]')`)};`,
  nextStep('begin'),
  nextStep('summary'),
  `await ${until(`document.querySelector('[data-start-control="start"]:not([disabled])')`)};`,
);
const OWN_CREATED = steps(
  click('[data-start-control="start"]'),
  `await ${until(`document.querySelector('#home-continue-0')`)};`,
);

export const JOURNEY: Readonly<
  Record<
    | 'first'
    | 'reopen'
    | 'portuguese'
    | 'diceless'
    | 'physical'
    | 'failure'
    | 'ownRules'
    | 'rollOffer'
    | 'rollOfferPortuguese'
    | 'slashMenu'
    | 'slashMenuPortuguese'
    | 'npcRoll',
    readonly JourneyStep[]
  >
> = {
  npcRoll: [{ script: OPEN_FIRST_CAMPAIGN }, { script: NPC_ROLL_TURN, shot: 'npc-roll' }],
  rollOffer: [{ script: OPEN_ROLL_OFFER, shot: 'roll-offer' }],
  rollOfferPortuguese: [{ script: OPEN_ROLL_OFFER, shot: 'pt-BR-roll-offer' }],
  slashMenu: [
    { script: OPEN_FIRST_CAMPAIGN },
    { script: OPEN_SLASH_MENU, shot: 'slash-menu', layouts: true, check: SLASH_MENU_PLACEMENT },
  ],
  slashMenuPortuguese: [
    { script: OPEN_FIRST_CAMPAIGN },
    { script: OPEN_SLASH_MENU, shot: 'pt-BR-slash-menu', layouts: true, check: SLASH_MENU_PLACEMENT },
  ],
  failure: [
    { script: OPEN_FIRST_CAMPAIGN },
    { script: FAIL_A_TURN, shot: 'gm-failure-notice' },
    { script: RETRY_FAILED_TURN, shot: 'gm-retry-narrated' },
  ],
  physical: [
    { script: OPEN_REPORT, shot: 'report-field' },
    { script: SUBMIT_REPORT, shot: 'player-rolled' },
  ],
  first: [
    { script: FIRST_HOME, shot: 'first-run-home' },
    { script: OPEN_START, shot: 'guided-start' },
    { script: guide(JOURNEY_GUIDE, JOURNEY_FEATURE, JOURNEY_RULESET), shot: 'guided-begin' },
    { script: spokenStory('On', true), shot: 'guided-begin-voice-on' },
    { script: spokenStory('Off', false) },
    { script: BEGIN_TO_SUMMARY, shot: 'guided-summary' },
    { script: FIRST_TURN, shot: 'first-roll' },
    { script: COLLAPSED_ROLL, shot: 'first-roll-collapsed', layouts: true },
    {
      script: steps(
        `await ${until('window.journeySnapshot?.turns.length > 1')};`,
        click('#sheet-edit'),
        `await ${until(`document.querySelector(${JSON.stringify(SHEET_INPUT_SELECTOR)})`)};`,
        `document.querySelector(${JSON.stringify(SHEET_INPUT_SELECTOR)}).value = '${JOURNEY_EDIT.value}';`,
      ),
      shot: 'sheet-edit',
    },
    {
      script: steps(
        `document.querySelector('[data-sheet-form]').requestSubmit();`,
        `await ${until(`${SHEET_VALUE} && ${SETTLED}`)};`,
      ),
      shot: 'sheet-saved',
    },
    {
      script: steps(
        `document.querySelector('[data-settings]').open = true;`,
        click('[data-voice-setup="on"]'),
        `await ${until(`document.querySelector('[data-voice-step="consent"]')`)};`,
      ),
      shot: 'voice-consent',
    },
    {
      script: steps(
        click('[data-voice-setup="accept"]'),
        `await ${until(`document.querySelector('[data-voice-step="downloading"] progress')`)};`,
      ),
      shot: 'voice-download',
    },
    {
      script: until(`document.querySelector('[data-voice-step="ready"]')`),
      shot: 'voice-ready',
    },
    { script: FINISH_VOICE_SETUP, shot: 'voice-basic' },
    { script: OPEN_ADVANCED_VOICE, shot: 'voice-settings' },
    {
      script: steps(
        click('[data-voice-setup="off"]'),
        `await ${until(`document.querySelector('[data-voice-setup="on"]')`)};`,
        `document.querySelector('[data-settings]').open = false;`,
      ),
    },
    ...oocSteps(''),
  ],
  reopen: [
    { script: until(`${CONNECTED} && document.querySelector('#home-continue-0')`), shot: 'reopen-home' },
    {
      script: steps(
        click('#home-continue-0'),
        `await ${until(`${PLAY_READY} && document.querySelector('[data-rolls] [data-roll]')`)};`,
        `if (document.querySelector(${JSON.stringify(LIVE_ROLL)})) throw new Error('continue shows a live dice card');`,
        `await ${until(SETTLED)};`,
      ),
      shot: 'continue',
    },
  ],
  ownRules: [
    { script: FIRST_HOME },
    { script: OPEN_START },
    { script: DICELESS_TO_RULES, shot: 'own-rules-step' },
    { script: CHOOSE_OWN_FILES, shot: 'own-rules-chosen' },
    { script: ADD_OWN_FILES, shot: 'own-rules-added' },
    { script: OWN_TO_SUMMARY, shot: 'own-rules-summary' },
    { script: OWN_CREATED, shot: 'own-rules-created' },
  ],
  diceless: [
    { script: FIRST_HOME },
    { script: OPEN_START },
    { script: DICELESS_TO_RULES, shot: 'diceless-rules' },
    { script: DICELESS_TO_SUMMARY, shot: 'diceless-begin' },
    { script: BEGIN_TO_SUMMARY, shot: 'diceless-summary' },
    { script: DICELESS_PLAY, shot: 'diceless-play' },
    { script: OPEN_SOUND, shot: 'sound-settings' },
  ],
  portuguese: [
    { script: FIRST_HOME, shot: 'pt-BR-first-run-home' },
    { script: OPEN_START, shot: 'pt-BR-guided-start' },
    { script: PORTUGUESE_TO_RULES, shot: 'pt-BR-rules' },
    { script: steps(...guideFromRules(PORTUGUESE_FEATURE, PORTUGUESE_RULESET)), shot: 'pt-BR-begin' },
    { script: spokenStory('Ligada', true), shot: 'pt-BR-begin-voice-on' },
    { script: spokenStory('Desligada', false) },
    { script: BEGIN_TO_SUMMARY, shot: 'pt-BR-summary' },
    { script: FIRST_TURN, shot: 'pt-BR-play' },
    { script: SET_UP_VOICE },
    { script: FINISH_VOICE_SETUP, shot: 'pt-BR-voice-basic' },
    { script: OPEN_ADVANCED_VOICE, shot: 'pt-BR-voice-settings' },
    { script: OPEN_GM_SETTINGS, shot: 'pt-BR-gm-settings' },
    { script: CHOOSE_STORY_LANGUAGE, shot: 'pt-BR-story-language' },
    ...oocSteps('pt-BR-'),
  ],
};

export const isJourneyPhase = (phase: string | undefined): phase is keyof typeof JOURNEY =>
  phase !== undefined && Object.hasOwn(JOURNEY, phase);

const AUDIT_PROBE = `(() => {
  const numbers = (value) => (value.match(/[\\d.]+/g) ?? []).map(Number);
  const over = (top, under) => { const [r, g, b, a = 1] = top; return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)]; };
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = numbers(getComputedStyle(node).backgroundColor);
      if ((color[3] ?? 1) > 0) layers.push(color);
      if ((color[3] ?? 1) >= 1) break;
    }
    const canvas = matchMedia('(prefers-color-scheme: dark)').matches ? [0, 0, 0] : [255, 255, 255];
    return layers.reduceRight((under, layer) => over(layer, under), canvas);
  };
  const text = (node) => (node?.textContent ?? '').trim();
  const ids = (value) => (value ?? '').split(/\\s+/).filter(Boolean);
  const labelled = (element) => (element.id ? [...document.querySelectorAll('label')].filter((label) => label.htmlFor === element.id).map(text).join(' ') : '') || text(element.closest('label'));
  const nameOf = (element) =>
    element.getAttribute('aria-label')?.trim() ||
    ids(element.getAttribute('aria-labelledby')).map((id) => text(document.getElementById(id))).join(' ').trim() ||
    labelled(element) ||
    (element.getAttribute('alt') ?? '').trim() ||
    (element.getAttribute('title') ?? '').trim() ||
    (['INPUT', 'SELECT', 'TEXTAREA', 'IMG'].includes(element.tagName) ? '' : text(element));
  const hasText = (element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  const textOf = (element) => {
    if (!hasText(element) || element.closest(':disabled')) return undefined;
    const style = getComputedStyle(element);
    const background = backgroundOf(element);
    return { color: over(numbers(style.color), background), background, size: parseFloat(style.fontSize), bold: Number(style.fontWeight) >= 700 };
  };
  return {
    lang: document.documentElement.lang,
    title: document.title,
    elements: [...document.body.querySelectorAll('*')].map((element) => ({
      tag: element.tagName.toLowerCase(),
      id: element.id,
      role: element.getAttribute('role') ?? '',
      type: element.getAttribute('type') ?? '',
      name: nameOf(element),
      refs: [...ids(element.getAttribute('aria-labelledby')), ...ids(element.getAttribute('aria-describedby')), ...ids(element.getAttribute('for'))],
      visible: element.checkVisibility({ visibilityProperty: true }),
      ...(element.checkVisibility({ visibilityProperty: true }) ? { text: textOf(element) } : {}),
    })),
  };
})()`;

const MASK_PROBE = `[...document.querySelectorAll(${JSON.stringify(RANDOM_REGIONS)})].map((element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x: Math.floor(x * devicePixelRatio), y: Math.floor(y * devicePixelRatio), width: Math.ceil(width * devicePixelRatio), height: Math.ceil(height * devicePixelRatio) };
})`;

export const captureJourney = async (
  window: CaptureWindow,
  dir: string,
  write: (path: string, data: Uint8Array) => void,
  journey: readonly JourneyStep[],
): Promise<string[]> => {
  const { webContents } = window;
  await prepare(window);
  window.setContentSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  const files: string[] = [];
  for (const step of journey) {
    await webContents.executeJavaScript(step.script);
    if (step.shot === undefined) continue;
    for (const { name: themeName, features } of CAPTURE_THEMES) {
      await webContents.debugger.sendCommand(EMULATE_MEDIA, { features });
      for (const { name: layout, width: layoutWidth } of journeyLayouts(step)) {
        window.setContentSize(layoutWidth, WINDOW_HEIGHT);
        await webContents.executeJavaScript(settleProbe(layout, features));
        if (step.check !== undefined) await webContents.executeJavaScript(step.check);
        const name = journeyShotName(step.shot, layout, themeName);
        const file = join(dir, `${name}${PNG_EXTENSION}`);
        const png = await screenshot(window);
        write(file, png);
        const { width, height } = decodePng(png);
        const audit = await webContents.executeJavaScript(AUDIT_PROBE);
        const masks = await webContents.executeJavaScript(MASK_PROBE);
        const data = { size: { width, height }, audit, masks };
        write(join(dir, `${name}${SHOT_DATA_EXTENSION}`), Buffer.from(JSON.stringify(data)));
        files.push(file);
      }
    }
    window.setContentSize(WINDOW_WIDTH, WINDOW_HEIGHT);
  }
  return files;
};
