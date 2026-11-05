import { join } from 'node:path';
import { type DownloadResult, downloadVerified } from '../../../packages/updater/src/download.ts';
import { checkForUpdate, type Fetch, type Release } from '../../../packages/updater/src/release.ts';
import {
  checkOnStartup,
  readState,
  UPDATE_STATE_FILE,
  UPDATES_DIR,
  updateState,
} from '../../../packages/updater/src/schedule.ts';
import type { Platform } from './packaging.ts';

export const UPDATE_CHOICES = ['download', 'later', 'never'] as const;

const ASSET_PREFIX = 'rpg-desktop';
const ASSET_EXTENSION: Record<Platform, string> = { darwin: '.dmg', win32: '.exe', linux: '.AppImage' };

export type UpdateChoice = (typeof UPDATE_CHOICES)[number];
export type DesktopUpdateOptions = {
  readonly dataDir: string;
  readonly version: string;
  readonly platform: Platform;
  readonly arch: string;
  readonly releasesUrl: string;
  readonly publicKey: string;
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly ask: (release: Release) => Promise<UpdateChoice>;
  readonly open: (file: string) => Promise<unknown>;
  readonly backup: () => unknown;
};
export type DesktopUpdateResult = DownloadResult | { readonly status: 'none' | 'later' | 'never' };

export const desktopAssetName = (version: string, platform: Platform, arch: string) =>
  `${ASSET_PREFIX}-${version}-${platform}-${arch}${ASSET_EXTENSION[platform]}`;

export const offerDesktopUpdate = async (options: DesktopUpdateOptions): Promise<DesktopUpdateResult> => {
  const stateFile = join(options.dataDir, UPDATE_STATE_FILE);
  const result = await checkOnStartup({
    stateFile,
    now: options.now(),
    check: () =>
      checkForUpdate({
        fetch: options.fetch,
        releasesUrl: options.releasesUrl,
        currentVersion: options.version,
        channel: readState(stateFile).channel,
      }),
  });
  if (result?.status !== 'available') return { status: 'none' };
  const choice = await options.ask(result.release);
  if (choice === 'never') updateState(stateFile, (state) => ({ ...state, autoCheck: false }));
  if (choice !== 'download') return { status: choice };
  await options.backup();
  const download = await downloadVerified({
    fetch: options.fetch,
    release: result.release,
    assetName: desktopAssetName(result.release.version, options.platform, options.arch),
    publicKey: options.publicKey,
    dir: join(options.dataDir, UPDATES_DIR),
  });
  if (download.status === 'verified') await options.open(download.file);
  return download;
};
