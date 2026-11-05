import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { CAPTURE_LAYOUTS, CAPTURE_THEMES, type CaptureWindow, captureJourney, captureScreens } from './capture.ts';
import { layoutFor } from './renderer.ts';

const DIR = '/shots';
const BASE64 = 'base64';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  BASE64,
);
const SCREENSHOT = 'Page.captureScreenshot';

const fakeWindow = () => {
  const calls: string[] = [];
  const window: CaptureWindow = {
    setContentSize: (width, height) => calls.push(`size ${width}x${height}`),
    webContents: {
      debugger: {
        attach: () => calls.push('attach'),
        sendCommand: async (method, params) => {
          calls.push(`${method} ${JSON.stringify(params)}`);
          return method === SCREENSHOT ? { data: PNG.toString(BASE64) } : {};
        },
      },
      executeJavaScript: async (code) =>
        calls.push(
          code.includes('[data-home="continue"]') ? 'select' : `settle ${/data-layout="(\w+)"/.exec(code)?.[1]}`,
        ),
    },
  };
  return { window, calls };
};

test('rpg-42a.11 capture layouts match the renderer breakpoints', () => {
  for (const { name, width } of CAPTURE_LAYOUTS) assert.equal(layoutFor(width).name, name);
  assert.deepEqual(
    CAPTURE_THEMES.map(({ name }) => name),
    ['light', 'dark', 'high-contrast-light', 'high-contrast-dark'],
  );
});

const shots = (prefix: string) =>
  CAPTURE_THEMES.flatMap((theme) =>
    CAPTURE_LAYOUTS.map((layout) => join(DIR, `${prefix}${layout.name}-${theme.name}.png`)),
  );

test('rpg-42a.11 captureScreens writes the home, then one screenshot per layout and theme', async () => {
  const { window, calls } = fakeWindow();
  const written = new Map<string, Uint8Array>();
  const files = await captureScreens(window, DIR, (path, data) => written.set(path, data));
  const expected = [...shots('home-'), ...shots('')];
  assert.deepEqual(files, expected);
  assert.deepEqual([...written.keys()], expected);
  assert.ok([...written.values()].every((data) => PNG.equals(data)));
  assert.equal(calls[0], 'attach');
  assert.equal(calls.filter((call) => call === 'select').length, 1);
  const media = calls.filter((call) => call.startsWith('Emulation.setEmulatedMedia')).slice(CAPTURE_THEMES.length);
  assert.equal(media.length, CAPTURE_THEMES.length);
  assert.match(media[3] ?? '', /"prefers-color-scheme","value":"dark".*"prefers-contrast","value":"more"/);
  assert.ok(media.every((call) => call.includes('"prefers-reduced-motion","value":"reduce"')));
  assert.deepEqual(
    calls.slice(calls.indexOf('select')).filter((call) => call.startsWith('settle')),
    CAPTURE_THEMES.flatMap(() => CAPTURE_LAYOUTS.map(({ name }) => `settle ${name}`)),
  );
});

test('rpg-42a.30 capture waits until the page matches the emulated theme before each screenshot', async () => {
  const scripts: string[] = [];
  const { window } = fakeWindow();
  const executeJavaScript = window.webContents.executeJavaScript;
  const recorded: CaptureWindow = {
    ...window,
    webContents: {
      ...window.webContents,
      executeJavaScript: (code) => {
        scripts.push(code);
        return executeJavaScript(code);
      },
    },
  };
  await captureScreens(recorded, DIR, () => {});
  const settles = scripts.filter((code) => code.includes('data-layout'));
  assert.ok(
    settles[settles.length - 1]?.includes(
      `matchMedia(${JSON.stringify('(prefers-color-scheme: dark) and (prefers-contrast: more) and (prefers-reduced-motion: reduce)')}).matches`,
    ),
  );
});

const NEVER_READY = {
  document: { querySelector: () => null },
  matchMedia: () => ({ matches: false }),
  setTimeout: (callback: () => void) => queueMicrotask(callback),
  requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
};

test('rpg-42a.32 capture fails instead of shooting when the page never reaches the emulated theme', async () => {
  const scripts: string[] = [];
  const { window } = fakeWindow();
  const executeJavaScript = window.webContents.executeJavaScript;
  const recorded: CaptureWindow = {
    ...window,
    webContents: {
      ...window.webContents,
      executeJavaScript: (code) => {
        scripts.push(code);
        return executeJavaScript(code);
      },
    },
  };
  await captureScreens(recorded, DIR, () => {});
  const settle = scripts.find((code) => code.includes('data-layout')) ?? '';
  let now = 0;
  const clock = { now: () => (now += Number.MAX_SAFE_INTEGER / 2) };
  await assert.rejects(
    runInNewContext(settle, { ...NEVER_READY, Date: clock }) as Promise<unknown>,
    /timed out waiting for/,
  );
});

test('rpg-42a.32 capture takes each screenshot from a freshly presented compositor frame', async () => {
  const { window, calls } = fakeWindow();
  const written = new Map<string, Uint8Array>();
  const files = await captureJourney(window, DIR, (path, data) => written.set(path, data), [
    { script: '', shot: 'home' },
  ]);
  assert.deepEqual(
    calls.filter((call) => call.startsWith(SCREENSHOT)),
    CAPTURE_THEMES.map(() => `${SCREENSHOT} {"format":"png"}`),
  );
  assert.ok(files.every((file) => PNG.equals(written.get(file) ?? new Uint8Array())));
});
