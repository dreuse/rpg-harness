import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CAMPAIGN_TOOLS } from './tools.ts';

const SERVER = join(import.meta.dirname, 'server.ts');
const DATABASE_ENV = 'RPG_DATABASE_PATH';
const CAMPAIGN_NAME = 'Wire Test';
const EXIT_OK = 0;

test('stdio server lists, creates and reads campaigns from a sqlite file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpg-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { [DATABASE_ENV]: join(directory, 'campaign.sqlite') },
  });
  const client = new Client({ name: 'server-test', version: '0.0.0' });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      CAMPAIGN_TOOLS.map((tool) => tool.name),
    );

    const created = await client.callTool({ name: 'create_campaign', arguments: { name: CAMPAIGN_NAME } });
    assert.equal(created.isError, false);
    const campaign = created.structuredContent as { id: string; name: string };
    assert.equal(campaign.name, CAMPAIGN_NAME);

    const read = await client.callTool({ name: 'get_campaign', arguments: { id: campaign.id } });
    assert.deepEqual(read.structuredContent, campaign);

    const invalid = await client.callTool({ name: 'get_campaign', arguments: { id: '' } });
    assert.equal(invalid.isError, true);
    assert.match((invalid.content as { text: string }[])[0]?.text ?? '', /^InvalidArguments: /);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stdio server exits non-zero without a database path', () => {
  const env = { ...process.env };
  delete env[DATABASE_ENV];
  const result = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8' });
  assert.notEqual(result.status, EXIT_OK);
  assert.match(result.stderr, new RegExp(DATABASE_ENV));
  assert.equal(result.stdout, '');
});
