import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CampaignNotFoundError, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { listScopedEvents } from '../../persistence/src/event-store.ts';
import { campaignLanguageOf, createEngine } from './engine.ts';

const IN_MEMORY = ':memory:';
const FIRST_NAME = 'Tiny Test';
const SECOND_NAME = 'Tiny Test Renamed';
const MISSING_ID = 'missing';
const PORTUGUESE = 'pt-BR';
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

test('rpg-42a.40 a campaign keeps the language chosen at creation and old campaigns record none', () => {
  const { connection, engine } = openEngine();
  const chosen = engine.createCampaign(FIRST_NAME, PORTUGUESE);
  const plain = engine.createCampaign(SECOND_NAME);
  const eventsOf = (campaignId: string) => listScopedEvents(connection.database, campaignId);
  assert.equal(campaignLanguageOf(eventsOf(chosen.id)), PORTUGUESE);
  assert.equal(campaignLanguageOf(eventsOf(plain.id)), undefined);
  assert.throws(() => engine.createCampaign('Bad', 'not a locale!'), RangeError);
  connection.close();
});

test('rpg-42a.67: CampaignLanguageChanged updates the language, the latest wins and an invalid locale is rejected', () => {
  const { connection, engine } = openEngine();
  const { id } = engine.createCampaign(FIRST_NAME, 'en');
  const eventsOf = () => listScopedEvents(connection.database, id);
  const save = (language: string, actionId: string) =>
    engine.setCampaignLanguage({ campaignId: id, actionId, expectedRevision: engine.getState(id).revision, language });
  assert.equal(save(PORTUGUESE, 'lang-1'), PORTUGUESE);
  assert.equal(campaignLanguageOf(eventsOf()), PORTUGUESE);
  save('es', 'lang-2');
  assert.equal(campaignLanguageOf(eventsOf()), 'es');
  assert.equal(campaignLanguageOf(engine.getState(id).changes), 'es');
  assert.throws(() => save('not a locale!', 'lang-3'), RangeError);
  assert.equal(campaignLanguageOf(eventsOf()), 'es');
  connection.close();
});
