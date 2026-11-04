import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampaignNotFoundError, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEngine } from './engine.ts';

const IN_MEMORY = ':memory:';
const FIRST_NAME = 'Tiny Test';
const SECOND_NAME = 'Tiny Test Renamed';
const MISSING_ID = 'missing';
const INITIAL_REVISION = 0;
const SELECT_EVENTS = 'SELECT campaign_id, branch_id, revision, action_id, type, payload FROM event_log ORDER BY seq';

const openEngine = () => {
  const connection = openDatabase(IN_MEMORY);
  return { connection, engine: createEngine(createCampaignStore(connection.database)) };
};

test('engine creates, reads and renames a campaign through the store with one event per write', () => {
  const { connection, engine } = openEngine();
  const created = engine.createCampaign(FIRST_NAME);
  assert.equal(typeof created.id, 'string');
  assert.deepEqual(engine.getCampaign(created.id), { id: created.id, name: FIRST_NAME });

  const renamed = engine.renameCampaign(created.id, SECOND_NAME);
  assert.deepEqual(renamed, { id: created.id, name: SECOND_NAME });
  assert.deepEqual(engine.getCampaign(created.id), renamed);

  const events = connection.database.prepare(SELECT_EVENTS).all();
  const actionIds = new Set(events.map((row) => row.action_id));
  assert.equal(actionIds.size, events.length);
  for (const actionId of actionIds) assert.equal(typeof actionId, 'string');
  assert.deepEqual(
    events.map(({ action_id, payload, ...row }) => ({ ...row, payload: JSON.parse(String(payload)) })),
    [
      {
        campaign_id: created.id,
        branch_id: MAIN_BRANCH,
        revision: INITIAL_REVISION,
        type: 'CampaignCreated',
        payload: { name: FIRST_NAME },
      },
      {
        campaign_id: created.id,
        branch_id: MAIN_BRANCH,
        revision: INITIAL_REVISION + 1,
        type: 'CampaignRenamed',
        payload: { name: SECOND_NAME },
      },
    ],
  );
  connection.close();
});

test('engine rejects unknown campaigns without writing', () => {
  const { connection, engine } = openEngine();
  assert.throws(() => engine.getCampaign(MISSING_ID), CampaignNotFoundError);
  assert.throws(() => engine.renameCampaign(MISSING_ID, SECOND_NAME), CampaignNotFoundError);
  assert.equal(connection.database.prepare('SELECT COUNT(*) AS total FROM event_log').get()?.total, 0);
  connection.close();
});
