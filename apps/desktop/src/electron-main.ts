import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, utilityProcess } from 'electron';
import { DEFAULT_RELEASES_URL, RELEASE_PUBLIC_KEY, RELEASES_URL_ENV } from '../../../packages/updater/src/release.ts';
import { startDaemon } from '../../cli/src/desktop-daemon.ts';
import { dataDirFromEnv } from '../../cli/src/setup-check.ts';
import { CAPTURE_ENV, CAPTURE_STATUS, captureScreens } from './capture.ts';
import { SMOKE_ENV, SMOKE_STATUS, startMain, utilityEngine } from './main.ts';
import { PLATFORMS } from './packaging.ts';
import { APP_ROOT, APP_SCHEME, bundlePreload, PAGE_URL, PRELOAD_SOURCE, serveAsset } from './serve.ts';
import { offerDesktopUpdate, UPDATE_CHOICES } from './update.ts';

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

const UPDATE_BUTTONS = ['Download', 'Later', 'Stop checking'];
const LATER = 1;

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
      const window = BrowserWindow.fromWebContents(contents);
      const dir = process.env[CAPTURE_ENV];
      if (dir && window) {
        mkdirSync(dir, { recursive: true });
        for (const file of await captureScreens(window, dir, writeFileSync))
          process.stdout.write(`${CAPTURE_STATUS}${file}${NEWLINE}`);
      }
      app.quit();
    }),
  );

const backupCampaigns = async (dataDir: string) => {
  const [{ campaignDatabases }, update] = await Promise.all([
    import('../../cli/src/engine-gateway.ts'),
    import('../../cli/src/update.ts'),
  ]);
  update.backupCampaigns(dataDir, campaignDatabases(dataDir));
};

const offerUpdate = async (dataDir: string) => {
  const platform = PLATFORMS.find((known) => known === process.platform);
  if (platform === undefined) return;
  const result = await offerDesktopUpdate({
    dataDir,
    version: app.getVersion(),
    platform,
    arch: process.arch,
    releasesUrl: process.env[RELEASES_URL_ENV] || DEFAULT_RELEASES_URL,
    publicKey: RELEASE_PUBLIC_KEY,
    fetch,
    now: Date.now,
    ask: async (release) => {
      const { response } = await dialog.showMessageBox({
        message: `Version ${release.version} is available.`,
        detail: release.notes,
        buttons: UPDATE_BUTTONS,
        defaultId: LATER,
        cancelId: LATER,
      });
      return UPDATE_CHOICES[response] ?? UPDATE_CHOICES[LATER];
    },
    open: (file) => shell.openPath(file),
    backup: () => backupCampaigns(dataDir),
  });
  if (result.status === 'rejected')
    await dialog.showMessageBox({ message: 'The update was rejected and deleted.', detail: result.reason });
};

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
    startDaemon: (options) => startDaemon({ ...options, spawnEngine: utilityEngine(utilityProcess.fork) }),
  });
  if (app.isPackaged && !process.env[SMOKE_ENV]) offerUpdate(dataDirFromEnv()).catch(() => undefined);
});
