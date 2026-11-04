import { createEngine } from '../../../packages/engine/src/engine.ts';
import { serve } from '../../../packages/mcp/src/server.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';

const DATABASE_ENV = 'RPG_DATABASE_PATH';
const EXIT_MISSING_DATABASE = 1;

const path = process.env[DATABASE_ENV];
if (!path) {
  process.stderr.write(`${DATABASE_ENV} must point to the campaign SQLite file\n`);
  process.exit(EXIT_MISSING_DATABASE);
}

const { database } = openDatabase(path);
await serve(createEngine(createCampaignStore(database)));
