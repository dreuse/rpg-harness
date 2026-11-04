import { accessSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = 'rpg';
const DATA_DIR_ENV = 'RPG_DATA_DIR';
const MIN_NODE_MAJOR = 24;
const SQLITE_MODULE = 'node:sqlite';

export type SetupProbes = { readonly nodeVersion: string; readonly hasSqlite: boolean };

const userDataDir = (): string => {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR);
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR);
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), APP_DIR);
};

export const dataDirFromEnv = (): string => process.env[DATA_DIR_ENV] || userDataDir();

const nodeMajor = (version: string) => Number.parseInt(version.replace(/^v/, ''), 10);

export const setupProblem = ({ nodeVersion, hasSqlite }: SetupProbes): string | undefined => {
  if (!(nodeMajor(nodeVersion) >= MIN_NODE_MAJOR))
    return `rpg needs Node.js ${MIN_NODE_MAJOR} or newer, found ${nodeVersion}.`;
  if (!hasSqlite) return `rpg needs the built-in ${SQLITE_MODULE} module. Install Node.js ${MIN_NODE_MAJOR} or newer.`;
  return undefined;
};

export const dataDirProblem = (dataDir: string): string | undefined => {
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
    return undefined;
  } catch {
    return `Cannot write to the data folder ${dataDir}. Set ${DATA_DIR_ENV} to a writable folder.`;
  }
};

export const firstRunProblem = (dataDir: string): string | undefined =>
  setupProblem({ nodeVersion: process.version, hasSqlite: process.getBuiltinModule(SQLITE_MODULE) !== undefined }) ??
  dataDirProblem(dataDir);
