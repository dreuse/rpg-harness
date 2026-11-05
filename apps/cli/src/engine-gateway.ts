import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type CampaignHealth,
  type CampaignSummary,
  type CreateCampaign,
  MAX_INPUT_LENGTH,
} from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignId, CampaignState, Turn } from '../../../packages/domain/src/campaign.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { commitCharacter, editSheetField } from '../../../packages/engine/src/character.ts';
import { createEngine, type Engine } from '../../../packages/engine/src/engine.ts';
import { campaignConfigOf, openScene, performAction } from '../../../packages/engine/src/turn.ts';
import { type CampaignConfig, parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';
import type { BuildInput, BuildResult } from '../../../packages/rules/src/character-builder.ts';
import { backupArchive, exportArchive, restoreArchive } from './campaign-archive.ts';
import { type Ask, createCharacter } from './character-creation.ts';
import {
  campaignSummaryOf,
  createClientSessions,
  type SheetPort,
  scopedEventsOf,
  type WorldSource,
  worldOf,
} from './client-session.ts';
import { importRules } from './import-gateway.ts';
import type { CampaignGateway } from './main.ts';
import {
  creationRulesFor,
  describeConfig,
  type Opening,
  openingFor,
  planCampaign,
  planCampaignFrom,
  startingCharacter,
} from './quickstart.ts';
import { checkFor } from './roll-visualization.ts';
import { runTui, type Terminal } from './tui.ts';
import { runHome } from './tui-home.ts';
import { guidedStart } from './tui-start.ts';
import { type CampaignFile, defaultUpdateContext, updateCommand } from './update.ts';
import { editableSheet, renderView, type ViewName } from './views.ts';

const DATABASE_EXTENSION = '.sqlite';
const SELECT_CAMPAIGN_ID = 'SELECT id FROM campaign LIMIT 1';
const SELECT_SCHEMA_VERSION = 'SELECT MAX(version) AS version FROM schema_migrations';
const KNOWN_SCHEMA_VERSION = Math.max(...MIGRATIONS.map(({ version }) => version));
const UNREADABLE: CampaignHealth = 'unreadable';
const NEEDS_MIGRATION: CampaignHealth = 'needs-migration';
const UNREAD_SUMMARY = {
  id: null,
  sceneTitle: null,
  characters: [],
  ruleset: null,
  genre: null,
  lastNarration: null,
  turnCount: 0,
} as const;
const SELECT_EVENT_SCOPES = 'SELECT id, visibility, actor_id FROM event_log WHERE campaign_id = ?';
const RECAP_VIEW = 'recap';
const CREATE_EXCLUSIVE = 'wx';
const FILE_EXISTS = 'EEXIST';
const HERO_NAME = 'The Wanderer';
const DEFAULT_OPENING: Opening = {
  title: 'The Crossroads Inn',
  narration: 'Rain drums on the roof of the Crossroads Inn. A stranger by the fire looks up as you enter.',
};
const ARCHIVE_DIR = 'archive';
const NONE = 'none';
const SAVED_SETTINGS = 'Saved settings:';
const CHARACTER_PROMPT = `Describe your character, or press Enter to play as ${HERO_NAME}.`;
const CREATE_CHARACTER_INTENT = 'create character';

const databasePath = (dataDir: string, name: string) =>
  join(dataDir, `${encodeURIComponent(name)}${DATABASE_EXTENSION}`);

const archivePath = (dataDir: string, name: string) => databasePath(join(dataDir, ARCHIVE_DIR), name);

const missingCampaign = (dataDir: string, name: string) =>
  existsSync(archivePath(dataDir, name))
    ? new Error(`Campaign ${name} is archived.`)
    : new Error(`No campaign named ${name}. Run rpg new ${name} first.`);

type Session = {
  engine: Engine;
  store: ReturnType<typeof createCampaignStore>;
  campaignId: string;
  database: ReturnType<typeof openDatabase>['database'];
};

const openSession = (dataDir: string, name: string, readOnly = false): Session & { close: () => void } => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  if (readOnly) openDatabase(path).close();
  const connection = openDatabase(path, { readOnly });
  try {
    const { database } = connection;
    const store = createCampaignStore(database);
    const row = database.prepare(SELECT_CAMPAIGN_ID).get();
    if (row === undefined) throw new Error(`Campaign ${name} has no saved state.`);
    const close = () => connection.close();
    return { engine: createEngine(store), store, campaignId: String(row.id), database, close };
  } catch (error) {
    connection.close();
    throw error;
  }
};

const withSession = <T>(dataDir: string, name: string, run: (session: Session) => T, readOnly = false): T => {
  const session = openSession(dataDir, name, readOnly);
  try {
    return run(session);
  } finally {
    session.close();
  }
};

const sheetsOf = ({ engine, store }: Session, readWorld: WorldSource): SheetPort => ({
  read: (campaignId, actorId) =>
    editableSheet({ state: engine.getState(campaignId), eventScopes: [], ...readWorld(campaignId, actorId) }, actorId),
  commit: (edit) => {
    editSheetField(store, edit);
  },
});

export const openClientSession = (dataDir: string, name: string) => {
  const opened = openSession(dataDir, name);
  const { engine, campaignId, database, close } = opened;
  try {
    const readWorld = worldOf(database);
    const sessions = createClientSessions(
      engine,
      campaignId,
      scopedEventsOf(database),
      readWorld,
      sheetsOf(opened, readWorld),
    );
    return { session: sessions(PLAYER_VIEWER), campaignId, close };
  } catch (error) {
    close();
    throw error;
  }
};

const playTui = async (dataDir: string, name: string, terminal: Terminal) => {
  const { session, campaignId, close } = openClientSession(dataDir, name);
  try {
    await runTui(session, campaignId, terminal);
  } finally {
    close();
  }
};

export const readCampaignState = (dataDir: string, name: string): CampaignState =>
  withSession(dataDir, name, ({ engine, campaignId }) => engine.getState(campaignId));

const sceneText = (title: string, narration: string) => `${title}\n${narration}`;

const narrate = (actor: string, turn: Turn) => `${actor}: ${turn.input}\nThe world shifts in answer.`;

const isFileExists = (error: unknown) => error instanceof Error && 'code' in error && error.code === FILE_EXISTS;

const claimFile = (path: string, name: string) => {
  try {
    closeSync(openSync(path, CREATE_EXCLUSIVE));
  } catch (error) {
    if (isFileExists(error)) throw new Error(`A campaign named ${name} already exists.`);
    throw error;
  }
};

const createCampaign = (dataDir: string, name: string, opening: Opening, config: CampaignConfig): string => {
  mkdirSync(dataDir, { recursive: true });
  const path = databasePath(dataDir, name);
  claimFile(path, name);
  let connection: ReturnType<typeof openDatabase> | undefined;
  try {
    connection = openDatabase(path);
    const store = createCampaignStore(connection.database);
    const campaign = createEngine(store).createCampaign(name);
    openScene(store, {
      campaignId: campaign.id,
      actorName: HERO_NAME,
      sceneTitle: opening.title,
      narration: opening.narration,
      config,
    });
    connection.close();
  } catch (error) {
    connection?.close();
    rmSync(path, { force: true });
    throw error;
  }
  return sceneText(opening.title, opening.narration);
};

const unfinishedText = (result: Exclude<BuildResult, { status: 'created' }>) =>
  `Character not created, you play as ${HERO_NAME}: ${
    result.status === 'pending'
      ? `no answer for ${result.questions.map(({ label, fieldId }) => label ?? fieldId).join(', ')}`
      : result.issues.map(({ path, message }) => `${path} ${message}`).join('; ')
  }.`;

const addCharacter = (dataDir: string, name: string, build: BuildInput): string =>
  withSession(dataDir, name, ({ engine, store, campaignId }) => {
    const state = engine.getState(campaignId);
    const [actor] = state.characters;
    const scene = state.currentScene;
    if (actor === undefined || scene === undefined) throw new Error(`Campaign ${name} has no opening scene.`);
    commitCharacter(store, {
      campaignId,
      actionId: randomUUID(),
      expectedRevision: state.revision,
      sceneId: scene.id,
      actorId: actor.id,
      input: build.backstory,
      intent: CREATE_CHARACTER_INTENT,
      build,
    });
    return `Created ${build.proposal.name}.`;
  });

const characterFor = async (dataDir: string, name: string, config: CampaignConfig, ask: Ask) => {
  const rules = creationRulesFor(config.rulepack);
  const description =
    rules === undefined ? undefined : (await ask(CHARACTER_PROMPT))?.trim().slice(0, MAX_INPUT_LENGTH);
  if (rules === undefined || !description) return undefined;
  const { build, result } = await createCharacter(rules, description, ask);
  return result.status === 'created' ? addCharacter(dataDir, name, build) : unfinishedText(result);
};

const act = (dataDir: string, name: string, input: string): string =>
  withSession(dataDir, name, ({ engine, store, campaignId }) => {
    const state = engine.getState(campaignId);
    const [actor] = state.characters;
    const scene = state.currentScene;
    if (actor === undefined || scene === undefined) throw new Error(`Campaign ${name} has no opening scene.`);
    const committed = performAction(
      store,
      {
        campaignId,
        actionId: randomUUID(),
        expectedRevision: state.revision,
        sceneId: scene.id,
        actorId: actor.id,
        input,
        intent: input,
      },
      checkFor(state.events, input, actor.id),
    );
    return narrate(actor.name, committed.turn);
  });

const recap = (characters: CampaignState['characters'], last: Turn | undefined) => {
  const actor = characters.find(({ id }) => id === last?.actorId);
  if (last === undefined || actor === undefined) return DEFAULT_OPENING.narration;
  return last.narration.trim() === '' ? narrate(actor.name, last) : last.narration;
};

const savedSettings = (events: CampaignState['events']) => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok ? [describeConfig(saved.config)] : [];
};

const recapText = (name: string, { currentScene, characters, turns, events }: CampaignState) =>
  [...savedSettings(events), sceneText(currentScene?.title ?? name, recap(characters, turns.at(-1)))].join('\n');

const viewSourceOf = (database: Session['database'], campaignId: CampaignId, state: CampaignState) => ({
  state,
  eventScopes: database
    .prepare(SELECT_EVENT_SCOPES)
    .all(campaignId)
    .map((row) => ({
      id: String(row.id),
      visibility: String(row.visibility) as Visibility,
      actorId: row.actor_id === null ? null : String(row.actor_id),
    })),
  ...worldOf(database)(campaignId, state.characters[0]?.id),
});

const readView = (dataDir: string, name: string, view: ViewName) =>
  withSession(
    dataDir,
    name,
    ({ engine, campaignId, database }) => {
      const state = engine.getState(campaignId);
      if (view === RECAP_VIEW) return recapText(name, state);
      return renderView(view, viewSourceOf(database, campaignId, state));
    },
    true,
  );

const decodedName = (encoded: string): string[] => {
  try {
    return [decodeURIComponent(encoded)];
  } catch {
    return [];
  }
};

const savedCampaigns = (dataDir: string) =>
  existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((file) => file.endsWith(DATABASE_EXTENSION))
        .flatMap((file) => decodedName(file.slice(0, -DATABASE_EXTENSION.length)))
        .sort()
    : [];

const readSummary = (path: string, lastPlayedAt: string): CampaignSummary | CampaignHealth => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = database.prepare(SELECT_SCHEMA_VERSION).get()?.version;
    if (version !== KNOWN_SCHEMA_VERSION) return Number(version) < KNOWN_SCHEMA_VERSION ? NEEDS_MIGRATION : UNREADABLE;
    const row = database.prepare(SELECT_CAMPAIGN_ID).get();
    if (row === undefined) return UNREADABLE;
    const campaignId = String(row.id);
    const state = createEngine(createCampaignStore(database)).getState(campaignId);
    return campaignSummaryOf(viewSourceOf(database, campaignId, state), PLAYER_VIEWER, lastPlayedAt);
  } finally {
    database.close();
  }
};

export const summaryOf = (dataDir: string, name: string): CampaignSummary => {
  let lastPlayedAt: string | null = null;
  try {
    const path = databasePath(dataDir, name);
    lastPlayedAt = statSync(path).mtime.toISOString();
    const read = readSummary(path, lastPlayedAt);
    return typeof read === 'string' ? { ...UNREAD_SUMMARY, name, health: read, lastPlayedAt } : { ...read, name };
  } catch {
    return { ...UNREAD_SUMMARY, name, health: UNREADABLE, lastPlayedAt };
  }
};

export const listCampaignSummaries = (dataDir: string): CampaignSummary[] =>
  savedCampaigns(dataDir).map((name) => summaryOf(dataDir, name));

export const listArchivedSummaries = (dataDir: string): CampaignSummary[] =>
  listCampaignSummaries(join(dataDir, ARCHIVE_DIR));

const listed = (names: readonly string[]) => (names.length === 0 ? NONE : names.join(', '));

const list = (dataDir: string) =>
  `Campaigns: ${listed(savedCampaigns(dataDir))}\nArchived: ${listed(savedCampaigns(join(dataDir, ARCHIVE_DIR)))}`;

export const archiveCampaign = (dataDir: string, name: string) => {
  const from = databasePath(dataDir, name);
  const to = archivePath(dataDir, name);
  if (!existsSync(from)) throw missingCampaign(dataDir, name);
  mkdirSync(join(dataDir, ARCHIVE_DIR), { recursive: true });
  try {
    linkSync(from, to);
  } catch (error) {
    if (isFileExists(error)) throw new Error(`An archived campaign named ${name} already exists.`);
    throw error;
  }
  rmSync(from);
  return `Archived campaign ${name}. Its saved state is kept in ${to}.`;
};

export const unarchiveCampaign = (dataDir: string, name: string) => {
  const from = archivePath(dataDir, name);
  if (!existsSync(from)) throw new Error(`No archived campaign named ${name}.`);
  try {
    linkSync(from, databasePath(dataDir, name));
  } catch (error) {
    if (isFileExists(error)) throw new Error(`A campaign named ${name} already exists.`);
    throw error;
  }
  rmSync(from);
};

const deletionGuidance = (name: string, path: string, archived: boolean) =>
  [
    `Deleting campaign ${name} removes its saved state for good.`,
    `To back up first, copy ${path} somewhere safe.`,
    ...(archived ? [] : [`Run rpg archive ${name} to hide it and keep its state instead.`]),
    `Type ${name} to delete it, or anything else to keep it.`,
  ].join('\n');

const savedFile = (dataDir: string, name: string) => {
  const active = databasePath(dataDir, name);
  const archived = !existsSync(active);
  const path = archived ? archivePath(dataDir, name) : active;
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  return { path, archived };
};

const fileIdentity = (dataDir: string, name: string) => {
  const stats = statSync(databasePath(dataDir, name), { throwIfNoEntry: false });
  return stats === undefined ? undefined : `${stats.dev}:${stats.ino}`;
};

export const isSameCampaignFile = (dataDir: string, name: string, other: string) => {
  const identity = fileIdentity(dataDir, name);
  return identity !== undefined && identity === fileIdentity(dataDir, other);
};

export const deleteCampaign = (dataDir: string, name: string, confirm: string, archived = false) => {
  const path = archived ? archivePath(dataDir, name) : savedFile(dataDir, name).path;
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  if (confirm !== name) throw new Error(`Kept campaign ${name}: send its name as the confirm token to delete it.`);
  rmSync(path);
};

export const createCampaignFrom = (dataDir: string, { name, intent, choices }: CreateCampaign): CampaignSummary => {
  const config = choices === undefined ? planCampaign(intent) : planCampaignFrom(choices);
  const character = startingCharacter(config);
  createCampaign(dataDir, name, openingFor(config, DEFAULT_OPENING), config);
  try {
    if (character !== undefined) addCharacter(dataDir, name, character);
  } catch (error) {
    rmSync(databasePath(dataDir, name), { force: true });
    throw error;
  }
  return summaryOf(dataDir, name);
};

const remove = async function* (dataDir: string, name: string, lines: AsyncIterable<string>) {
  const { path, archived } = savedFile(dataDir, name);
  yield deletionGuidance(name, path, archived);
  let answer: string | undefined;
  for await (const line of lines) {
    answer = line.trim();
    break;
  }
  if (answer !== name) {
    yield `Kept campaign ${name}.`;
    return;
  }
  rmSync(path);
  yield `Deleted campaign ${name}.`;
};

const exportCampaign = (dataDir: string, name: string, file: string) => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  const { rulesets } = exportArchive(path, file);
  return `Exported campaign ${name} with ${rulesets.length} rulepack pin(s) to ${file}.`;
};

const backup = (dataDir: string, name: string) => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  return `Backed up campaign ${name} to ${backupArchive(dataDir, name, path)}.`;
};

export const campaignDatabases = (dataDir: string): CampaignFile[] => [
  ...savedCampaigns(dataDir).map((name) => ({ name, database: databasePath(dataDir, name) })),
  ...savedCampaigns(join(dataDir, ARCHIVE_DIR)).map((name) => ({ name, database: archivePath(dataDir, name) })),
];

const restore = (dataDir: string, file: string) => {
  mkdirSync(dataDir, { recursive: true });
  const { campaign } = restoreArchive(file, dataDir, (name) => databasePath(dataDir, name));
  return `Restored campaign ${campaign}. Run rpg resume ${campaign} to continue.`;
};

export const createEngineGateway = (dataDir: string): CampaignGateway => ({
  home: (terminal) =>
    runHome(
      {
        list: () => listCampaignSummaries(dataDir),
        archived: () => listArchivedSummaries(dataDir),
        archive: (name) => void archiveCampaign(dataDir, name),
        unarchive: (name) => unarchiveCampaign(dataDir, name),
        remove: (name, confirm, archived) => deleteCampaign(dataDir, name, confirm, archived),
        play: (name, playing) => playTui(dataDir, name, playing),
        start: (lines) => guidedStart(dataDir, lines, createCampaignFrom),
      },
      terminal,
    ),
  list: () => list(dataDir),
  archive: (name) => archiveCampaign(dataDir, name),
  remove: (name, lines) => remove(dataDir, name, lines),
  exportCampaign: (name, file) => exportCampaign(dataDir, name, file),
  backup: (name) => backup(dataDir, name),
  restore: (file) => restore(dataDir, file),
  update: (request) =>
    updateCommand(
      defaultUpdateContext(dataDir, () => campaignDatabases(dataDir)),
      request,
    ),
  create: async function* (name, intent, ask) {
    const config = planCampaign(intent);
    const scene = createCampaign(dataDir, name, openingFor(config, DEFAULT_OPENING), config);
    yield `${SAVED_SETTINGS}\n${describeConfig(config)}\n${scene}`;
    const character = await characterFor(dataDir, name, config, ask);
    if (character !== undefined) yield character;
  },
  view: (name, view) => readView(dataDir, name, view),
  tui: (name, terminal) => playTui(dataDir, name, terminal),
  start: (lines) => guidedStart(dataDir, lines, createCampaignFrom),
  importRules: (files, lines) => importRules(process.cwd(), files, lines),
  open: async function* (name, _mode, lines, onTurnError) {
    yield readView(dataDir, name, RECAP_VIEW);
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let narration: string;
      try {
        narration = act(dataDir, name, line.trim());
      } catch (error) {
        onTurnError(error);
        continue;
      }
      yield narration;
    }
  },
});
