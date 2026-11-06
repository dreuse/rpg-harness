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
import {
  contextDroppedOften,
  contextRatioOf,
  GM_CONTEXT_RECORDED,
  GM_SETTINGS_SAVED,
  GM_USAGE_RECORDED,
  gmSettingsOf,
  gmUsageOf,
  NON_ENGLISH_RATIO,
  REQUEST_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS_BY_ROUTE,
  recordContextDiagnostics,
  recordGmUsage,
} from './gm-settings.ts';
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
const SETTINGS = {
  model: 'haiku',
  summaryModel: 'haiku',
  sessionBudgetTokens: 20_000,
};
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
  return {
    store,
    events,
    engine: createEngine(store),
    close: () => connection.close(),
  };
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
      () =>
        engine.saveGmSettings(
          saveFor(store, 'bad', {
            model: '--permission-mode=bypassPermissions',
          }),
        ),
      InvalidActionError,
    );
  }));

test('rpg-42a.58: rules strictness persists as a settings event and changes are new events', () =>
  withStore(({ store, events, engine }) => {
    engine.saveGmSettings(saveFor(store, 'strict', { rulesStrictness: 'relaxed' }));
    engine.saveGmSettings(saveFor(store, 'off', { rulesStrictness: 'off' }));
    assert.equal(gmSettingsOf(events()).rulesStrictness, 'off');
    assert.equal(events().filter(({ type }) => type === GM_SETTINGS_SAVED).length, 2);
    assert.throws(
      () => engine.saveGmSettings(saveFor(store, 'bad', { rulesStrictness: 'strict' })),
      InvalidActionError,
    );
    assert.equal(gmSettingsOf(events()).rulesStrictness, 'off');
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

const PACKET = {
  usedTokens: 1000,
  budget: 2000,
  truncated: 0,
  requiredExceedsBudget: false,
};
const diagnosticsFor = (events: ReturnType<typeof open>['events'], truncated = 0, reportedTokens = 0) => ({
  campaignId: CAMPAIGN.id,
  turnId: 'turn-1',
  events: events(),
  language: undefined,
  packet: { ...PACKET, truncated },
  reportedTokens,
});

test('rpg-42a.44: the token ratio comes from reported input tokens and defaults higher for non-English', () =>
  withStore(({ store, events }) => {
    assert.equal(contextRatioOf(events(), 'en'), 1);
    assert.equal(contextRatioOf(events(), undefined), 1);
    assert.equal(contextRatioOf(events(), 'pt-BR'), NON_ENGLISH_RATIO);
    recordContextDiagnostics(store, diagnosticsFor(events, 0, 1300 + REQUEST_OVERHEAD_TOKENS));
    assert.equal(contextRatioOf(events(), 'pt-BR'), 1.3);
    recordContextDiagnostics(store, diagnosticsFor(events, 0, 1500 + REQUEST_OVERHEAD_TOKENS));
    assert.equal(contextRatioOf(events(), 'pt-BR'), 1.4);
    recordContextDiagnostics(store, diagnosticsFor(events, 0, 100 + REQUEST_OVERHEAD_TOKENS));
    assert.equal(contextRatioOf(events(), 'en'), 1.2);
    recordContextDiagnostics(store, diagnosticsFor(events, 0, 900_000 + REQUEST_OVERHEAD_TOKENS));
    assert.ok(contextRatioOf(events(), 'en') <= 4);
  }));

const SMALL_PACKET = { ...PACKET, usedTokens: 2000 };

test('rpg-42a.44: fixed request overhead on a small packet never drives the ratio to the maximum', () =>
  withStore(({ store, events }) => {
    recordContextDiagnostics(store, {
      ...diagnosticsFor(events),
      packet: SMALL_PACKET,
      reportedTokens: 0,
    });
    assert.equal(contextRatioOf(events(), 'en'), 1);
    recordContextDiagnostics(store, {
      ...diagnosticsFor(events),
      packet: SMALL_PACKET,
      reportedTokens: SMALL_PACKET.usedTokens + REQUEST_OVERHEAD_TOKENS,
    });
    assert.equal(contextRatioOf(events(), 'en'), 1);
    recordContextDiagnostics(store, {
      ...diagnosticsFor(events),
      packet: SMALL_PACKET,
      reportedTokens: REQUEST_OVERHEAD_TOKENS - 1,
    });
    assert.equal(contextRatioOf(events(), 'en'), 1);
  }));

test('rpg-42a.147: each route subtracts its own request overhead', () =>
  withStore(({ store, events }) => {
    assert.equal(REQUEST_OVERHEAD_TOKENS_BY_ROUTE.api, REQUEST_OVERHEAD_TOKENS);
    const claudeOverhead = REQUEST_OVERHEAD_TOKENS_BY_ROUTE['claude-code'];
    assert.ok(claudeOverhead > REQUEST_OVERHEAD_TOKENS);
    recordContextDiagnostics(store, {
      ...diagnosticsFor(events, 0, 1300 + claudeOverhead),
      route: 'claude-code',
    });
    assert.equal(contextRatioOf(events(), 'en'), 1.3);
    recordContextDiagnostics(store, diagnosticsFor(events, 0, 1300 + claudeOverhead));
    assert.ok(contextRatioOf(events(), 'en') > 1.3);
  }));

test('rpg-42a.44: diagnostics hold counts only, never move the revision and flag frequent drops', () =>
  withStore(({ store, events }) => {
    const before = store.load(CAMPAIGN.id)?.revision;
    recordContextDiagnostics(store, diagnosticsFor(events, 2));
    recordContextDiagnostics(store, diagnosticsFor(events, 0));
    assert.equal(contextDroppedOften(events()), false);
    recordContextDiagnostics(store, diagnosticsFor(events, 5));
    recordContextDiagnostics(store, diagnosticsFor(events, 1));
    assert.equal(contextDroppedOften(events()), true);
    assert.equal(store.load(CAMPAIGN.id)?.revision, before);
    const last = events().findLast(({ type }) => type === GM_CONTEXT_RECORDED)?.payload;
    assert.deepEqual(Object.keys(last ?? {}).sort(), [
      'budget',
      'dropped',
      'ratio',
      'recent',
      'requiredExceedsBudget',
      'tokensUsed',
      'turnId',
    ]);
  }));
