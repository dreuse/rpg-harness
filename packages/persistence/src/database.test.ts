import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  ClosedConnectionError,
  InterruptedMigrationError,
  MIGRATIONS,
  type Migration,
  openDatabase,
  SchemaTooNewError,
} from './database.ts';

const TEMP_PREFIX = 'rpg-persistence-';
const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN_ID = 'campaign-1';
const CAMPAIGN_NAME = 'Lost Mine';
const BROKEN_VERSION = MIGRATIONS.length + 1;

const withTempDir = async (run: (path: string) => void | Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  try {
    await run(join(dir, DATABASE_FILE));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const query = <T>(path: string, read: (database: DatabaseSync) => T) => {
  const database = new DatabaseSync(path);
  try {
    return read(database);
  } finally {
    database.close();
  }
};

const appliedVersions = (path: string) =>
  query(path, (database) =>
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version),
  );

const countCampaigns = (path: string) =>
  query(path, (database) => database.prepare('SELECT COUNT(*) AS total FROM campaign').get()?.total);

const tableExists = (path: string, table: string) =>
  query(
    path,
    (database) =>
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined,
  );

test('create local sqlite database, versioned migrations and repository connection lifecycle', async () => {
  await withTempDir((path) => {
    assert.equal(existsSync(path), false);
    const first = openDatabase(path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(
      first.applied,
      MIGRATIONS.map((migration) => migration.version),
    );
    assert.equal(first.version, MIGRATIONS.length);
    first.close();
    first.close();
    assert.throws(() => first.database, ClosedConnectionError);

    const reopened = openDatabase(path);
    assert.deepEqual(reopened.applied, []);
    assert.equal(reopened.version, MIGRATIONS.length);
    reopened.close();
    assert.deepEqual(
      appliedVersions(path),
      MIGRATIONS.map((migration) => migration.version),
    );
  });
});

test('interrupted migration can be detected or recovered without deleting user data', async () => {
  await withTempDir((path) => {
    const seeded = openDatabase(path);
    seeded.database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, CAMPAIGN_NAME);
    seeded.close();

    const broken: Migration = {
      version: BROKEN_VERSION,
      sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO missing_table VALUES (1);',
    };
    assert.throws(() => openDatabase(path, { migrations: [...MIGRATIONS, broken] }));
    assert.throws(() => openDatabase(path, { migrations: [...MIGRATIONS, broken] }), InterruptedMigrationError);
    assert.equal(tableExists(path, 'half_done'), false);
    assert.equal(countCampaigns(path), 1);

    const fixed: Migration = { version: BROKEN_VERSION, sql: 'CREATE TABLE half_done (id INTEGER);' };
    const recovered = openDatabase(path, { migrations: [...MIGRATIONS, fixed], recover: true });
    assert.deepEqual(recovered.applied, [BROKEN_VERSION]);
    recovered.close();
    assert.equal(countCampaigns(path), 1);

    assert.throws(() => openDatabase(path), SchemaTooNewError);
  });
});
