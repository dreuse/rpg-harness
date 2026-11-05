import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const SOURCE = import.meta.dirname;
const TEXT = 'utf8';
const read = (file: string) => readFileSync(join(SOURCE, file), TEXT);
const TOKENS_CSS = 'tokens.css';
const VIEW_CSS = 'view.css';
const PAGE_HTML = 'index.html';
const HIGH_CONTRAST_MEDIA = '@media (prefers-contrast: more)';
const COMMENT = /\/\*[\s\S]*?\*\//g;
const BLOCK = /\{([^{}]*)\}/g;
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i;
const COLOR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|light-dark)\(/i;
const COLOR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|caret|accent|decoration/;
const TOKEN_REFERENCE = /var\(--[\w-]+|calc\(/g;
const NUMBER = /-?\d*\.?\d+[a-z%]*/gi;
const IDENTIFIER = /[a-z][\w-]*/gi;
const ALLOWED_KEYWORDS = new Set([
  'solid',
  'dashed',
  'dotted',
  'double',
  'none',
  'inherit',
  'initial',
  'unset',
  'revert',
  'transparent',
  'currentcolor',
  'inset',
  'auto',
]);
const THEME_TOKEN = /--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi;
const AA_TEXT = 4.5;
const AAA_TEXT = 7;
const NON_TEXT = 3;
const TEXT_PAIRS = [
  ['text', 'surface'],
  ['text', 'surface-raised'],
  ['text-muted', 'surface'],
  ['text-muted', 'surface-raised'],
  ['danger', 'surface'],
  ['danger', 'surface-raised'],
  ['surface-raised', 'accent'],
] as const;
const NON_TEXT_PAIRS = [
  ['accent', 'surface'],
  ['accent', 'surface-raised'],
  ['focus', 'surface'],
  ['focus', 'surface-raised'],
  ['border-strong', 'surface'],
  ['border-strong', 'surface-raised'],
] as const;
const LIGHT = 0;
const DARK = 1;
const CHANNEL_MAX = 255;
const LINEAR_THRESHOLD = 0.04045;
const LINEAR_SLOPE = 12.92;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const GAMMA = 2.4;
const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];
const CONTRAST_OFFSET = 0.05;
const HEX_RADIX = 16;
const CHANNEL_DIGITS = 2;

type Theme = Readonly<Record<string, string>>;

const declarations = (css: string) =>
  [...css.replace(COMMENT, '').matchAll(BLOCK)].flatMap(([, body = '']) =>
    body.split(';').flatMap((declaration) => {
      const colon = declaration.indexOf(':');
      return colon < 0 ? [] : [[declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const];
    }),
  );

const hardCodedColors = (css: string) =>
  declarations(css).filter(([property, value]) => {
    if (HEX_COLOR.test(value) || COLOR_FUNCTION.test(value)) return true;
    if (property.startsWith('--') || !COLOR_PROPERTY.test(property)) return false;
    const rest = value.replace(TOKEN_REFERENCE, ' ').replace(NUMBER, ' ');
    return (rest.match(IDENTIFIER) ?? []).some((word) => !ALLOWED_KEYWORDS.has(word.toLowerCase()));
  });

const themePairs = (css: string) =>
  new Map([...css.matchAll(THEME_TOKEN)].map(([, name = '', light = '', dark = '']) => [name, [light, dark]]));

const themes = (): Readonly<Record<string, Theme>> => {
  const css = read(TOKENS_CSS).replace(COMMENT, '');
  const split = css.indexOf(HIGH_CONTRAST_MEDIA);
  const base = themePairs(css.slice(0, split));
  const contrast = new Map([...base, ...themePairs(css.slice(split))]);
  const pick = (pairs: Map<string, string[]>, side: number) =>
    Object.fromEntries([...pairs].map(([name, values]) => [name, values[side] ?? '']));
  return {
    light: pick(base, LIGHT),
    dark: pick(base, DARK),
    'high-contrast light': pick(contrast, LIGHT),
    'high-contrast dark': pick(contrast, DARK),
  };
};

const luminance = (hex: string) =>
  [1, 3, 5]
    .map((start) => Number.parseInt(hex.slice(start, start + CHANNEL_DIGITS), HEX_RADIX) / CHANNEL_MAX)
    .map((channel) =>
      channel <= LINEAR_THRESHOLD ? channel / LINEAR_SLOPE : ((channel + GAMMA_OFFSET) / GAMMA_SCALE) ** GAMMA,
    )
    .reduce((sum, channel, index) => sum + channel * (LUMINANCE_WEIGHTS[index] ?? 0), 0);

const contrast = (foreground: string, background: string) => {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((high ?? 0) + CONTRAST_OFFSET) / ((low ?? 0) + CONTRAST_OFFSET);
};

test('rpg-42a.11 the page loads the token and view stylesheets and has no inline styles', () => {
  const page = read(PAGE_HTML);
  assert.match(page, new RegExp(`<link rel="stylesheet" href="\\./${TOKENS_CSS}">`));
  assert.match(page, new RegExp(`<link rel="stylesheet" href="\\./${VIEW_CSS}">`));
  assert.ok(page.indexOf(TOKENS_CSS) < page.indexOf(VIEW_CSS));
  assert.doesNotMatch(page, /<style|style=/);
});

test('rpg-42a.11 view CSS uses only design tokens for color', () => {
  assert.deepEqual(hardCodedColors(read(VIEW_CSS)), []);
  assert.deepEqual(
    hardCodedColors('a { color: red; } b { background: #fff; } c { border: 1px solid rgb(0 0 0); }').length,
    3,
  );
  assert.deepEqual(hardCodedColors('a { outline: var(--w) solid var(--focus, white); }').length, 1);
  assert.deepEqual(hardCodedColors('a { color: var(--text); box-shadow: inset var(--w) 0 0 var(--accent); }'), []);
});

test('rpg-42a.11 text contrast passes WCAG AA in light, dark and high-contrast themes', () => {
  const all = themes();
  assert.deepEqual(Object.keys(all), ['light', 'dark', 'high-contrast light', 'high-contrast dark']);
  for (const [name, theme] of Object.entries(all)) {
    const textMinimum = name.startsWith('high-contrast') ? AAA_TEXT : AA_TEXT;
    const pairs = [
      ...TEXT_PAIRS.map((pair) => [...pair, textMinimum] as const),
      ...NON_TEXT_PAIRS.map((pair) => [...pair, NON_TEXT] as const),
    ];
    for (const [foreground, background, minimum] of pairs) {
      const ratio = contrast(theme[foreground] ?? '', theme[background] ?? '');
      assert.ok(ratio >= minimum, `${name}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('rpg-42a.11 tokens follow the OS theme, reduce motion and expose one accent token', () => {
  const tokens = read(TOKENS_CSS);
  assert.match(tokens, /color-scheme: light dark;/);
  assert.match(tokens, /--accent: light-dark\(/);
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\)[\s\S]*--duration-base: 0ms;/);
  assert.ok(tokens.indexOf(HIGH_CONTRAST_MEDIA) > 0);
  const view = read(VIEW_CSS);
  assert.match(view, /\[data-animate="false"\][\s\S]*--duration-base: 0ms;/);
  assert.match(view, /:focus-visible \{[^}]*outline: var\(--focus-width\) solid var\(--focus\);/);
  assert.doesNotMatch(view, /outline:\s*(none|0)\b/);
  assert.doesNotMatch(view, /--accent:/);
});

test('rpg-42a.18 the action form has a labelled input and a Send button that Enter submits', () => {
  const page = read(PAGE_HTML);
  assert.match(page, /<form id="action-form">/);
  assert.match(page, /<label for="action-input">[^<]+<\/label>/);
  assert.match(
    page,
    /<input id="action-input" name="action" autocomplete="off" enterkeyhint="send" placeholder="[^"]+">/,
  );
  assert.match(page, /<button type="submit" aria-keyshortcuts="Enter">Send<\/button>/);
  assert.doesNotMatch(page, />Act</);
});

test('rpg-42a.18 the play screen fills the window height and keeps the action input pinned', () => {
  const view = read(VIEW_CSS);
  assert.match(view, /body \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*height: 100dvh;/);
  assert.match(view, /#app \{[^}]*flex: 1;[^}]*min-height: 0;/);
  assert.match(view, /#action-form \{[^}]*flex: none;/);
  assert.match(view, /\[data-region="conversation"\] > ol \{[^}]*overflow-y: auto;/);
  assert.match(view, /section\[hidden\] \{[^}]*display: none;/);
  for (const layout of ['medium', 'wide'])
    assert.match(view, new RegExp(`main\\[data-layout="${layout}"\\] \\[data-columns\\]`));
});

test('rpg-42a.18 narration reads at a comfortable measure in its own font', () => {
  const tokens = read(TOKENS_CSS);
  assert.match(tokens, /--measure: 70ch;/);
  assert.match(tokens, /--font-narration: [^;]*serif;/);
  assert.match(tokens, /--leading-reading: 1\.[6-9]/);
  const view = read(VIEW_CSS);
  assert.match(view, /\[data-speaker="gm"\] \{[^}]*font-family: var\(--font-narration\);/);
  for (const speaker of ['player', 'gm', 'system'])
    assert.match(view, new RegExp(`\\[data-speaker="${speaker}"\\] \\{`));
});

test('rpg-42a.22 the home hides the action form and primary buttons read on the accent', () => {
  const view = read(VIEW_CSS);
  assert.match(view, /body:has\(main\[data-screen="home"\]\) #action-form \{[^}]*display: none;/);
  assert.match(view, /\[data-primary\] \{[^}]*color: var\(--surface-raised\);[^}]*background: var\(--accent\);/);
});
