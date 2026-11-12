#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serve } from '../../../packages/mcp/src/server.ts';
import { dataDirFromEnv } from '../../cli/src/setup-check.ts';
import { openCampaignTools } from './host.ts';

const DATABASE_ENV = 'RPG_DATABASE_PATH';
const CLAUDE_CODE_FOLDER = 'claude-code';
const CAMPAIGNS_FILE = 'campaigns.sqlite';

const path = process.env[DATABASE_ENV] || join(dataDirFromEnv(), CLAUDE_CODE_FOLDER, CAMPAIGNS_FILE);
mkdirSync(dirname(path), { recursive: true });
const { engine, memory } = openCampaignTools(path);
await serve(engine, memory);
