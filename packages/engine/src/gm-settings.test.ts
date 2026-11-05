import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CampaignStore, MAIN_BRANCH } from '../../domain/src/campaign.ts';
import { EMPTY_GM_USAGE_TOTALS } from '../../domain/src/gm.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEventStore } from '../../persistence/src/event-store.ts';
import { createEngine } from './engine.ts';
import { GM_USAGE_RECORDED, gmSettingsOf, gmUsageOf, recordGmUsage } from './gm-settings.ts';
import { InvalidActionError } from './turn.ts';

const TEMP_PREFIX = 'rpg-gm-settings-';
const DATABASE_FILE = 'campaign.sqlite';
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: MAIN_BRANCH,
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const SETTINGS = { model: 'haiku', summaryModel: 'haiku', sessionBudgetTokens: 20_000 };
const USAGE = {
  model: 'haiku',
  inputTokens: 1000,
  cacheReadTokens: 500,
  cacheWriteTokens: 200,
  outputTokens: 100,
  costUsd: 0.01,
};

const withStore = (run: (opened: ReturnType<typeof open>) => void) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(directory, DATABASE_FILE);
  try {
    const seeded = open(path);
    seeded.store.createCampaign(CAMPAIGN, CREATED_EVENT);
    seeded.close();
    const opened = open(path);
    try {
      run(opened);
    } finally {
      opened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const open = (path: string) => {
  const connection = openDatabase(path);
  const store = createCampaignStore(connection.database);
  const events = () => createEventStore(connection.database).list(CAMPAIGN.id, MAIN_BRANCH);
  return { store, events, engine: createEngine(store), close: () => connection.close() };
};

const saveFor = (store: CampaignStore, actionId: string, settings: unknown) => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision: store.load(CAMPAIGN.id)?.revision ?? 0,
  settings,
});

const usageFor = (sessionId: string, usage: unknown = USAGE) => ({
  campaignId: CAMPAIGN.id,
  turnId: 'turn-1',
  sessionId,
  usage,
});

test('rpg-42a.37: per-campaign GM settings are saved through the engine and the latest wins', () =>
  withStore(({ store, events, engine }) => {
    assert.deepEqual(gmSettingsOf(events()), {});
    engine.saveGmSettings(saveFor(store, 'first', { model: 'opus' }));
    engine.saveGmSettings(saveFor(store, 'second', { ...SETTINGS, apiKey: 'sk-live' }));
    assert.deepEqual(gmSettingsOf(events()), SETTINGS);
    assert.equal(JSON.stringify(events()).includes('sk-live'), false);
    assert.throws(
      () => engine.saveGmSettings(saveFor(store, 'bad', { model: '--permission-mode=bypassPermissions' })),
      InvalidActionError,
    );
  }));

test('rpg-42a.37: GM usage is campaign data that never moves the revision', () =>
  withStore(({ store, events }) => {
    const before = store.load(CAMPAIGN.id)?.revision;
    recordGmUsage(store, usageFor('session-1'));
    recordGmUsage(store, usageFor('session-1'));
    recordGmUsage(store, usageFor('session-2', { ...USAGE, costUsd: undefined }));
    assert.equal(store.load(CAMPAIGN.id)?.revision, before);
    assert.equal(events().filter(({ type }) => type === GM_USAGE_RECORDED).length, 3);
    assert.deepEqual(gmUsageOf(events(), 'session-1'), {
      turns: 2,
      inputTokens: 2000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 400,
      outputTokens: 200,
      costUsd: 0.02,
      pricedTurns: 2,
    });
    assert.equal(gmUsageOf(events()).turns, 3);
    assert.equal(gmUsageOf(events()).pricedTurns, 2);
    assert.deepEqual(gmUsageOf(events(), 'session-3'), EMPTY_GM_USAGE_TOTALS);
  }));

test('rpg-42a.37: malformed usage never throws, writes nothing, and an odd model id falls back to default', () =>
  withStore(({ store, events }) => {
    assert.equal(recordGmUsage(store, usageFor('session-1', { ...USAGE, inputTokens: -5 })), undefined);
    assert.equal(recordGmUsage(store, usageFor('session-1', 'not usage')), undefined);
    assert.equal(gmUsageOf(events()).turns, 0);
    assert.equal(recordGmUsage(store, usageFor('session-1', { ...USAGE, model: 'bad model!' }))?.model, 'default');
    assert.equal(gmUsageOf(events()).turns, 1);
  }));
