import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '../../../packages/mcp/src/server.ts';
import { openCampaignTools } from './host.ts';

const DATABASE_ENV = 'RPG_DATABASE_PATH';
const EXIT_MISSING_DATABASE = 1;

const path = process.env[DATABASE_ENV];
if (!path) {
  process.stderr.write(`${DATABASE_ENV} must point to the campaign SQLite file\n`);
  process.exit(EXIT_MISSING_DATABASE);
}

mkdirSync(dirname(path), { recursive: true });
const { engine, memory } = openCampaignTools(path);
await serve(engine, memory);
