import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Engine } from '../../engine/src/engine.ts';
import { CAMPAIGN_TOOLS, callTool, type MemoryPort } from './tools.ts';

const SERVER_INFO = { name: 'rpg-harness', version: '0.0.0' };

export const serve = async (engine: Engine, memory?: MemoryPort) => {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(CAMPAIGN_TOOLS) }));
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const { isError, content, structuredContent } = callTool(engine, params.name, params.arguments ?? {}, memory);
    return structuredClone(isError ? { isError, content } : { isError, content, structuredContent });
  });
  await server.connect(new StdioServerTransport());
};
