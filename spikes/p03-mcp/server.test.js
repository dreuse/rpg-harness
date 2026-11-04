import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = new URL('./server.js', import.meta.url).pathname;

async function connect() {
  const client = new Client({ name: 'p03-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH] }));
  return client;
}

test('exposes only the read tool', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['get_campaign_snapshot']);
  assert.equal(tools[0].annotations?.readOnlyHint, true);
  await client.close();
});

test('returns a typed player-visible snapshot', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'get_campaign_snapshot', arguments: { campaignId: 'demo' } });
  assert.equal(result.structuredContent.campaignId, 'demo');
  assert.equal(result.structuredContent.revision, 0);
  assert.equal(JSON.stringify(result).includes('gmSecret'), false);
  await client.close();
});

test('rejects an unknown campaign', async () => {
  const client = await connect();
  const result = await client.callTool({ name: 'get_campaign_snapshot', arguments: { campaignId: 'nope' } });
  assert.equal(result.isError, true);
  await client.close();
});
