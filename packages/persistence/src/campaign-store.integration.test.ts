import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { createSequentialIds } from '../../testkit/src/fixtures.ts';
import { createCampaignStore } from './campaign-store.ts';
import { openDatabase } from './database.ts';

const TEMP_PREFIX = 'rpg-integration-';
const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN_NAME = 'Harbor Lights';
const CREATED_EVENT = 'CampaignCreated';
const CREATED_REVISION = 0;

test('a campaign written to a SQLite file survives close and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(directory, DATABASE_FILE);
  const nextId = createSequentialIds('campaign');
  const campaign = { id: nextId(), name: CAMPAIGN_NAME };
  try {
    const writer = openDatabase(path);
    createCampaignStore(writer.database).createCampaign(campaign, {
      id: nextId(),
      campaignId: campaign.id,
      branchId: MAIN_BRANCH,
      actionId: nextId(),
      type: CREATED_EVENT,
      payload: { name: campaign.name },
    });
    writer.close();
    const reader = openDatabase(path);
    const state = createCampaignStore(reader.database).load(campaign.id);
    reader.close();
    assert.deepEqual(state?.campaign, campaign);
    assert.equal(state?.revision, CREATED_REVISION);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
