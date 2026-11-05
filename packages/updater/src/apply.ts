import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Applied, Backup } from './schedule.ts';

export const BUNDLE_FORMAT = 'rpg-release-bundle';

const STAGED_SUFFIX = '.staged';
const PREVIOUS_SUFFIX = '.previous';
const TEMP_SUFFIX = '.tmp';
const BASE64 = 'base64';
const TEXT = 'utf8';
const PARENT = '..';

export type FinishResult =
  | { readonly status: 'updated'; readonly version: string }
  | { readonly status: 'rolled-back'; readonly version: string; readonly reason: string };

export class InvalidBundleError extends Error {
  constructor(reason: string) {
    super(`Update rejected: ${reason}.`);
  }
}

const reject = (reason: string): never => {
  throw new InvalidBundleError(reason);
};

export const stagedDir = (installDir: string) => `${installDir}${STAGED_SUFFIX}`;
export const previousDir = (installDir: string) => `${installDir}${PREVIOUS_SUFFIX}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseBundle = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, TEXT));
  } catch {
    return reject('the build is not readable');
  }
};

const insideTarget = (target: string, path: unknown) => {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return reject('the build has an unsafe file path');
  const full = resolve(target, path);
  const inside = relative(target, full);
  if (inside === '' || inside.startsWith(PARENT) || isAbsolute(inside)) reject('the build has an unsafe file path');
  return full;
};

const writeBundle = (value: unknown, target: string, version: string) => {
  if (!isRecord(value) || value.format !== BUNDLE_FORMAT) return reject('the build has an unknown format');
  if (value.version !== version) reject('the build version does not match the release');
  if (!Array.isArray(value.files)) return reject('the build has no files');
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.data !== 'string') reject('the build has an unreadable file');
    const path = insideTarget(target, isRecord(entry) ? entry.path : undefined);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(String(isRecord(entry) && entry.data), BASE64));
  }
};

export const stageBundle = (bundleFile: string, installDir: string, version: string) => {
  const value = parseBundle(bundleFile);
  const temp = `${installDir}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    writeBundle(value, temp, version);
    rmSync(stagedDir(installDir), { recursive: true, force: true });
    renameSync(temp, stagedDir(installDir));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

export const installStaged = (installDir: string) => {
  const previous = previousDir(installDir);
  rmSync(previous, { recursive: true, force: true });
  renameSync(installDir, previous);
  try {
    renameSync(stagedDir(installDir), installDir);
  } catch (error) {
    renameSync(previous, installDir);
    throw error;
  }
};

const restorePrevious = (installDir: string) => {
  const failed = `${installDir}.${randomUUID()}${TEMP_SUFFIX}`;
  renameSync(installDir, failed);
  renameSync(previousDir(installDir), installDir);
  rmSync(failed, { recursive: true, force: true });
};

export const finishUpdate = ({
  installDir,
  applied,
  migrate,
  restore,
}: {
  readonly installDir: string;
  readonly applied: Applied;
  readonly migrate: () => void;
  readonly restore: (backup: Backup) => void;
}): FinishResult => {
  try {
    migrate();
  } catch (error) {
    if (existsSync(previousDir(installDir))) restorePrevious(installDir);
    for (const backup of applied.backups) restore(backup);
    return {
      status: 'rolled-back',
      version: applied.from,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  rmSync(previousDir(installDir), { recursive: true, force: true });
  return { status: 'updated', version: applied.to };
};
