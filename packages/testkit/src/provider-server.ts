import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MESSAGES_PATH = '/v1/messages';

const LOCALHOST = '127.0.0.1';
const ANY_PORT = 0;
const OK = 200;
const JSON_TYPE = { 'content-type': 'application/json' };
const TEXT_BLOCK = 'text';

export type ProviderReply = { readonly status?: number; readonly body?: string; readonly hang?: boolean };
export type ProviderRequest = { readonly headers: IncomingHttpHeaders; readonly body: Record<string, unknown> };

export const textReply = (text: string): ProviderReply => ({
  body: JSON.stringify({ content: [{ type: TEXT_BLOCK, text }] }),
});

export const startProviderServer = async (replies: readonly ProviderReply[]) => {
  const received: ProviderRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      const reply = replies[Math.min(received.length, replies.length) - 1] ?? {};
      if (reply.hang) return;
      response.writeHead(reply.status ?? OK, JSON_TYPE).end(reply.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(ANY_PORT, LOCALHOST, resolve));
  return {
    url: `http://${LOCALHOST}:${(server.address() as AddressInfo).port}${MESSAGES_PATH}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

export type ProviderServer = Awaited<ReturnType<typeof startProviderServer>>;
