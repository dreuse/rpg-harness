import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaleRevisionError } from '../../domain/src/campaign.ts';
import { createEngine, type Engine } from '../../engine/src/engine.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { CAMPAIGN_TOOLS, callTool, MAX_NAME_LENGTH, MAX_REQUEST_BYTES, type ToolResult } from './tools.ts';

const IN_MEMORY = ':memory:';
const FIRST_NAME = 'Tiny Test';
const SECOND_NAME = 'Tiny Test Renamed';
const MISSING_ID = 'missing';
const EXPECTED_REVISION = 0;

const ok = (result: ToolResult) => {
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent as Record<string, unknown>;
};

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return (result.structuredContent as { code: string }).code;
};

const openEngine = () => {
  const connection = openDatabase(IN_MEMORY);
  return { connection, database: connection.database, engine: createEngine(createCampaignStore(connection.database)) };
};

const countRows = (database: ReturnType<typeof openDatabase>['database'], table: string) =>
  database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total;

test('mcp tools can create, read and update a tiny test campaign with typed schemas', () => {
  const { connection, database, engine } = openEngine();

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
      ['get_scene', true],
    ],
  );

  const created = ok(callTool(engine, 'create_campaign', { name: FIRST_NAME }));
  assert.equal(created.name, FIRST_NAME);
  assert.equal(typeof created.id, 'string');

  assert.deepEqual(ok(callTool(engine, 'get_campaign', { id: created.id })), created);

  const renamed = ok(callTool(engine, 'rename_campaign', { id: created.id, name: SECOND_NAME }));
  assert.deepEqual(renamed, { id: created.id, name: SECOND_NAME });
  assert.deepEqual(ok(callTool(engine, 'get_campaign', { id: created.id })), renamed);

  const result = callTool(engine, 'get_campaign', { id: created.id });
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), renamed);

  const events = database
    .prepare('SELECT campaign_id, type, payload FROM event_log ORDER BY seq')
    .all()
    .map((row) => ({ campaignId: row.campaign_id, type: row.type, payload: JSON.parse(String(row.payload)) }));
  assert.deepEqual(events, [
    { campaignId: created.id, type: 'CampaignCreated', payload: { name: FIRST_NAME } },
    { campaignId: created.id, type: 'CampaignRenamed', payload: { name: SECOND_NAME } },
  ]);
  connection.close();
});

test('invalid or oversized tool requests are rejected cleanly', () => {
  const { connection, database, engine } = openEngine();
  const created = ok(callTool(engine, 'create_campaign', { name: FIRST_NAME }));
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
    assert.equal(errorCode(callTool(engine, name, args)), code, `${name} ${code}`);
  }
  assert.equal(countRows(database, 'campaign'), 1);
  assert.equal(countRows(database, 'event_log'), 1);
  assert.deepEqual(ok(callTool(engine, 'get_campaign', { id: created.id })), created);
  connection.close();
});

test('a stale revision from the engine maps to a StaleRevision tool error', () => {
  const rejectStale = () => {
    throw new StaleRevisionError(EXPECTED_REVISION, EXPECTED_REVISION + 1);
  };
  const stale: Engine = {
    createCampaign: rejectStale,
    getCampaign: rejectStale,
    getState: rejectStale,
    renameCampaign: rejectStale,
  };
  assert.equal(errorCode(callTool(stale, 'rename_campaign', { id: MISSING_ID, name: SECOND_NAME })), 'StaleRevision');
});

test('get_scene reads the current scene and characters without changing state', () => {
  const { connection, database, engine } = openEngine();
  const created = ok(callTool(engine, 'create_campaign', { name: FIRST_NAME }));
  const campaignId = String(created.id);
  assert.equal(errorCode(callTool(engine, 'get_scene', { campaignId })), 'SceneNotFound');
  assert.equal(errorCode(callTool(engine, 'get_scene', { campaignId: MISSING_ID })), 'CampaignNotFound');

  const scene = { id: 'scene-1', campaignId, title: 'A quiet harbour' };
  const character = { id: 'character-1', campaignId, name: 'Ash' };
  createCampaignStore(database).commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'turn-1',
      campaignId,
      sceneId: scene.id,
      actionId: 'action-1',
      actorId: character.id,
      input: 'look around',
      narration: 'Gulls circle.',
    },
    characters: [character],
    scenes: [scene],
    events: [],
  });
  const eventsBefore = countRows(database, 'event_log');

  assert.deepEqual(ok(callTool(engine, 'get_scene', { campaignId })), {
    campaignId,
    revision: 1,
    scene: { id: scene.id, title: scene.title },
    characters: [{ id: character.id, name: character.name }],
  });
  assert.equal(countRows(database, 'event_log'), eventsBefore);
  assert.equal(countRows(database, 'turn'), 1);
  connection.close();
});
