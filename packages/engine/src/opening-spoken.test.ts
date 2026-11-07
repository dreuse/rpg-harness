import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEventStore } from '../../persistence/src/event-store.ts';
import { createEngine } from './engine.ts';
import { OPENING_SPOKEN, openingSpokenOf } from './opening-spoken.ts';

const TEMP_PREFIX = 'rpg-opening-spoken-';
const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};

const open = (path: string) => {
  const connection = openDatabase(path);
  const store = createCampaignStore(connection.database);
  const events = () => createEventStore(connection.database).list(CAMPAIGN.id, MAIN_BRANCH);
  return { store, events, engine: createEngine(store), close: () => connection.close() };
};

test('rpg-cm63.72: the opening-spoken mark is written by the engine and survives a reopened store', () => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const path = join(directory, DATABASE_FILE);
    const writer = open(path);
    writer.store.createCampaign(CAMPAIGN, CREATED_EVENT);
    assert.equal(openingSpokenOf(writer.engine.getState(CAMPAIGN.id).changes), false);
    writer.engine.markOpeningSpoken({
      campaignId: CAMPAIGN.id,
      actionId: 'spoken',
      expectedRevision: writer.engine.getState(CAMPAIGN.id).revision,
    });
    writer.close();
    const reader = open(path);
    try {
      assert.equal(openingSpokenOf(reader.engine.getState(CAMPAIGN.id).changes), true);
      assert.equal(reader.events().filter(({ type }) => type === OPENING_SPOKEN).length, 1);
    } finally {
      reader.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
