import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openDatabase } from '../../persistence/src/database.ts';
import { CAMPAIGN_TOOLS, callTool } from './tools.ts';

const DATABASE_ENV = 'RPG_DATABASE_PATH';
const EXIT_MISSING_DATABASE = 1;
const SERVER_INFO = { name: 'rpg-harness', version: '0.0.0' };

const path = process.env[DATABASE_ENV];
if (!path) {
  process.stderr.write(`${DATABASE_ENV} must point to the campaign SQLite file\n`);
  process.exit(EXIT_MISSING_DATABASE);
}

const { database } = openDatabase(path);
const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(CAMPAIGN_TOOLS) }));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  const { isError, content, structuredContent } = callTool(database, params.name, params.arguments ?? {});
  return structuredClone(isError ? { isError, content } : { isError, content, structuredContent });
});

await server.connect(new StdioServerTransport());
