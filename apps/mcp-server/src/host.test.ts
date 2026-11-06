import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CAMPAIGN_TOOLS } from '../../../packages/mcp/src/tools.ts';
import { hostGameServer } from './host.ts';

const CAMPAIGN_NAME = 'Hosted Test';
const LOOPBACK = '127.0.0.1';
const HTTP_OK = 200;
const HTTP_MISDIRECTED = 421;
const FOREIGN_HOST = 'evil.example';
const HTTP_UNAUTHORIZED = 401;
const WRONG_TOKEN = 'wrong';
const ACCEPT = 'application/json, text/event-stream';
const READ_ONLY_TOOLS = CAMPAIGN_TOOLS.filter(({ annotations }) => annotations.readOnlyHint);
const MISSING_CAMPAIGN = { id: 'missing' };

const sandbox = () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-mcp-host-'));
  return {
    path: join(directory, 'campaign.sqlite'),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
};

const rpc = (url: string, headers: Record<string, string>, method: string, params: object = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

test('hosts only the read-only game tools over loopback http behind a bearer token', async () => {
  const database = sandbox();
  const host = await hostGameServer(database.path);
  const headers = { authorization: `Bearer ${host.token}` };
  try {
    assert.equal(new URL(host.url).hostname, LOOPBACK);
    const listed = await rpc(host.url, headers, 'tools/list');
    assert.equal(listed.status, HTTP_OK);
    const { result } = (await listed.json()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(
      result.tools.map(({ name }) => name),
      READ_ONLY_TOOLS.map(({ name }) => name),
    );
    const read = await rpc(host.url, headers, 'tools/call', { name: 'get_campaign', arguments: MISSING_CAMPAIGN });
    const readBody = (await read.json()) as { result: { content: { text: string }[] } };
    assert.doesNotMatch(readBody.result.content[0]?.text ?? '', /^UnknownTool/);
    const created = await rpc(host.url, headers, 'tools/call', {
      name: 'create_campaign',
      arguments: { name: CAMPAIGN_NAME },
    });
    const body = (await created.json()) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0]?.text ?? '', /^UnknownTool/);
  } finally {
    await host.close();
    database.remove();
  }
});

test('rejects a request without the right token and stops listening on close', async () => {
  const database = sandbox();
  const host = await hostGameServer(database.path);
  try {
    for (const headers of [{}, { authorization: `Bearer ${WRONG_TOKEN}` }])
      assert.equal((await rpc(host.url, headers, 'tools/list')).status, HTTP_UNAUTHORIZED);
  } finally {
    await host.close();
    database.remove();
  }
  await assert.rejects(rpc(host.url, { authorization: `Bearer ${host.token}` }, 'tools/list'));
});

const statusWithHost = (url: string, host: string, token: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    const target = new URL(url);
    const call = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { host, authorization: `Bearer ${token}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    call.on('error', reject);
    call.end('{}');
  });

test('rejects a request whose Host header is not the loopback address', async () => {
  const database = sandbox();
  const host = await hostGameServer(database.path);
  try {
    assert.equal(
      await statusWithHost(host.url, `${FOREIGN_HOST}:${new URL(host.url).port}`, host.token),
      HTTP_MISDIRECTED,
    );
  } finally {
    await host.close();
    database.remove();
  }
});

test('fails fast instead of hanging when the port is taken', async () => {
  const database = sandbox();
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, LOOPBACK, resolve));
  try {
    const { port } = busy.address() as { port: number };
    await assert.rejects(hostGameServer(database.path, port), { code: 'EADDRINUSE' });
  } finally {
    busy.close();
    database.remove();
  }
});
