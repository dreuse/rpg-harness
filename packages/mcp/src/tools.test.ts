import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../../persistence/src/database.ts';
import { CAMPAIGN_TOOLS, callTool, MAX_NAME_LENGTH, MAX_REQUEST_BYTES, type ToolResult } from './tools.ts';

const IN_MEMORY = ':memory:';
const FIRST_NAME = 'Tiny Test';
const SECOND_NAME = 'Tiny Test Renamed';
const MISSING_ID = 'missing';

const ok = (result: ToolResult) => {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
};

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return (result.structuredContent as { code: string }).code;
};

const countRows = (database: ReturnType<typeof openDatabase>['database'], table: string) =>
  database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total;

test('mcp tools can create, read and update a tiny test campaign with typed schemas', () => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;

  for (const tool of CAMPAIGN_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, 'object');
  }
  assert.deepEqual(
    CAMPAIGN_TOOLS.map((tool) => [tool.name, tool.annotations.readOnlyHint]),
    [
      ['create_campaign', false],
      ['get_campaign', true],
      ['rename_campaign', false],
    ],
  );

  const created = ok(callTool(database, 'create_campaign', { name: FIRST_NAME }));
  assert.equal(created.name, FIRST_NAME);
  assert.equal(typeof created.id, 'string');

  assert.deepEqual(ok(callTool(database, 'get_campaign', { id: created.id })), created);

  const renamed = ok(callTool(database, 'rename_campaign', { id: created.id, name: SECOND_NAME }));
  assert.deepEqual(renamed, { id: created.id, name: SECOND_NAME });
  assert.deepEqual(ok(callTool(database, 'get_campaign', { id: created.id })), renamed);

  const result = callTool(database, 'get_campaign', { id: created.id });
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), renamed);

  const events = database
    .prepare('SELECT campaign_id, payload FROM event_log ORDER BY seq')
    .all()
    .map((row) => ({ campaignId: row.campaign_id, payload: JSON.parse(String(row.payload)) }));
  assert.deepEqual(events, [
    { campaignId: created.id, payload: { type: 'CampaignCreated', name: FIRST_NAME } },
    { campaignId: created.id, payload: { type: 'CampaignRenamed', name: SECOND_NAME } },
  ]);
  connection.close();
});

test('invalid or oversized tool requests are rejected cleanly', () => {
  const connection = openDatabase(IN_MEMORY);
  const { database } = connection;
  const created = ok(callTool(database, 'create_campaign', { name: FIRST_NAME }));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const cases: [string, unknown, string][] = [
    ['delete_campaign', { id: created.id }, 'UnknownTool'],
    ['create_campaign', null, 'InvalidArguments'],
    ['create_campaign', [FIRST_NAME], 'InvalidArguments'],
    ['create_campaign', {}, 'InvalidArguments'],
    ['create_campaign', { name: 7 }, 'InvalidArguments'],
    ['create_campaign', { name: '' }, 'InvalidArguments'],
    ['create_campaign', { name: FIRST_NAME, dice: 'd20' }, 'InvalidArguments'],
    ['create_campaign', { name: 'x'.repeat(MAX_NAME_LENGTH + 1) }, 'InvalidArguments'],
    ['create_campaign', cyclic, 'InvalidArguments'],
    ['create_campaign', { name: 'x'.repeat(MAX_REQUEST_BYTES) }, 'RequestTooLarge'],
    [
      'rename_campaign',
      { id: created.id, name: FIRST_NAME, padding: 'x'.repeat(MAX_REQUEST_BYTES) },
      'RequestTooLarge',
    ],
    ['get_campaign', { id: MISSING_ID }, 'CampaignNotFound'],
    ['rename_campaign', { id: MISSING_ID, name: SECOND_NAME }, 'CampaignNotFound'],
  ];

  for (const [name, args, code] of cases) {
    assert.equal(errorCode(callTool(database, name, args)), code, `${name} ${code}`);
  }
  assert.equal(countRows(database, 'campaign'), 1);
  assert.equal(countRows(database, 'event_log'), 1);
  assert.deepEqual(ok(callTool(database, 'get_campaign', { id: created.id })), created);
  connection.close();
});
