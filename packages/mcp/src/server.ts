import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Engine } from '../../engine/src/engine.ts';
import { CAMPAIGN_TOOLS, callTool, type MemoryPort } from './tools.ts';

const SERVER_INFO = { name: 'rpg-harness', version: '0.0.0' };

const LOOPBACK = '127.0.0.1';
const EPHEMERAL_PORT = 0;
const TOKEN_BYTES = 32;
const BEARER = 'Bearer ';
const MCP_PATH = '/mcp';
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_UNAUTHORIZED = 401;
const HTTP_MISDIRECTED = 421;
const HTTP_SERVER_ERROR = 500;
const READ_ONLY_TOOLS = CAMPAIGN_TOOLS.filter(({ annotations }) => annotations.readOnlyHint);

const gameServerOf = (engine: Engine, memory?: MemoryPort, exposed: readonly { name: string }[] = CAMPAIGN_TOOLS) => {
  const names = new Set(exposed.map(({ name }) => name));
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: structuredClone(CAMPAIGN_TOOLS.filter(({ name }) => names.has(name))),
  }));
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    if (!names.has(params.name))
      return { isError: true, content: [{ type: 'text' as const, text: `UnknownTool: unknown tool ${params.name}` }] };
    const { isError, content, structuredContent } = callTool(engine, params.name, params.arguments ?? {}, memory);
    return structuredClone(isError ? { isError, content } : { isError, content, structuredContent });
  });
  return server;
};

export const serve = async (engine: Engine, memory?: MemoryPort) => {
  await gameServerOf(engine, memory).connect(new StdioServerTransport());
};

const sameToken = (given: string | undefined, token: string) => {
  const expected = Buffer.from(`${BEARER}${token}`);
  const actual = Buffer.from(given ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const serveHttp = async (engine: Engine, memory?: MemoryPort, requestedPort: number = EPHEMERAL_PORT) => {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  let host = '';
  const http = createServer(async (request, response) => {
    try {
      if (request.headers.host !== host) return void response.writeHead(HTTP_MISDIRECTED).end();
      if (!sameToken(request.headers.authorization, token)) return void response.writeHead(HTTP_UNAUTHORIZED).end();
      if (request.method !== 'POST') return void response.writeHead(HTTP_METHOD_NOT_ALLOWED).end();
      const server = gameServerOf(engine, memory, READ_ONLY_TOOLS);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      response.on('close', () => void server.close());
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(HTTP_SERVER_ERROR);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(requestedPort, LOOPBACK, resolve);
  });
  const { port } = http.address() as AddressInfo;
  host = `${LOOPBACK}:${port}`;
  return {
    url: `http://${host}${MCP_PATH}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
};
