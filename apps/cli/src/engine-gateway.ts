import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_INPUT_LENGTH } from '../../../packages/client-protocol/src/protocol.ts';
import type { CampaignState, Turn } from '../../../packages/domain/src/campaign.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { commitCharacter } from '../../../packages/engine/src/character.ts';
import { createEngine, type Engine } from '../../../packages/engine/src/engine.ts';
import { campaignConfigOf, openScene, performAction } from '../../../packages/engine/src/turn.ts';
import { type CampaignConfig, parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import type { BuildInput, BuildResult } from '../../../packages/rules/src/character-builder.ts';
import { D20_LITE_CREATION } from '../../../packages/rules/src/d20-lite.ts';
import { DICE_POOL_LITE_CREATION } from '../../../packages/rules/src/dice-pool-lite.ts';
import { NARRATIVE_CREATION } from '../../../packages/rules/src/narrative.ts';
import { exportArchive, restoreArchive } from './campaign-archive.ts';
import { type Ask, createCharacter } from './character-creation.ts';
import { createClientSessions, scopedEventsOf, worldOf } from './client-session.ts';
import { importRules } from './import-gateway.ts';
import type { CampaignGateway } from './main.ts';
import { describeConfig, type Opening, openingFor, planCampaign } from './quickstart.ts';
import { runTui, type Terminal } from './tui.ts';
import { renderView, type ViewName } from './views.ts';

const DATABASE_EXTENSION = '.sqlite';
const SELECT_CAMPAIGN_ID = 'SELECT id FROM campaign LIMIT 1';
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
const BACKUP_DIR = 'backups';
const ARCHIVE_EXTENSION = '.rpg-archive.json';
const TIME_SEPARATOR = /:/g;
const SAFE_TIME_SEPARATOR = '-';
const NONE = 'none';
const SAVED_SETTINGS = 'Saved settings:';
const CREATION_RULES = [D20_LITE_CREATION, DICE_POOL_LITE_CREATION, NARRATIVE_CREATION];
const CHARACTER_PROMPT = `Describe your character, or press Enter to play as ${HERO_NAME}.`;
const CREATE_CHARACTER_INTENT = 'create character';
const LAUNCH_TEXT = 'Run rpg new <name> "<one sentence>" to start a campaign, or rpg resume <name> to continue one.';

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

const playTui = async (dataDir: string, name: string, terminal: Terminal) => {
  const { engine, campaignId, database, close } = openSession(dataDir, name);
  try {
    const session = createClientSessions(
      engine,
      campaignId,
      scopedEventsOf(database),
      worldOf(database),
    )(PLAYER_VIEWER);
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

const creationRulesFor = (rulepack: CampaignConfig['rulepack']) =>
  CREATION_RULES.find(
    ({ schema: { rulepack: pack } }) =>
      pack.id === rulepack?.id && pack.edition === rulepack.edition && pack.revision === rulepack.revision,
  );

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
    const committed = performAction(store, {
      campaignId,
      actionId: randomUUID(),
      expectedRevision: state.revision,
      sceneId: scene.id,
      actorId: actor.id,
      input,
      intent: input,
    });
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

const readView = (dataDir: string, name: string, view: ViewName) =>
  withSession(
    dataDir,
    name,
    ({ engine, campaignId, database }) => {
      const state = engine.getState(campaignId);
      if (view === RECAP_VIEW) return recapText(name, state);
      const entities = createEntityStore(database);
      const [hero] = state.characters;
      const eventScopes = database
        .prepare(SELECT_EVENT_SCOPES)
        .all(campaignId)
        .map((row) => ({
          id: String(row.id),
          visibility: String(row.visibility) as Visibility,
          actorId: row.actor_id === null ? null : String(row.actor_id),
        }));
      return renderView(view, {
        state,
        entities: entities.listEntities(campaignId),
        relationships: hero === undefined ? [] : entities.listRelationships(campaignId, hero.id),
        eventScopes,
      });
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

const launch = (dataDir: string) => {
  const names = savedCampaigns(dataDir);
  return names.length === 0 ? LAUNCH_TEXT : `Campaigns: ${names.join(', ')}\n${LAUNCH_TEXT}`;
};

const listed = (names: readonly string[]) => (names.length === 0 ? NONE : names.join(', '));

const list = (dataDir: string) =>
  `Campaigns: ${listed(savedCampaigns(dataDir))}\nArchived: ${listed(savedCampaigns(join(dataDir, ARCHIVE_DIR)))}`;

const archive = (dataDir: string, name: string) => {
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

const deletionGuidance = (name: string, path: string, archived: boolean) =>
  [
    `Deleting campaign ${name} removes its saved state for good.`,
    `To back up first, copy ${path} somewhere safe.`,
    ...(archived ? [] : [`Run rpg archive ${name} to hide it and keep its state instead.`]),
    `Type ${name} to delete it, or anything else to keep it.`,
  ].join('\n');

const remove = async function* (dataDir: string, name: string, lines: AsyncIterable<string>) {
  const active = databasePath(dataDir, name);
  const archived = !existsSync(active);
  const path = archived ? archivePath(dataDir, name) : active;
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
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
  const dir = join(dataDir, BACKUP_DIR);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(TIME_SEPARATOR, SAFE_TIME_SEPARATOR);
  const file = join(dir, `${encodeURIComponent(name)}-${stamp}${ARCHIVE_EXTENSION}`);
  exportCampaign(dataDir, name, file);
  return `Backed up campaign ${name} to ${file}.`;
};

const restore = (dataDir: string, file: string) => {
  mkdirSync(dataDir, { recursive: true });
  const { campaign } = restoreArchive(file, dataDir, (name) => databasePath(dataDir, name));
  return `Restored campaign ${campaign}. Run rpg resume ${campaign} to continue.`;
};

export const createEngineGateway = (dataDir: string): CampaignGateway => ({
  launch: () => launch(dataDir),
  list: () => list(dataDir),
  archive: (name) => archive(dataDir, name),
  remove: (name, lines) => remove(dataDir, name, lines),
  exportCampaign: (name, file) => exportCampaign(dataDir, name, file),
  backup: (name) => backup(dataDir, name),
  restore: (file) => restore(dataDir, file),
  create: async function* (name, intent, ask) {
    const config = planCampaign(intent);
    const scene = createCampaign(dataDir, name, openingFor(config, DEFAULT_OPENING), config);
    yield `${SAVED_SETTINGS}\n${describeConfig(config)}\n${scene}`;
    const character = await characterFor(dataDir, name, config, ask);
    if (character !== undefined) yield character;
  },
  view: (name, view) => readView(dataDir, name, view),
  tui: (name, terminal) => playTui(dataDir, name, terminal),
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
