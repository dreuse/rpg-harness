import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type DatabaseSync, DatabaseSync as Sqlite } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';

export const ARCHIVE_FORMAT = 'rpg-campaign-archive';
export const ARCHIVE_FORMAT_VERSION = 1;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const CHECKSUM = 'sha256';
const BINARY_ENCODING = 'base64';
const TEXT_ENCODING = 'utf8';
const CREATE_EXCLUSIVE = 'wx';
const FILE_EXISTS = 'EEXIST';
const TEMP_SUFFIX = '.tmp';
const JOURNAL_SUFFIX = '-journal';
const INTEGRITY_OK = 'ok';
const FINISHED = 'finished';
const FIRST_VERSION = 1;
const SINGLE_CAMPAIGN = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IN_MEMORY = ':memory:';
const SELECT_CAMPAIGNS = 'SELECT id, name FROM campaign';
const SELECT_PINS = 'SELECT rulepack_id, revision FROM ruleset_ref ORDER BY rulepack_id';
const SELECT_SCHEMA = 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name';
const SELECT_JOURNAL = 'SELECT version, status FROM schema_migrations ORDER BY version';
const INTEGRITY_CHECK = 'PRAGMA integrity_check';
const SNAPSHOT = 'VACUUM INTO ?';
const READ_ONLY = 'r';
const FOREIGN_KEY_CHECK = 'PRAGMA foreign_key_check';
const BACKUP_DIR = 'backups';
const ARCHIVE_EXTENSION = '.rpg-archive.json';
const TIME_SEPARATOR = /:/g;
const SAFE_TIME_SEPARATOR = '-';

export type RulesetPin = { readonly rulepackId: string; readonly revision: string };

export type CampaignArchive = {
  readonly format: typeof ARCHIVE_FORMAT;
  readonly formatVersion: number;
  readonly campaign: string;
  readonly schemaVersion: number;
  readonly rulesets: readonly RulesetPin[];
  readonly sha256: string;
  readonly database: string;
};

export class InvalidArchiveError extends Error {
  constructor(reason: string) {
    super(`Archive rejected: ${reason}.`);
  }
}

const reject = (reason: string): never => {
  throw new InvalidArchiveError(reason);
};

const digest = (bytes: Buffer) => createHash(CHECKSUM).update(bytes).digest('hex');

const isFileExists = (error: unknown) => error instanceof Error && 'code' in error && error.code === FILE_EXISTS;

const plain = (rows: readonly Record<string, unknown>[]) => rows.map((row) => ({ ...row }));

const readPins = (database: DatabaseSync): RulesetPin[] =>
  database
    .prepare(SELECT_PINS)
    .all()
    .map((row) => ({ rulepackId: String(row.rulepack_id), revision: String(row.revision) }));

const readCampaigns = (database: DatabaseSync) => database.prepare(SELECT_CAMPAIGNS).all();

const linkExclusive = (from: string, to: string, exists: string) => {
  try {
    linkSync(from, to);
  } catch (error) {
    if (isFileExists(error)) throw new Error(exists);
    throw error;
  }
};

const writeNew = (path: string, content: string, exists: string) => {
  try {
    writeFileSync(path, content, { flag: CREATE_EXCLUSIVE });
  } catch (error) {
    if (isFileExists(error)) throw new Error(exists);
    rmSync(path, { force: true });
    throw error;
  }
};

const snapshot = (database: DatabaseSync, databaseFile: string) => {
  const temp = `${databaseFile}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    database.prepare(SNAPSHOT).run(temp);
    return readFileSync(temp);
  } finally {
    rmSync(temp, { force: true });
  }
};

const readBounded = (file: string) => {
  const fd = openSync(file, READ_ONLY);
  try {
    if (!fstatSync(fd).isFile()) reject('file is not a valid campaign archive');
    const buffer = Buffer.allocUnsafe(MAX_ARCHIVE_BYTES + 1);
    let total = 0;
    for (let read = -1; read !== 0 && total < buffer.length; total += read) {
      read = readSync(fd, buffer, total, buffer.length - total, null);
    }
    if (total > MAX_ARCHIVE_BYTES) reject(`archive is too large; the limit is ${MAX_ARCHIVE_BYTES} bytes`);
    return buffer.subarray(0, total).toString(TEXT_ENCODING);
  } finally {
    closeSync(fd);
  }
};

export const exportArchive = (databaseFile: string, archiveFile: string): CampaignArchive => {
  const connection = openDatabase(databaseFile);
  let campaign: string;
  let rulesets: RulesetPin[];
  let bytes: Buffer;
  try {
    const [row] = readCampaigns(connection.database);
    if (row === undefined) throw new Error('Campaign has no saved state.');
    campaign = String(row.name);
    rulesets = readPins(connection.database);
    bytes = snapshot(connection.database, databaseFile);
  } finally {
    connection.close();
  }
  const archive: CampaignArchive = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    campaign,
    schemaVersion: connection.version,
    rulesets,
    sha256: digest(bytes),
    database: bytes.toString(BINARY_ENCODING),
  };
  writeNew(archiveFile, JSON.stringify(archive), `An archive file ${archiveFile} already exists.`);
  return archive;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPin = (value: unknown): value is RulesetPin =>
  isRecord(value) && typeof value.rulepackId === 'string' && typeof value.revision === 'string';

const knownVersion = () => Math.max(...MIGRATIONS.map(({ version }) => version));

const parseArchive = (file: string): CampaignArchive => {
  const text = readBounded(file);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    reject('file is not a valid campaign archive');
  }
  if (!isRecord(value) || value.format !== ARCHIVE_FORMAT) return reject('file is not a valid campaign archive');
  if (value.formatVersion !== ARCHIVE_FORMAT_VERSION)
    reject(`unsupported archive format ${String(value.formatVersion)}`);
  const { campaign, schemaVersion, rulesets, sha256, database } = value;
  if (typeof campaign !== 'string' || campaign.trim() === '') reject('campaign name is not allowed');
  if (
    !Number.isInteger(schemaVersion) ||
    Number(schemaVersion) < FIRST_VERSION ||
    Number(schemaVersion) > knownVersion()
  )
    reject(`unsupported schema version ${String(schemaVersion)}`);
  if (!Array.isArray(rulesets) || !rulesets.every(isPin)) reject('rulesets must list rulepack pins');
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) reject('checksum is missing');
  if (typeof database !== 'string') reject('database is missing');
  return value as CampaignArchive;
};

const referenceSchema = (version: number) => {
  const connection = openDatabase(IN_MEMORY, { migrations: MIGRATIONS.filter((m) => m.version <= version) });
  try {
    return plain(connection.database.prepare(SELECT_SCHEMA).all());
  } finally {
    connection.close();
  }
};

const expectedJournal = (version: number) =>
  MIGRATIONS.filter((m) => m.version <= version).map((m) => ({ version: m.version, status: FINISHED }));

const inspectSchema = (file: string, { schemaVersion }: CampaignArchive) => {
  let database: DatabaseSync | undefined;
  try {
    database = new Sqlite(file, { readOnly: true });
    if (database.prepare(INTEGRITY_CHECK).get()?.integrity_check !== INTEGRITY_OK) reject('database is corrupt');
    const journal = plain(database.prepare(SELECT_JOURNAL).all());
    if (!isDeepStrictEqual(journal, expectedJournal(schemaVersion))) reject('schema version does not match database');
    if (!isDeepStrictEqual(plain(database.prepare(SELECT_SCHEMA).all()), referenceSchema(schemaVersion)))
      reject('database schema is not a campaign schema');
  } catch (error) {
    if (error instanceof InvalidArchiveError) throw error;
    reject('database schema is not readable');
  } finally {
    database?.close();
  }
};

const inspectContent = (file: string, { campaign, rulesets }: CampaignArchive) => {
  const connection = openDatabase(file);
  try {
    const { database } = connection;
    if (database.prepare(FOREIGN_KEY_CHECK).all().length > 0) reject('database has broken references');
    const campaigns = readCampaigns(database);
    const [row] = campaigns;
    if (campaigns.length !== SINGLE_CAMPAIGN || row === undefined || row.name !== campaign)
      reject('campaign name does not match database');
    if (!isDeepStrictEqual(readPins(database), rulesets)) reject('rulepack pins do not match database');
    createEngine(createCampaignStore(database)).getState(String(row?.id));
  } finally {
    connection.close();
  }
};

const readArchive = (archiveFile: string) => {
  const archive = parseArchive(archiveFile);
  const bytes = Buffer.from(archive.database, BINARY_ENCODING);
  if (bytes.length > MAX_ARCHIVE_BYTES) reject('database is too large');
  if (digest(bytes) !== archive.sha256) reject('checksum does not match');
  return { archive, bytes };
};

export const backupArchive = (dataDir: string, name: string, databaseFile: string): string => {
  const dir = join(dataDir, BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(TIME_SEPARATOR, SAFE_TIME_SEPARATOR);
  const file = join(dir, `${encodeURIComponent(name)}-${stamp}${ARCHIVE_EXTENSION}`);
  exportArchive(databaseFile, file);
  return file;
};

export const replaceFromArchive = (archiveFile: string, databaseFile: string) => {
  const { bytes } = readArchive(archiveFile);
  const temp = `${databaseFile}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    writeFileSync(temp, bytes, { flag: CREATE_EXCLUSIVE });
    renameSync(temp, databaseFile);
  } finally {
    rmSync(temp, { force: true });
  }
};

export const restoreArchive = (
  archiveFile: string,
  dataDir: string,
  campaignPath: (name: string) => string,
): CampaignArchive => {
  const { archive, bytes } = readArchive(archiveFile);
  const target = resolve(campaignPath(archive.campaign));
  if (dirname(target) !== resolve(dataDir)) reject('campaign name is not allowed');
  const temp = resolve(dataDir, `.${randomUUID()}${TEMP_SUFFIX}`);
  writeFileSync(temp, bytes, { flag: CREATE_EXCLUSIVE });
  try {
    inspectSchema(temp, archive);
    inspectContent(temp, archive);
    linkExclusive(temp, target, `A campaign named ${archive.campaign} already exists.`);
  } finally {
    rmSync(temp, { force: true });
    rmSync(`${temp}${JOURNAL_SUFFIX}`, { force: true });
  }
  return archive;
};
