import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { dataDirFromEnv } from '../../cli/src/setup-check.ts';
import { SMOKE_ENV, SMOKE_STATUS, startMain } from './main.ts';
import { APP_ROOT, APP_SCHEME, bundlePreload, PAGE_URL, PRELOAD_SOURCE, serveAsset } from './serve.ts';

const TEXT = 'utf8';
const NEWLINE = '\n';
const PRELOAD_DIR_PREFIX = 'rpg-desktop-';
const PRELOAD_FILE = 'preload.cjs';
const SMOKE_TIMEOUT_MS = 10000;
const SMOKE_POLL_MS = 100;
const STATUS_PROBE = `new Promise((resolve) => {
  const deadline = Date.now() + ${SMOKE_TIMEOUT_MS};
  const status = () => document.querySelector('[role=status]')?.textContent ?? '';
  const poll = () => (status().startsWith('Connected') || Date.now() > deadline ? resolve(status()) : setTimeout(poll, ${SMOKE_POLL_MS}));
  poll();
})`;

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

const writePreload = () => {
  const path = join(mkdtempSync(join(tmpdir(), PRELOAD_DIR_PREFIX)), PRELOAD_FILE);
  writeFileSync(path, bundlePreload(readFileSync(PRELOAD_SOURCE, TEXT)));
  return path;
};

const reportStatusAndQuit = () =>
  app.once('web-contents-created', (_event, contents) =>
    contents.once('did-finish-load', async () => {
      const status = await contents.executeJavaScript(STATUS_PROBE);
      process.stdout.write(`${SMOKE_STATUS}${status}${NEWLINE}`);
      app.quit();
    }),
  );

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  protocol.handle(APP_SCHEME, (request) => serveAsset(APP_ROOT, request.url));
  if (process.env[SMOKE_ENV]) reportStatusAndQuit();
  startMain({
    BrowserWindow,
    ipcMain,
    fs: { readFileSync, writeFileSync, mkdirSync },
    env: process.env,
    dataDir: dataDirFromEnv(),
    preload: writePreload(),
    page: PAGE_URL,
  });
});
