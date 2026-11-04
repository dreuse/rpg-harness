import { posix, win32 } from 'node:path';
import type { GmRoute } from '../../../packages/client-protocol/src/wire.ts';
import { gmRouteOf } from '../../cli/src/desktop-daemon.ts';
import { type DataDirContext, userDataDir } from '../../cli/src/setup-check.ts';

export const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export const APP_NAME = 'RPG Harness';

const LINUX_EXECUTABLE = 'rpg-harness';

export type Platform = (typeof PLATFORMS)[number];
export type Env = DataDirContext['env'];
export type PlatformContext = DataDirContext & { readonly platform: Platform };
export type LaunchDescriptor = {
  readonly platform: Platform;
  readonly installDir: string;
  readonly executable: string;
};
export type FileSystem = { readonly exists: (path: string) => boolean; readonly mkdir: (path: string) => void };
export type Launcher = (executable: string, env: Env) => boolean;
export type SmokeResult = {
  readonly platform: Platform;
  readonly installed: boolean;
  readonly launched: boolean;
  readonly dataDir: string;
  readonly gm: GmRoute;
};

const EXECUTABLE: Record<Platform, readonly string[]> = {
  darwin: [`${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME],
  win32: [`${APP_NAME}.exe`],
  linux: [LINUX_EXECUTABLE],
};

export const launchDescriptor = (platform: Platform, installDir: string): LaunchDescriptor => ({
  platform,
  installDir,
  executable: (platform === 'win32' ? win32 : posix).join(installDir, ...EXECUTABLE[platform]),
});

export const smokeTest = (
  context: PlatformContext & { readonly installDir: string; readonly fs: FileSystem; readonly launch: Launcher },
): SmokeResult => {
  const { platform, env, installDir, fs, launch } = context;
  const { executable } = launchDescriptor(platform, installDir);
  const dataDir = userDataDir(context);
  const installed = fs.exists(executable);
  if (!fs.exists(dataDir)) fs.mkdir(dataDir);
  const launched = installed && launch(executable, env);
  return { platform, installed, launched, dataDir, gm: gmRouteOf(env) };
};
