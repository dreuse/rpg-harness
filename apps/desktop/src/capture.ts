import { join } from 'node:path';
import { WINDOW_HEIGHT, WINDOW_WIDTH } from './main.ts';
import { COMPACT_MAX_WIDTH, MEDIUM_MAX_WIDTH } from './renderer.ts';

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
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 50;
const SELECT_FIRST_CAMPAIGN = `new Promise((resolve) => {
  document.querySelector('[data-campaign]')?.click();
  const deadline = Date.now() + ${SETTLE_TIMEOUT_MS};
  const poll = () => (document.querySelector('[data-region="conversation"] li') || Date.now() > deadline ? resolve() : setTimeout(poll, ${SETTLE_POLL_MS}));
  poll();
})`;
const settleProbe = (layout: string) => `new Promise((resolve) => {
  const deadline = Date.now() + ${SETTLE_TIMEOUT_MS};
  const frames = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
  const poll = () => (document.querySelector('main[data-layout="${layout}"]') || Date.now() > deadline ? frames() : setTimeout(poll, ${SETTLE_POLL_MS}));
  poll();
})`;

export type CaptureWindow = {
  setContentSize(width: number, height: number): void;
  readonly webContents: {
    readonly debugger: {
      attach(version: string): void;
      sendCommand(method: string, params: object): Promise<unknown>;
    };
    executeJavaScript(code: string): Promise<unknown>;
    capturePage(): Promise<{ toPNG(): Uint8Array }>;
  };
};

export const captureScreens = async (
  window: CaptureWindow,
  dir: string,
  write: (path: string, data: Uint8Array) => void,
): Promise<string[]> => {
  const { webContents } = window;
  await webContents.executeJavaScript(SELECT_FIRST_CAMPAIGN);
  webContents.debugger.attach(DEBUGGER_VERSION);
  const files: string[] = [];
  for (const { name: themeName, features } of CAPTURE_THEMES) {
    await webContents.debugger.sendCommand(EMULATE_MEDIA, { features });
    for (const { name, width } of CAPTURE_LAYOUTS) {
      window.setContentSize(width, WINDOW_HEIGHT);
      await webContents.executeJavaScript(settleProbe(name));
      const file = join(dir, `${name}-${themeName}${PNG_EXTENSION}`);
      write(file, (await webContents.capturePage()).toPNG());
      files.push(file);
    }
  }
  return files;
};
