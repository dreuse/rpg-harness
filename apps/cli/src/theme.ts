import { WriteStream } from 'node:tty';

export type ColorDepth = 'none' | '16' | '256' | 'truecolor';
export type Role = 'title' | 'accent' | 'muted';
export type Style = { readonly colors: ColorDepth; readonly unicode: boolean };

type Output = { readonly isTTY?: boolean };
type Glyphs = {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
};

const DEPTH_BY_BITS: Readonly<Record<number, ColorDepth>> = { 1: 'none', 4: '16', 8: '256', 24: 'truecolor' };
const DUMB_TERM = 'dumb';
const UTF8_LOCALE = /utf-?8/i;
const ESCAPE = '\x1b[';
const SGR_END = 'm';
const BOLD_OFF = '22';
const DEFAULT_FOREGROUND = '39';
const CODES: Readonly<Record<Role, Readonly<Record<Exclude<ColorDepth, 'none'>, readonly [string, string]>>>> = {
  title: { '16': ['1', BOLD_OFF], '256': ['1', BOLD_OFF], truecolor: ['1', BOLD_OFF] },
  muted: { '16': ['2', BOLD_OFF], '256': ['2', BOLD_OFF], truecolor: ['2', BOLD_OFF] },
  accent: {
    '16': ['36', DEFAULT_FOREGROUND],
    '256': ['38;5;67', DEFAULT_FOREGROUND],
    truecolor: ['38;2;111;134;198', DEFAULT_FOREGROUND],
  },
};
const CORNERS = 2;
const TITLE_LEAD = 1;
const PADDING = ' ';
export const FRAME_COLUMNS = 4;

const UNICODE_GLYPHS: Glyphs = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
};
const UNICODE_FOCUSED: Glyphs = {
  topLeft: '┏',
  topRight: '┓',
  bottomLeft: '┗',
  bottomRight: '┛',
  horizontal: '━',
  vertical: '┃',
};
const ASCII_GLYPHS: Glyphs = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
};
const ASCII_FOCUSED: Glyphs = { ...ASCII_GLYPHS, horizontal: '=' };

export const colorDepthOf = (env: NodeJS.ProcessEnv, output: Output): ColorDepth =>
  output.isTTY !== true && env.FORCE_COLOR === undefined
    ? 'none'
    : (DEPTH_BY_BITS[WriteStream.prototype.getColorDepth(env)] ?? 'none');

export const supportsUnicode = (env: NodeJS.ProcessEnv) =>
  env.TERM !== DUMB_TERM && UTF8_LOCALE.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');

export const paint = (colors: ColorDepth, role: Role, text: string) => {
  if (colors === 'none') return text;
  const [open, close] = CODES[role][colors];
  return `${ESCAPE}${open}${SGR_END}${text}${ESCAPE}${close}${SGR_END}`;
};

const glyphsFor = ({ unicode }: Style, focused: boolean) =>
  unicode ? (focused ? UNICODE_FOCUSED : UNICODE_GLYPHS) : focused ? ASCII_FOCUSED : ASCII_GLYPHS;

export const frame = (
  style: Style,
  title: string,
  rows: readonly string[],
  width: number,
  focused: boolean,
): string[] => {
  const glyphs = glyphsFor(style, focused);
  const edge = (text: string) => paint(style.colors, focused ? 'accent' : 'muted', text);
  const inner = width - FRAME_COLUMNS;
  const label = `${PADDING}${title}${PADDING}`.slice(0, width - CORNERS - TITLE_LEAD);
  const rest = width - CORNERS - TITLE_LEAD - label.length;
  return [
    `${edge(glyphs.topLeft + glyphs.horizontal)}${paint(style.colors, 'title', label)}${edge(glyphs.horizontal.repeat(rest) + glyphs.topRight)}`,
    ...rows.map((row) => `${edge(glyphs.vertical)}${PADDING}${row.padEnd(inner)}${PADDING}${edge(glyphs.vertical)}`),
    edge(glyphs.bottomLeft + glyphs.horizontal.repeat(width - CORNERS) + glyphs.bottomRight),
  ];
};
