import { join } from 'node:path';
import { WINDOW_HEIGHT, WINDOW_WIDTH } from './main.ts';
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
export const JOURNEY_ERROR = 'rpg-desktop-journey-error: ';
export const JOURNEY_ACTION = 'I try to climb the wall';
export const JOURNEY_EDIT = { fieldId: 'might', value: 8 } as const;
export const SHOT_DATA_EXTENSION = '.json';

const JOURNEY_TIMEOUT_MS = 15000;
const WIDE_LAYOUT = 'wide';
const JOURNEY_RULESET = 'd20-lite';
const JOURNEY_GUIDE = 'Guide me';
const JOURNEY_FEATURE = 'Dice animation';
const DICELESS_RULESET = 'narrative';
const DICELESS_NAME = 'Mara';
const DICELESS_CHARACTER = 'A lighthouse keeper named Mara who hears the sea talk.';
const UNUSED_PARTS = '[data-region="sheet"], [data-rolls], [data-motion-control]';
const PORTUGUESE_GUIDE = 'Me guie';
const PORTUGUESE_FEATURE = 'Animação de dados';
const JOURNEY_CHARACTER = 'A scout named Wren with might 6, agility 5, wits 7 and presence 4.';
const RANDOM_REGIONS = '[data-rolls], [data-voice-progress], [data-voice-diagnostics]';
const CONNECTED = `document.querySelector('[role=status][data-connection="connected"]')`;
const PLAY_READY = `document.querySelector('main[data-screen="play"] [data-region="conversation"] li:not([aria-busy])') && document.querySelector('[data-region="sheet"] h3')`;
const DICELESS_PLAY_READY = `document.querySelector('main[data-screen="play"] [data-region="conversation"] li:not([aria-busy])') && document.querySelector('[data-rules-note]') && document.querySelector('[data-region="panels"] [data-character] h3')`;
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

type JourneyStep = { readonly script: string; readonly shot?: string };

const FIRST_HOME = until(`${CONNECTED} && document.querySelector('main[data-screen="home"] [data-start-open]')`);
const OPEN_START = steps(
  click('[data-start-open]'),
  `await ${until(`document.querySelector('[data-start-title="path"]')`)};`,
);
const guide = (guideOption: string, feature: string) =>
  steps(
    clickOption(guideOption),
    `await ${until(`document.querySelector('[data-start-title="primer"]')`)};`,
    nextStep('genre'),
    `${clickOption('fantasy')} await ${until(`document.querySelector('[data-start-title="rules"]')`)};`,
    `${clickOption(JOURNEY_RULESET)} await ${until(`document.querySelector('[data-start-title="character"]')`)};`,
    `document.querySelector('#start-entry').value = ${JSON.stringify(JOURNEY_CHARACTER)};`,
    `document.querySelector('[data-start-form]').requestSubmit();`,
    `await ${until(`document.querySelector('[data-start-title="features"]')`)};`,
    `${clickOption(feature)} await ${until(`document.querySelector('[data-start-option][aria-pressed="true"]')`)};`,
    nextStep('summary'),
    `await ${until(`document.querySelector('[data-start-control="start"]:not([disabled])')`)};`,
  );
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
  nextStep('summary'),
  `await ${until(`document.querySelector('[data-start-control="start"]:not([disabled])')`)};`,
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
  `if (document.querySelector('[data-character] h3').textContent !== ${JSON.stringify(DICELESS_NAME)} || !document.querySelector('[data-character] p').textContent.includes(${JSON.stringify(DICELESS_CHARACTER)})) throw new Error('diceless play lacks the character name and description');`,
);

export const JOURNEY: Readonly<Record<'first' | 'reopen' | 'portuguese' | 'diceless', readonly JourneyStep[]>> = {
  first: [
    { script: FIRST_HOME, shot: 'first-run-home' },
    { script: OPEN_START, shot: 'guided-start' },
    { script: guide(JOURNEY_GUIDE, JOURNEY_FEATURE), shot: 'guided-summary' },
    { script: FIRST_TURN, shot: 'first-roll' },
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
    {
      script: steps(
        click('[data-voice-setup="finish"]'),
        `await ${until(`!document.querySelector('[data-voice-step]')`)};`,
        `document.querySelector('[data-settings]').open = true;`,
        `document.querySelector('[data-voice-advanced]').open = true;`,
        `document.querySelector('[data-voice-advanced]').scrollIntoView({ block: 'start' });`,
      ),
      shot: 'voice-settings',
    },
    {
      script: steps(
        click('[data-voice-setup="off"]'),
        `await ${until(`document.querySelector('[data-voice-setup="on"]')`)};`,
        `document.querySelector('[data-settings]').open = false;`,
      ),
    },
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
  diceless: [
    { script: FIRST_HOME },
    { script: OPEN_START },
    { script: DICELESS_TO_RULES, shot: 'diceless-rules' },
    { script: DICELESS_TO_SUMMARY, shot: 'diceless-summary' },
    { script: DICELESS_PLAY, shot: 'diceless-play' },
  ],
  portuguese: [
    { script: FIRST_HOME, shot: 'pt-BR-first-run-home' },
    { script: OPEN_START, shot: 'pt-BR-guided-start' },
    { script: guide(PORTUGUESE_GUIDE, PORTUGUESE_FEATURE) },
    { script: FIRST_TURN, shot: 'pt-BR-play' },
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
  for (const { script, shot } of journey) {
    await webContents.executeJavaScript(script);
    if (shot === undefined) continue;
    for (const { name: themeName, features } of CAPTURE_THEMES) {
      await webContents.debugger.sendCommand(EMULATE_MEDIA, { features });
      await webContents.executeJavaScript(settleProbe(WIDE_LAYOUT, features));
      const file = join(dir, `${shot}-${themeName}${PNG_EXTENSION}`);
      const png = await screenshot(window);
      write(file, png);
      const { width, height } = decodePng(png);
      const audit = await webContents.executeJavaScript(AUDIT_PROBE);
      const masks = await webContents.executeJavaScript(MASK_PROBE);
      const data = { size: { width, height }, audit, masks };
      write(join(dir, `${shot}-${themeName}${SHOT_DATA_EXTENSION}`), Buffer.from(JSON.stringify(data)));
      files.push(file);
    }
  }
  return files;
};
