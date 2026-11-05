import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Channel, type CheckResult, isChannel, STABLE_CHANNEL } from './release.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const UPDATE_STATE_FILE = 'updates.json';
export const UPDATES_DIR = 'updates';

const TEXT = 'utf8';
const TEMP_SUFFIX = '.tmp';

export type Backup = { readonly database: string; readonly archive: string };
export type Staged = { readonly version: string; readonly installDir: string };
export type Applied = {
  readonly from: string;
  readonly to: string;
  readonly installDir: string;
  readonly backups: readonly Backup[];
};
export type UpdateState = {
  readonly autoCheck: boolean;
  readonly channel: Channel;
  readonly lastCheckAt?: number;
  readonly staged?: Staged;
  readonly applied?: Applied;
};

export const DEFAULT_STATE: UpdateState = { autoCheck: true, channel: STABLE_CHANNEL };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBackup = (value: unknown): value is Backup =>
  isRecord(value) && typeof value.database === 'string' && typeof value.archive === 'string';

const isStaged = (value: unknown): value is Staged =>
  isRecord(value) && typeof value.version === 'string' && typeof value.installDir === 'string';

const isApplied = (value: unknown): value is Applied =>
  isRecord(value) &&
  typeof value.from === 'string' &&
  typeof value.installDir === 'string' &&
  typeof value.to === 'string' &&
  Array.isArray(value.backups) &&
  value.backups.every(isBackup);

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const readText = (file: string) => {
  try {
    return readFileSync(file, TEXT);
  } catch {
    return '';
  }
};

export const readState = (file: string): UpdateState => {
  const value = parse(readText(file));
  if (!isRecord(value)) return DEFAULT_STATE;
  const { autoCheck, channel, lastCheckAt, staged, applied } = value;
  return {
    autoCheck: typeof autoCheck === 'boolean' ? autoCheck : DEFAULT_STATE.autoCheck,
    channel: isChannel(channel) ? channel : DEFAULT_STATE.channel,
    ...(Number.isFinite(lastCheckAt) && { lastCheckAt: Number(lastCheckAt) }),
    ...(isStaged(staged) && { staged }),
    ...(isApplied(applied) && { applied }),
  };
};

export const writeState = (file: string, state: UpdateState) => {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
};

export const updateState = (file: string, change: (state: UpdateState) => UpdateState) =>
  writeState(file, change(readState(file)));

export const isCheckDue = (state: UpdateState, now: number) =>
  state.autoCheck && (state.lastCheckAt === undefined || now - state.lastCheckAt >= DAY_MS);

export const checkOnStartup = async ({
  stateFile,
  now,
  check,
}: {
  readonly stateFile: string;
  readonly now: number;
  readonly check: () => Promise<CheckResult>;
}): Promise<CheckResult | undefined> => {
  if (!isCheckDue(readState(stateFile), now)) return undefined;
  const result = await check();
  updateState(stateFile, (state) => ({ ...state, lastCheckAt: now }));
  return result;
};
