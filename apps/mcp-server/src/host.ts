import { createEngine } from '../../../packages/engine/src/engine.ts';
import { serveHttp } from '../../../packages/mcp/src/server.ts';
import { PLAYER_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createFactStore } from '../../../packages/persistence/src/entity-store.ts';
import { listScopedEvents } from '../../../packages/persistence/src/event-store.ts';
import { importCampaign } from './campaign-import.ts';

export const openCampaignTools = (path: string) => {
  const { database } = openDatabase(path);
  const facts = createFactStore(database);
  const store = createCampaignStore(database);
  const engine = createEngine(store);
  return {
    engine,
    memory: {
      viewer: PLAYER_VIEWER,
      events: (campaignId: string) => listScopedEvents(database, campaignId),
      facts: (campaignId: string) => facts.listFacts(campaignId),
      importCampaign: (folder: string) => importCampaign(engine, store, path, folder),
    },
    close: () => database.close(),
  };
};

export const hostGameServer = async (path: string, port?: number) => {
  const { engine, memory, close } = openCampaignTools(path);
  try {
    const host = await serveHttp(engine, memory, port);
    return {
      ...host,
      close: async () => {
        await host.close();
        close();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
};
