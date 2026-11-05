import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import {
  type FinishResult,
  finishUpdate,
  installStaged,
  stageBundle,
  stagedDir,
} from '../../../packages/updater/src/apply.ts';
import { type DownloadResult, downloadVerified } from '../../../packages/updater/src/download.ts';
import {
  type CheckResult,
  checkForUpdate,
  DEFAULT_RELEASES_URL,
  type Fetch,
  isNewer,
  PRE_RELEASE_CHANNEL,
  RELEASE_PUBLIC_KEY,
  RELEASES_URL_ENV,
  STABLE_CHANNEL,
} from '../../../packages/updater/src/release.ts';
import {
  type Applied,
  type Backup,
  checkOnStartup,
  readState,
  UPDATE_STATE_FILE,
  UPDATES_DIR,
  type UpdateState,
  updateState,
} from '../../../packages/updater/src/schedule.ts';
import { backupArchive, replaceFromArchive } from './campaign-archive.ts';

const INSTALL_DIR = resolve(import.meta.dirname, '..', '..', '..');

const STARTUP_TIMEOUT_MS = 3000;
const SOURCE_MARKER = '.git';
const PACKAGE_FILE = join(import.meta.dirname, '..', 'package.json');
const TEXT = 'utf8';
const SESSION_PREFIX = 'session-';
const SESSION_SUFFIX = '.lock';
const ALIVE_SIGNAL = 0;
const NO_SUCH_PROCESS = 'ESRCH';
const SOURCE_CHECKOUT = 'This copy runs from source. Update it with git.';

const cliVersion = (): string => JSON.parse(readFileSync(PACKAGE_FILE, TEXT)).version;

export const cliAssetName = (version: string) => `rpg-cli-${version}.json`;

export type CampaignFile = { readonly name: string; readonly database: string };
export type UpdateRequest = { readonly check: boolean; readonly autoCheck?: boolean; readonly preRelease?: boolean };
export type UpdateContext = {
  readonly dataDir: string;
  readonly installDir: string;
  readonly version: string;
  readonly releasesUrl: string;
  readonly publicKey: string;
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly campaigns: () => readonly CampaignFile[];
  readonly migrate: (database: string) => void;
};
export type StartupResult = { readonly restart: boolean; readonly messages: readonly string[] };

const migrateDatabase = (database: string) => openDatabase(database).close();

export const defaultUpdateContext = (dataDir: string, campaigns: () => readonly CampaignFile[]): UpdateContext => ({
  dataDir,
  installDir: INSTALL_DIR,
  version: cliVersion(),
  releasesUrl: process.env[RELEASES_URL_ENV] || DEFAULT_RELEASES_URL,
  publicKey: RELEASE_PUBLIC_KEY,
  fetch,
  now: Date.now,
  campaigns,
  migrate: migrateDatabase,
});

const stateFile = ({ dataDir }: UpdateContext) => join(dataDir, UPDATE_STATE_FILE);
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const holdSession = (dataDir: string, pid = process.pid) => {
  const file = join(dataDir, `${SESSION_PREFIX}${pid}${SESSION_SUFFIX}`);
  writeFileSync(file, String(pid));
  return () => rmSync(file, { force: true });
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, ALIVE_SIGNAL);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== NO_SUCH_PROCESS;
  }
};

const sessionPid = (name: string) =>
  name.startsWith(SESSION_PREFIX) && name.endsWith(SESSION_SUFFIX)
    ? Number(name.slice(SESSION_PREFIX.length, -SESSION_SUFFIX.length))
    : Number.NaN;

const otherSessionRunning = (dataDir: string) =>
  readdirSync(dataDir).some((name) => {
    const pid = sessionPid(name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    if (isRunning(pid)) return true;
    rmSync(join(dataDir, name), { force: true });
    return false;
  });

const isSourceCheckout = ({ installDir }: UpdateContext) => existsSync(join(installDir, SOURCE_MARKER));

const check = (context: UpdateContext, signal?: AbortSignal) =>
  checkForUpdate({
    fetch: context.fetch,
    releasesUrl: context.releasesUrl,
    currentVersion: context.version,
    channel: readState(stateFile(context)).channel,
    ...(signal && { signal }),
  });

const checkText = (result: CheckResult) => {
  if (result.status === 'available') {
    const { release, current } = result;
    return [`Version ${release.version} is available. You have ${current}.`, release.notes].filter(Boolean).join('\n');
  }
  if (result.status === 'current') return `rpg ${result.version} is up to date.`;
  if (result.status === 'offline') return 'Could not check for updates: you seem to be offline.';
  if (result.status === 'rate-limited') return 'Could not check for updates: GitHub asked to wait. Try again later.';
  return 'Could not check for updates right now.';
};

const downloadText = (result: Exclude<DownloadResult, { status: 'verified' }>) => {
  if (result.status === 'rejected') return `Update rejected: ${result.reason}. The download was deleted.`;
  if (result.status === 'offline') return 'Could not download the update: you seem to be offline.';
  return 'Could not download the update: GitHub asked to wait. Try again later.';
};

const settingsText = ({ autoCheck, channel }: UpdateState) =>
  [
    autoCheck ? 'Automatic update checks are on.' : 'Automatic update checks are off.',
    channel === PRE_RELEASE_CHANNEL ? 'Pre-release versions are included.' : 'Only stable versions are offered.',
  ].join('\n');

const saveSettings = (context: UpdateContext, { autoCheck, preRelease }: UpdateRequest) =>
  updateState(stateFile(context), (state) => ({
    ...state,
    ...(autoCheck !== undefined && { autoCheck }),
    ...(preRelease !== undefined && { channel: preRelease ? PRE_RELEASE_CHANNEL : STABLE_CHANNEL }),
  }));

const withoutStaged = ({ staged: _, ...state }: UpdateState): UpdateState => state;
const withoutApplied = ({ applied: _, ...state }: UpdateState): UpdateState => state;

export const updateCommand = async function* (context: UpdateContext, request: UpdateRequest): AsyncGenerator<string> {
  if (request.autoCheck !== undefined || request.preRelease !== undefined) {
    saveSettings(context, request);
    yield settingsText(readState(stateFile(context)));
    if (!request.check) return;
  }
  const result = await check(context);
  updateState(stateFile(context), (state) => ({ ...state, lastCheckAt: context.now() }));
  yield checkText(result);
  if (result.status !== 'available' || request.check) return;
  if (isSourceCheckout(context)) {
    yield SOURCE_CHECKOUT;
    return;
  }
  const { version } = result.release;
  const download = await downloadVerified({
    fetch: context.fetch,
    release: result.release,
    assetName: cliAssetName(version),
    publicKey: context.publicKey,
    dir: join(context.dataDir, UPDATES_DIR),
  });
  if (download.status !== 'verified') {
    yield downloadText(download);
    return;
  }
  try {
    stageBundle(download.file, context.installDir, version);
  } finally {
    rmSync(download.file, { force: true });
  }
  updateState(stateFile(context), (state) => ({ ...state, staged: { version, installDir: context.installDir } }));
  yield `Version ${version} is ready. It installs the next time you start rpg.`;
};

const finishText = (result: FinishResult) =>
  result.status === 'updated'
    ? `Updated to version ${result.version}.`
    : `The update could not migrate your campaigns: ${result.reason}. Restored version ${result.version} and your campaign backups.`;

const finish = (context: UpdateContext, applied: Applied): StartupResult => {
  try {
    const result = finishUpdate({
      installDir: context.installDir,
      applied,
      migrate: () => {
        for (const { database } of context.campaigns()) context.migrate(database);
      },
      restore: ({ archive, database }) => replaceFromArchive(archive, database),
    });
    return { restart: result.status === 'rolled-back', messages: [finishText(result)] };
  } catch (error) {
    const archives = applied.backups.map(({ archive }) => archive);
    return {
      restart: false,
      messages: [
        [
          `The update to version ${applied.to} failed and could not restore everything: ${reasonOf(error)}.`,
          'Your campaign backups:',
          ...archives,
        ].join('\n'),
      ],
    };
  } finally {
    updateState(stateFile(context), withoutApplied);
  }
};

export const backupCampaigns = (dataDir: string, campaigns: readonly CampaignFile[]): Backup[] =>
  campaigns.map(({ name, database }) => ({ database, archive: backupArchive(dataDir, name, database) }));

const install = (context: UpdateContext, version: string): StartupResult => {
  if (otherSessionRunning(context.dataDir))
    return { restart: false, messages: [`Version ${version} installs when no other rpg session is running.`] };
  const file = stateFile(context);
  try {
    const backups = backupCampaigns(context.dataDir, context.campaigns());
    const applied = { from: context.version, to: version, installDir: context.installDir, backups };
    updateState(file, (state) => ({ ...withoutStaged(state), applied }));
    installStaged(context.installDir);
  } catch (error) {
    discardStaged(context);
    updateState(file, withoutApplied);
    return {
      restart: false,
      messages: [`Could not install version ${version}: ${reasonOf(error)}. Keeping version ${context.version}.`],
    };
  }
  return { restart: true, messages: [`Installing version ${version}. Your campaigns are backed up.`] };
};

const discardStaged = (context: UpdateContext) => {
  rmSync(stagedDir(context.installDir), { recursive: true, force: true });
  updateState(stateFile(context), withoutStaged);
};

const runStartup = async (context: UpdateContext, options: { readonly check: boolean }): Promise<StartupResult> => {
  const { applied, staged } = readState(stateFile(context));
  const ours = ({ installDir }: { readonly installDir: string }) => installDir === context.installDir;
  if (applied !== undefined && ours(applied)) return finish(context, applied);
  if (staged !== undefined && ours(staged)) {
    if (isNewer(staged.version, context.version) && existsSync(stagedDir(context.installDir)))
      return install(context, staged.version);
    discardStaged(context);
  }
  if (!options.check || isSourceCheckout(context)) return { restart: false, messages: [] };
  const result = await checkOnStartup({
    stateFile: stateFile(context),
    now: context.now(),
    check: () => check(context, AbortSignal.timeout(STARTUP_TIMEOUT_MS)),
  });
  if (result?.status !== 'available') return { restart: false, messages: [] };
  return {
    restart: false,
    messages: [`Version ${result.release.version} is available. Run rpg update --check to read the release notes.`],
  };
};

export const startupUpdate = (context: UpdateContext, options: { readonly check: boolean }): Promise<StartupResult> =>
  runStartup(context, options).catch((error: unknown) => ({
    restart: false,
    messages: [`Skipped the update step: ${reasonOf(error)}`],
  }));
