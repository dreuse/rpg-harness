import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { CAPTURE_LAYOUTS, CAPTURE_THEMES, type CaptureWindow, captureScreens } from './capture.ts';
import { layoutFor } from './renderer.ts';

const DIR = '/shots';
const PNG = new Uint8Array([1, 2, 3]);

const fakeWindow = () => {
  const calls: string[] = [];
  const window: CaptureWindow = {
    setContentSize: (width, height) => calls.push(`size ${width}x${height}`),
    webContents: {
      debugger: {
        attach: () => calls.push('attach'),
        sendCommand: async (method, params) => calls.push(`${method} ${JSON.stringify(params)}`),
      },
      executeJavaScript: async (code) =>
        calls.push(code.includes('[data-campaign]') ? 'select' : `settle ${/data-layout="(\w+)"/.exec(code)?.[1]}`),
      capturePage: async () => ({ toPNG: () => PNG }),
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

test('rpg-42a.11 captureScreens writes one screenshot per layout and theme', async () => {
  const { window, calls } = fakeWindow();
  const written = new Map<string, Uint8Array>();
  const files = await captureScreens(window, DIR, (path, data) => written.set(path, data));
  const expected = CAPTURE_THEMES.flatMap((theme) =>
    CAPTURE_LAYOUTS.map((layout) => join(DIR, `${layout.name}-${theme.name}.png`)),
  );
  assert.deepEqual(files, expected);
  assert.deepEqual([...written.keys()], expected);
  assert.ok([...written.values()].every((data) => data === PNG));
  assert.deepEqual(calls.slice(0, 2), ['select', 'attach']);
  const media = calls.filter((call) => call.startsWith('Emulation.setEmulatedMedia'));
  assert.equal(media.length, CAPTURE_THEMES.length);
  assert.match(media[3] ?? '', /"prefers-color-scheme","value":"dark".*"prefers-contrast","value":"more"/);
  assert.ok(media.every((call) => call.includes('"prefers-reduced-motion","value":"reduce"')));
  assert.deepEqual(
    calls.filter((call) => call.startsWith('settle')),
    CAPTURE_THEMES.flatMap(() => CAPTURE_LAYOUTS.map(({ name }) => `settle ${name}`)),
  );
});
