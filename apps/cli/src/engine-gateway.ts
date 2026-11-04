import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CampaignState, Turn } from '../../../packages/domain/src/campaign.ts';
import { createEngine, type Engine } from '../../../packages/engine/src/engine.ts';
import { openScene, performAction } from '../../../packages/engine/src/turn.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { importRules } from './import-gateway.ts';
import type { CampaignGateway } from './main.ts';
import { describeConfig, planCampaign } from './quickstart.ts';

const APP_DIR = 'rpg';
const DATABASE_EXTENSION = '.sqlite';
const SELECT_CAMPAIGN_ID = 'SELECT id FROM campaign LIMIT 1';
const CREATE_EXCLUSIVE = 'wx';
const FILE_EXISTS = 'EEXIST';
const HERO_NAME = 'The Wanderer';
const OPENING_TITLE = 'The Crossroads Inn';
const OPENING_NARRATION = 'Rain drums on the roof of the Crossroads Inn. A stranger by the fire looks up as you enter.';
const ARCHIVE_DIR = 'archive';
const NONE = 'none';
const LAUNCH_TEXT = 'Run rpg new <name> "<one sentence>" to start a campaign, or rpg resume <name> to continue one.';

const userDataDir = (): string => {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR);
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR);
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), APP_DIR);
};

export const dataDirFromEnv = (): string => process.env.RPG_DATA_DIR || userDataDir();

const databasePath = (dataDir: string, name: string) =>
  join(dataDir, `${encodeURIComponent(name)}${DATABASE_EXTENSION}`);

const archivePath = (dataDir: string, name: string) => databasePath(join(dataDir, ARCHIVE_DIR), name);

const missingCampaign = (dataDir: string, name: string) =>
  existsSync(archivePath(dataDir, name))
    ? new Error(`Campaign ${name} is archived.`)
    : new Error(`No campaign named ${name}. Run rpg new ${name} first.`);

type Session = { engine: Engine; store: ReturnType<typeof createCampaignStore>; campaignId: string };

const withSession = <T>(dataDir: string, name: string, run: (session: Session) => T): T => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw missingCampaign(dataDir, name);
  const connection = openDatabase(path);
  try {
    const store = createCampaignStore(connection.database);
    const row = connection.database.prepare(SELECT_CAMPAIGN_ID).get();
    if (row === undefined) throw new Error(`Campaign ${name} has no saved state.`);
    return run({ engine: createEngine(store), store, campaignId: String(row.id) });
  } finally {
    connection.close();
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

const createCampaign = (dataDir: string, name: string): string => {
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
      sceneTitle: OPENING_TITLE,
      narration: OPENING_NARRATION,
    });
    connection.close();
  } catch (error) {
    connection?.close();
    rmSync(path, { force: true });
    throw error;
  }
  return sceneText(OPENING_TITLE, OPENING_NARRATION);
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
  if (last === undefined || actor === undefined) return OPENING_NARRATION;
  return last.narration.trim() === '' ? narrate(actor.name, last) : last.narration;
};

const savedCampaigns = (dataDir: string) =>
  existsSync(dataDir)
    ? readdirSync(dataDir)
        .filter((file) => file.endsWith(DATABASE_EXTENSION))
        .map((file) => decodeURIComponent(file.slice(0, -DATABASE_EXTENSION.length)))
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

export const createEngineGateway = (dataDir: string): CampaignGateway => ({
  launch: () => launch(dataDir),
  list: () => list(dataDir),
  archive: (name) => archive(dataDir, name),
  remove: (name, lines) => remove(dataDir, name, lines),
  create: (name, intent) => {
    const settings = describeConfig(planCampaign(intent));
    return `${settings}\n${createCampaign(dataDir, name)}`;
  },
  importRules: (files, lines) => importRules(process.cwd(), files, lines),
  open: async function* (name, _mode, lines, onTurnError) {
    yield withSession(dataDir, name, ({ engine, campaignId }) => {
      const { currentScene, characters, turns } = engine.getState(campaignId);
      return sceneText(currentScene?.title ?? name, recap(characters, turns.at(-1)));
    });
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
