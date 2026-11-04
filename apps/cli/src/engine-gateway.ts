import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CampaignState, Turn } from '../../../packages/domain/src/campaign.ts';
import { createEngine, type Engine } from '../../../packages/engine/src/engine.ts';
import { openScene, performAction } from '../../../packages/engine/src/turn.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import type { CampaignGateway } from './main.ts';

const APP_DIR = 'rpg';
const DATABASE_EXTENSION = '.sqlite';
const SELECT_CAMPAIGN_ID = 'SELECT id FROM campaign LIMIT 1';
const CREATE_EXCLUSIVE = 'wx';
const FILE_EXISTS = 'EEXIST';
const HERO_NAME = 'The Wanderer';
const OPENING_TITLE = 'The Crossroads Inn';
const OPENING_NARRATION = 'Rain drums on the roof of the Crossroads Inn. A stranger by the fire looks up as you enter.';
const LAUNCH_TEXT = 'Run rpg new <name> to start a campaign, or rpg resume <name> to continue one.';

const userDataDir = (): string => {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR);
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR);
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), APP_DIR);
};

export const dataDirFromEnv = (): string => process.env.RPG_DATA_DIR || userDataDir();

const databasePath = (dataDir: string, name: string) =>
  join(dataDir, `${encodeURIComponent(name)}${DATABASE_EXTENSION}`);

type Session = { engine: Engine; store: ReturnType<typeof createCampaignStore>; campaignId: string };

const withSession = <T>(dataDir: string, name: string, run: (session: Session) => T): T => {
  const path = databasePath(dataDir, name);
  if (!existsSync(path)) throw new Error(`No campaign named ${name}. Run rpg new ${name} first.`);
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

const claimFile = (path: string, name: string) => {
  try {
    closeSync(openSync(path, CREATE_EXCLUSIVE));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === FILE_EXISTS) {
      throw new Error(`A campaign named ${name} already exists.`);
    }
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

export const createEngineGateway = (dataDir: string): CampaignGateway => ({
  launch: () => LAUNCH_TEXT,
  create: (name) => createCampaign(dataDir, name),
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
