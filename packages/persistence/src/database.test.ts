import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MAIN_BRANCH, PLAYER_TURN, SYSTEM_TURN } from '../../domain/src/campaign.ts';
import { createCampaignStore } from './campaign-store.ts';
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
const LEGACY_VERSION = 2;
const LEGACY_EVENT = JSON.stringify({ type: 'CampaignCreated', name: CAMPAIGN_NAME });

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

test('upgrading a v2 database keeps campaigns and legacy events', async () => {
  await withTempDir((path) => {
    const legacy = openDatabase(path, { migrations: MIGRATIONS.slice(0, LEGACY_VERSION) });
    legacy.database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, CAMPAIGN_NAME);
    legacy.database
      .prepare('INSERT INTO event_log (campaign_id, payload) VALUES (?, ?)')
      .run(CAMPAIGN_ID, LEGACY_EVENT);
    legacy.close();

    const upgraded = openDatabase(path);
    assert.deepEqual(
      upgraded.applied,
      MIGRATIONS.slice(LEGACY_VERSION).map((migration) => migration.version),
    );
    upgraded.close();
    assert.equal(countCampaigns(path), 1);
    assert.deepEqual(
      query(path, (database) => ({ ...database.prepare('SELECT revision, current_scene_id FROM campaign').get() })),
      { revision: 0, current_scene_id: null },
    );
    assert.deepEqual(
      query(path, (database) => ({ ...database.prepare('SELECT payload, id, turn_id FROM event_log').get() })),
      { payload: LEGACY_EVENT, id: null, turn_id: null },
    );
  });
});

const CAMPAIGN_TABLES = [
  'campaign',
  'event_log',
  'character',
  'scene',
  'turn',
  'entity',
  'fact',
  'ruleset_ref',
  'session',
] as const;
const PREVIOUS_VERSION = MIGRATIONS.length - 1;
const NO_PRIOR_VERSION = 0;
const FUTURE_VERSION = MIGRATIONS.length + 1;
const DEFAULT_EVENT_VISIBILITY = 'gm';
const UNKNOWN_VISIBILITY = 'everyone';
const PUBLIC_VISIBILITY = 'public';
const ACTOR_SCOPED_VISIBILITY = 'actor-scoped';
const CANON_LAYER = 'canon';
const UNKNOWN_LAYER = 'gossip';
const ENTITY_ID = 'entity-1';
const SECOND_ENTITY_ID = 'entity-2';
const FACT_ID = 'fact-1';
const SECOND_FACT_ID = 'fact-2';
const SESSION_ID = 'session-1';
const ENTITY_KIND = 'npc';
const STATEMENT = 'The mine is haunted';
const STARTED_AT = '2026-01-01T00:00:00Z';
const CHECK_FAILED = /CHECK constraint failed/;
const UPGRADE_PHRASE = 'upgrades preserve user data and reject incompatible schema versions predictably';

test('implement migrations for campaign, entities, ruleset refs, facts, events, sessions and visibility', async () => {
  await withTempDir((path) => {
    const connection = openDatabase(path);
    const { database } = connection;
    database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, CAMPAIGN_NAME);
    const insertEntity = database.prepare(
      'INSERT INTO entity (id, campaign_id, kind, name, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertFact = database.prepare(
      'INSERT INTO fact (id, campaign_id, statement, layer, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertEvent = database.prepare(
      'INSERT INTO event_log (campaign_id, payload, visibility, actor_id) VALUES (?, ?, ?, ?)',
    );

    insertEntity.run(ENTITY_ID, CAMPAIGN_ID, ENTITY_KIND, CAMPAIGN_NAME, PUBLIC_VISIBILITY, null);
    insertFact.run(FACT_ID, CAMPAIGN_ID, STATEMENT, CANON_LAYER, ACTOR_SCOPED_VISIBILITY, ENTITY_ID);
    insertEvent.run(CAMPAIGN_ID, LEGACY_EVENT, ACTOR_SCOPED_VISIBILITY, ENTITY_ID);
    database
      .prepare('INSERT INTO session (id, campaign_id, started_at) VALUES (?, ?, ?)')
      .run(SESSION_ID, CAMPAIGN_ID, STARTED_AT);

    assert.throws(
      () => insertEntity.run(SECOND_ENTITY_ID, CAMPAIGN_ID, ENTITY_KIND, CAMPAIGN_NAME, UNKNOWN_VISIBILITY, null),
      CHECK_FAILED,
    );
    assert.throws(
      () => insertEntity.run(SECOND_ENTITY_ID, CAMPAIGN_ID, ENTITY_KIND, CAMPAIGN_NAME, ACTOR_SCOPED_VISIBILITY, null),
      CHECK_FAILED,
    );
    assert.throws(
      () => insertFact.run(SECOND_FACT_ID, CAMPAIGN_ID, STATEMENT, CANON_LAYER, ACTOR_SCOPED_VISIBILITY, null),
      CHECK_FAILED,
    );
    assert.throws(
      () => insertFact.run(SECOND_FACT_ID, CAMPAIGN_ID, STATEMENT, UNKNOWN_LAYER, PUBLIC_VISIBILITY, null),
      CHECK_FAILED,
    );
    assert.throws(() => insertEvent.run(CAMPAIGN_ID, LEGACY_EVENT, UNKNOWN_VISIBILITY, null), CHECK_FAILED);
    assert.throws(() => insertEvent.run(CAMPAIGN_ID, LEGACY_EVENT, ACTOR_SCOPED_VISIBILITY, null), CHECK_FAILED);

    for (const table of ['entity', 'fact', 'session']) {
      assert.deepEqual(
        { ...database.prepare(`SELECT branch_id FROM ${table}`).get() },
        { branch_id: MAIN_BRANCH },
        table,
      );
    }
    connection.close();
    for (const table of CAMPAIGN_TABLES) assert.equal(tableExists(path, table), true, table);
  });
});

test(`${UPGRADE_PHRASE} - preserves rows`, async () => {
  await withTempDir((path) => {
    const legacy = openDatabase(path, { migrations: MIGRATIONS.slice(0, PREVIOUS_VERSION) });
    legacy.database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, CAMPAIGN_NAME);
    legacy.database
      .prepare('INSERT INTO event_log (campaign_id, payload) VALUES (?, ?)')
      .run(CAMPAIGN_ID, LEGACY_EVENT);
    legacy.close();

    const upgraded = openDatabase(path);
    assert.deepEqual(upgraded.applied, [MIGRATIONS.length]);
    upgraded.close();
    assert.deepEqual(
      query(path, (database) => ({ ...database.prepare('SELECT id, name FROM campaign').get() })),
      { id: CAMPAIGN_ID, name: CAMPAIGN_NAME },
    );
    assert.deepEqual(
      query(path, (database) => ({
        ...database.prepare('SELECT payload, visibility, session_id FROM event_log').get(),
      })),
      { payload: LEGACY_EVENT, visibility: DEFAULT_EVENT_VISIBILITY, session_id: null },
    );
  });
});

test(`${UPGRADE_PHRASE} - rejects newer version`, async () => {
  await withTempDir(async (path) => {
    const future: Migration = { version: FUTURE_VERSION, sql: 'CREATE TABLE future_only (id INTEGER);' };
    openDatabase(path, { migrations: [...MIGRATIONS, future] }).close();
    const before = await readFile(path);

    assert.throws(() => openDatabase(path), SchemaTooNewError);
    assert.deepEqual(await readFile(path), before);
  });
});

const versionsAfter = (version: number) =>
  MIGRATIONS.map((migration) => migration.version).filter((candidate) => candidate > version);

test('D08: migrations apply in version order, are idempotent and upgrade every older schema without data loss', async () => {
  await withTempDir((path) => {
    const fresh = openDatabase(path, { migrations: [...MIGRATIONS].reverse() });
    assert.deepEqual(fresh.applied, versionsAfter(NO_PRIOR_VERSION));
    fresh.close();
    const reopened = openDatabase(path);
    reopened.close();
    assert.deepEqual(reopened.applied, []);
  });
  for (const { version } of MIGRATIONS.slice(0, PREVIOUS_VERSION)) {
    await withTempDir((path) => {
      const legacy = openDatabase(path, { migrations: MIGRATIONS.slice(0, version) });
      legacy.database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, CAMPAIGN_NAME);
      legacy.close();

      const upgraded = openDatabase(path);
      assert.deepEqual(upgraded.applied, versionsAfter(version), `from v${version}`);
      upgraded.close();
      assert.deepEqual(
        query(path, (database) => ({ ...database.prepare('SELECT id, name FROM campaign').get() })),
        { id: CAMPAIGN_ID, name: CAMPAIGN_NAME },
        `from v${version}`,
      );
    });
  }
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

const BEFORE_KIND_VERSION = 8;
const SYSTEM_TURN_ID = 'turn-system';
const PLAY_TURN_ID = 'turn-play';
const INSERT_KIND_TURN =
  "INSERT INTO turn (id, campaign_id, scene_id, action_id, actor_id, input, narration, revision) VALUES (?, ?, 'scene-1', ?, 'hero', 'input', '', ?)";
const INSERT_KIND_EVENT =
  "INSERT INTO event_log (id, campaign_id, branch_id, revision, action_id, turn_id, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')";

test('rpg-cm63.20: upgrading marks stored sheet turns as system and keeps play turns', async () => {
  await withTempDir((path) => {
    const legacy = openDatabase(path, { migrations: MIGRATIONS.slice(0, BEFORE_KIND_VERSION) });
    const { database } = legacy;
    database.prepare('INSERT INTO campaign (id, name) VALUES (?, ?)').run(CAMPAIGN_ID, CAMPAIGN_NAME);
    database.prepare('INSERT INTO character (id, campaign_id, name) VALUES (?, ?, ?)').run('hero', CAMPAIGN_ID, 'Hero');
    database.prepare('INSERT INTO scene (id, campaign_id, title) VALUES (?, ?, ?)').run('scene-1', CAMPAIGN_ID, 'Gate');
    database.prepare(INSERT_KIND_TURN).run(SYSTEM_TURN_ID, CAMPAIGN_ID, 'a1', 1);
    database.prepare(INSERT_KIND_TURN).run(PLAY_TURN_ID, CAMPAIGN_ID, 'a2', 2);
    const insertEvent = database.prepare(INSERT_KIND_EVENT);
    insertEvent.run('e1', CAMPAIGN_ID, MAIN_BRANCH, 1, 'a1', SYSTEM_TURN_ID, 'CharacterCreated');
    insertEvent.run('e2', CAMPAIGN_ID, MAIN_BRANCH, 2, 'a2', PLAY_TURN_ID, 'PlayerActionSubmitted');
    database.prepare('UPDATE campaign SET revision = 2, current_scene_id = ? WHERE id = ?').run('scene-1', CAMPAIGN_ID);
    legacy.close();

    const upgraded = openDatabase(path);
    const kinds = upgraded.database.prepare('SELECT id, kind FROM turn ORDER BY revision').all();
    assert.deepEqual(
      kinds.map((row) => ({ ...row })),
      [
        { id: SYSTEM_TURN_ID, kind: SYSTEM_TURN },
        { id: PLAY_TURN_ID, kind: PLAYER_TURN },
      ],
    );
    const turns = createCampaignStore(upgraded.database).load(CAMPAIGN_ID)?.turns ?? [];
    assert.deepEqual(
      turns.map(({ kind }) => kind),
      [SYSTEM_TURN, undefined],
    );
    upgraded.close();
  });
});
