import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { BRIDGE_KEY, CHANNELS } from './preload.ts';
import { APP_ROOT, bundlePreload, CONTENT_SECURITY_POLICY, PAGE_URL, PRELOAD_SOURCE, serveAsset } from './serve.ts';

const NOT_FOUND = 404;
const OK = 200;
const asset = (path: string) => `rpg://app/${path}`;

test('rpg-42a.7 serves the page with a strict content security policy', async () => {
  const response = await serveAsset(APP_ROOT, PAGE_URL);
  assert.equal(response.status, OK);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(response.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.match(await response.text(), /<script type="module" src="\.\/page\.ts"><\/script>/);
});

test('rpg-42a.7 serves TypeScript modules as plain JavaScript', async () => {
  const response = await serveAsset(APP_ROOT, asset('apps/desktop/src/view.ts'));
  assert.equal(response.status, OK);
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
  const body = await response.text();
  assert.match(body, /export const renderView/);
  assert.doesNotMatch(body, /import type|: ViewModel/);
  const shared = await serveAsset(APP_ROOT, asset('packages/client-protocol/src/protocol.ts'));
  assert.equal(shared.status, OK);
});

test('rpg-42a.7 refuses files outside the renderer sources', async () => {
  for (const url of [
    asset('apps/desktop/src/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json'),
    asset('apps/desktop/src/%2e%2e%2f%2e%2e%2fcli%2fsrc%2fbin.ts'),
    asset('apps/cli/src/bin.ts'),
    asset('package.json'),
    asset('apps/desktop/package.json'),
    asset('apps/desktop/src/missing.ts'),
    'rpg://other/apps/desktop/src/index.html',
  ]) {
    assert.equal((await serveAsset(APP_ROOT, url)).status, NOT_FOUND, url);
  }
});

test('rpg-42a.7 bundles the preload as one sandbox script that exposes the bridge', () => {
  const exposed: Record<string, unknown> = {};
  const sent: unknown[][] = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed[key] = api;
      },
    },
    ipcRenderer: { send: (...args: unknown[]) => sent.push(args), on: () => {} },
  };
  const script = bundlePreload(readFileSync(PRELOAD_SOURCE, 'utf8'));
  assert.doesNotMatch(script, /^\s*(import|export)\b/m);
  runInNewContext(script, { require: (name: string) => (name === 'electron' ? electron : undefined) });
  (exposed[BRIDGE_KEY] as { connect(): void }).connect();
  assert.deepEqual(sent, [[CHANNELS.connect]]);
  assert.equal(PRELOAD_SOURCE, join(APP_ROOT, 'apps/desktop/src/preload.ts'));
});
