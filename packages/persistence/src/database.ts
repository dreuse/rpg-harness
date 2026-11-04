import { DatabaseSync } from 'node:sqlite';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { FACT_LAYERS, VISIBILITY_LEVELS, type Visibility } from '../../domain/src/entity.ts';

export type Migration = { readonly version: number; readonly sql: string };

export type OpenOptions = {
  readonly migrations?: readonly Migration[];
  readonly recover?: boolean;
  readonly readOnly?: boolean;
};

const GM_VISIBILITY: Visibility = 'gm';
const ACTOR_SCOPED_VISIBILITY: Visibility = 'actor-scoped';
const APPEND_ONLY_EVENTS = 'event_log is append-only';
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const VISIBILITY_CHECK = `CHECK (visibility IN (${sqlList(VISIBILITY_LEVELS)}))`;
const ACTOR_SCOPE_CHECK = `CHECK (visibility <> '${ACTOR_SCOPED_VISIBILITY}' OR actor_id IS NOT NULL)`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: 'CREATE TABLE campaign (id TEXT PRIMARY KEY, name TEXT NOT NULL);' },
  {
    version: 2,
    sql: 'CREATE TABLE event_log (seq INTEGER PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign (id), payload TEXT NOT NULL);',
  },
  {
    version: 3,
    sql: `
      ALTER TABLE campaign ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE campaign ADD COLUMN current_scene_id TEXT REFERENCES scene (id);
      CREATE TABLE character (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign (id), name TEXT NOT NULL);
      CREATE TABLE scene (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign (id), title TEXT NOT NULL);
      CREATE TABLE turn (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaign (id),
        scene_id TEXT NOT NULL REFERENCES scene (id),
        action_id TEXT NOT NULL,
        actor_id TEXT NOT NULL REFERENCES character (id),
        input TEXT NOT NULL,
        narration TEXT NOT NULL,
        revision INTEGER NOT NULL,
        UNIQUE (campaign_id, action_id),
        UNIQUE (campaign_id, revision)
      );
      ALTER TABLE event_log ADD COLUMN id TEXT;
      ALTER TABLE event_log ADD COLUMN turn_id TEXT REFERENCES turn (id);
      ALTER TABLE event_log ADD COLUMN causation_id TEXT REFERENCES event_log (id);
      ALTER TABLE event_log ADD COLUMN type TEXT;
      CREATE UNIQUE INDEX event_log_id ON event_log (id);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE event_log ADD COLUMN branch_id TEXT;
      ALTER TABLE event_log ADD COLUMN revision INTEGER;
      ALTER TABLE event_log ADD COLUMN action_id TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE ruleset_ref (
        campaign_id TEXT NOT NULL REFERENCES campaign (id),
        rulepack_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        PRIMARY KEY (campaign_id, rulepack_id)
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaign (id),
        branch_id TEXT NOT NULL DEFAULT '${MAIN_BRANCH}',
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE TABLE entity (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaign (id),
        branch_id TEXT NOT NULL DEFAULT '${MAIN_BRANCH}',
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        visibility TEXT NOT NULL ${VISIBILITY_CHECK},
        actor_id TEXT REFERENCES entity (id),
        ${ACTOR_SCOPE_CHECK}
      );
      CREATE TABLE fact (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaign (id),
        branch_id TEXT NOT NULL DEFAULT '${MAIN_BRANCH}',
        subject_id TEXT REFERENCES entity (id),
        statement TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN (${sqlList(FACT_LAYERS)})),
        visibility TEXT NOT NULL ${VISIBILITY_CHECK},
        actor_id TEXT REFERENCES entity (id),
        source_event_id TEXT REFERENCES event_log (id),
        ${ACTOR_SCOPE_CHECK}
      );
      ALTER TABLE event_log ADD COLUMN session_id TEXT REFERENCES session (id);
      ALTER TABLE event_log ADD COLUMN visibility TEXT NOT NULL DEFAULT '${GM_VISIBILITY}' ${VISIBILITY_CHECK};
      ALTER TABLE event_log ADD COLUMN actor_id TEXT REFERENCES entity (id) ${ACTOR_SCOPE_CHECK};
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE relationship (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaign (id),
        branch_id TEXT NOT NULL DEFAULT '${MAIN_BRANCH}',
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES entity (id),
        target_id TEXT NOT NULL REFERENCES entity (id),
        data TEXT NOT NULL DEFAULT '{}'
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TRIGGER event_log_no_overwrite BEFORE INSERT ON event_log
        WHEN EXISTS (SELECT 1 FROM event_log WHERE id = NEW.id OR seq = NEW.seq)
        BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_EVENTS}'); END;
      CREATE TRIGGER event_log_no_update BEFORE UPDATE ON event_log
        BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_EVENTS}'); END;
      CREATE TRIGGER event_log_no_delete BEFORE DELETE ON event_log
        BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_EVENTS}'); END;
    `,
  },
];

const STARTED = 'started';
const FINISHED = 'finished';
const NO_VERSION = 0;

const CREATE_JOURNAL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, status TEXT NOT NULL);';
const SELECT_JOURNAL = 'SELECT version, status FROM schema_migrations ORDER BY version';
const MARK_STARTED = 'INSERT OR REPLACE INTO schema_migrations (version, status) VALUES (?, ?)';
const MARK_FINISHED = 'UPDATE schema_migrations SET status = ? WHERE version = ?';

export class ClosedConnectionError extends Error {
  constructor() {
    super('database connection is closed');
  }
}

export class InterruptedMigrationError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`migration ${version} was interrupted; reopen with recover to re-run it`);
    this.version = version;
  }
}

export class SchemaTooNewError extends Error {
  readonly version: number;
  constructor(version: number, known: number) {
    super(`database schema version ${version} is newer than known version ${known}`);
    this.version = version;
  }
}

export class Connection {
  readonly applied: readonly number[];
  readonly version: number;
  #database: DatabaseSync | undefined;

  constructor(database: DatabaseSync, applied: readonly number[], version: number) {
    this.#database = database;
    this.applied = applied;
    this.version = version;
  }

  get database(): DatabaseSync {
    if (this.#database === undefined) throw new ClosedConnectionError();
    return this.#database;
  }

  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }
}

const runMigration = (database: DatabaseSync, migration: Migration) => {
  database.prepare(MARK_STARTED).run(migration.version, STARTED);
  database.exec('BEGIN');
  try {
    database.exec(migration.sql);
    database.prepare(MARK_FINISHED).run(FINISHED, migration.version);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

const migrate = (database: DatabaseSync, migrations: readonly Migration[], recover: boolean) => {
  database.exec(CREATE_JOURNAL);
  const journal = database.prepare(SELECT_JOURNAL).all();
  const interrupted = journal.find((row) => row.status === STARTED);
  if (interrupted !== undefined && !recover) throw new InterruptedMigrationError(Number(interrupted.version));
  const finished = new Set(journal.filter((row) => row.status === FINISHED).map((row) => Number(row.version)));
  const known = Math.max(NO_VERSION, ...migrations.map((migration) => migration.version));
  const current = Math.max(NO_VERSION, ...finished);
  if (current > known) throw new SchemaTooNewError(current, known);
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => !finished.has(m.version));
  for (const migration of pending) runMigration(database, migration);
  return new Connection(
    database,
    pending.map((migration) => migration.version),
    known,
  );
};

export const openDatabase = (
  path: string,
  { migrations = MIGRATIONS, recover = false, readOnly = false }: OpenOptions = {},
) => {
  const database = new DatabaseSync(path, { readOnly });
  try {
    return migrate(database, migrations, recover);
  } catch (error) {
    database.close();
    throw error;
  }
};
