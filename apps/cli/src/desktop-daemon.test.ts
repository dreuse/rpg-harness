import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  createCommand,
  INITIAL_DRAFT,
  nextDraft,
  planCommand,
  type StartAction,
} from '../../../packages/client-protocol/src/guided-start.ts';
import {
  type Accepted,
  type CampaignList,
  type CampaignPanels,
  type CampaignPlan,
  type CampaignSnapshot,
  type CampaignSummary,
  type ClientEvent,
  PROTOCOL_VERSION,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import { SHEET_VIEW } from '../../../packages/client-protocol/src/view-registry.ts';
import type { Ready, Reply } from '../../../packages/client-protocol/src/wire.ts';
import { createCharacterStore } from '../../../packages/persistence/src/character-store.ts';
import { MIGRATIONS, openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore } from '../../../packages/persistence/src/entity-store.ts';
import { startProviderServer, textReply } from '../../../packages/testkit/src/provider-server.ts';
import {
  API_KEY_ENV,
  CAMPAIGN_ENV,
  CONSUMER_CREDENTIAL_PREFIX,
  DAEMON_ENTRY,
  daemonEnv,
  ELECTRON_RUN_AS_NODE_ENV,
  EXIT_CONSUMER_CREDENTIALS,
  gmRouteOf,
  NO_CAMPAIGN,
  startDaemon,
} from './desktop-daemon.ts';
import { createEngineGateway, FAKE_GM_REPLY, NO_KEY_NOTICE, readCampaignState } from './engine-gateway.ts';
import { FAKE_ROUTE, GM_API_URL_ENV, GM_ROUTE_ENV } from './gm-api.ts';
import { hermeticGmEnv } from './gm-test-env.ts';
import { visualizationPreferenceOf } from './roll-visualization.ts';
import { DATA_DIR_ENV } from './setup-check.ts';

const SPIKE_DOC = new URL('../../../docs/product/ui07-desktop-packaging-spike.md', import.meta.url);
const TARGET_PLATFORMS = ['win32', 'darwin', 'linux'] as const;
const OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const FAKE_SECRET = 'fake-consumer-token';
const FAKE_API_KEY = 'fake-api-key';
const API_NARRATION = 'The innkeeper slides a mug across the bar.';
const DROP_FACTS = 'DROP TABLE fact';
const KILL = 'SIGKILL';
const STOP_TEST_TIMEOUT_MS = 5000;
const NO_RESTARTS = 0;
const ELECTRON_VERSIONS = { electron: '43.7.7' };
const ENABLED = '1';
const CAMPAIGN = 'Ember';
const SECOND_CAMPAIGN = 'Frost';
const UNKNOWN_CAMPAIGN = 'Nowhere';
const MISSING_DIR = 'missing';
const EMPTY_FILE = 'Stray';
const GARBAGE_FILE = 'Junk';
const GARBAGE = 'not a sqlite database';
const TEMP_PREFIX = 'rpg-daemon-';
const ACTION = 'I greet the stranger';
const SECOND_ACTION = 'I sit by the fire';
const THIRD_ACTION = 'I check the door';
const UNKNOWN_VIEW = 'atlas';
const NO_CHARACTER = async () => undefined;
const DATABASE_EXTENSION = '.sqlite';
const NEWER_FILE = 'Future';
const SERVED_ALIAS = 'Ember link';
const SERVED_OTHER_CASE = 'ember';
const OLDER_FILE = 'Ancient';
const ARCHIVE_DIR = 'archive';
const FANTASY_INTENT = 'a fantasy adventure';
const UNINSTALLED_INTENT = 'D&D 1.9';
const NARRATIVE_CHOICES = { ruleset: { id: 'narrative', edition: 'original' }, genre: 'fantasy' };
const GUIDED_CAMPAIGN = 'Ashfall';
const DESKTOP_CLIENT = 'desktop';
const DICE_ANIMATION_INTENT = 'A fantasy story using the d20-lite rules with dice animation';
const DESCRIBE_ACTIONS: readonly StartAction[] = [
  { kind: 'path', path: 'describe' },
  { kind: 'enter', text: FANTASY_INTENT },
];
const GUIDE_ACTIONS: readonly StartAction[] = [
  { kind: 'path', path: 'guide' },
  { kind: 'next' },
  { kind: 'choose', field: 'genre', value: 'horror' },
  { kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } },
  { kind: 'enter', text: 'Ash, a tired knight' },
  { kind: 'toggle', field: 'voiceOutput' },
  { kind: 'next' },
  { kind: 'enter', text: GUIDED_CAMPAIGN },
];
const GM_SECRET = 'SECRET';
const GM_VISIBILITY = 'gm';
const SECRET_RULEPACK = { id: 'any-pack', edition: '1', revision: 'r1' };
const INSERT_FACT = 'INSERT INTO fact (id, campaign_id, statement, layer, visibility) VALUES (?, ?, ?, ?, ?)';
const INSERT_EVENT =
  'INSERT INTO event_log (id, campaign_id, turn_id, type, payload, visibility, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
const MARK_NEWER_SCHEMA = 'INSERT INTO schema_migrations (version, status) VALUES (?, ?)';
const INSERT_OLD_CAMPAIGN = 'INSERT INTO campaign (id, name) VALUES (?, ?)';
const FINISHED = 'finished';
const KNOWN_SCHEMA_VERSION = Math.max(...MIGRATIONS.map(({ version }) => version));
const FIRST_MIGRATION = 1;
const SHOW_NEW_EVENTS_TO_PLAYER = `DROP TRIGGER event_log_no_update;
  CREATE TRIGGER show_to_player AFTER INSERT ON event_log
  BEGIN UPDATE event_log SET visibility = 'player' WHERE id = NEW.id; END;`;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const supervise = (t: TestContext, options: Parameters<typeof startDaemon>[0]) => {
  const daemon = startDaemon(options);
  t.after(() => daemon.stop());
  return daemon;
};

const baseEnv = (): NodeJS.ProcessEnv => {
  const env = hermeticGmEnv();
  delete env[CAMPAIGN_ENV];
  return env;
};

const fileStamp = (path: string) => {
  const { size, mtimeMs } = statSync(path);
  return { size, mtimeMs };
};

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const createCampaigns = async (dataDir: string, names: readonly string[]) => {
  for (const name of names) for await (const _ of createEngineGateway(dataDir).create(name, undefined, NO_CHARACTER));
};

const campaignNames = async (daemon: ReturnType<typeof startDaemon>) => {
  const { version, campaigns } = acceptedValue<CampaignList>(
    await daemon.command({ version: PROTOCOL_VERSION, type: 'ListCampaigns' }),
  );
  assert.equal(version, PROTOCOL_VERSION);
  return campaigns.map(({ name }) => name);
};

const lifecycle = (type: string, fields: object) => ({ version: PROTOCOL_VERSION, type, ...fields });

const summariesOf = async (daemon: ReturnType<typeof startDaemon>) =>
  acceptedValue<CampaignList>(await daemon.command({ version: PROTOCOL_VERSION, type: 'ListCampaigns' })).campaigns;

const healthOf = (summaries: readonly CampaignSummary[]) =>
  Object.fromEntries(summaries.map(({ name, health }) => [name, health]));

const campaignFile = (dataDir: string, name: string) => join(dataDir, `${name}${DATABASE_EXTENSION}`);

const seedGmSecrets = (dataDir: string) => {
  const state = readCampaignState(dataDir, CAMPAIGN);
  const [hero] = state.characters;
  const [opening] = state.turns;
  assert.ok(hero !== undefined && opening !== undefined);
  const connection = openDatabase(campaignFile(dataDir, CAMPAIGN));
  try {
    const { database } = connection;
    const campaignId = state.campaign.id;
    const profile = {
      identity: { name: hero.name },
      motivations: [],
      background: `${GM_SECRET}_BACKGROUND`,
      traits: [{ id: 'oath', value: `${GM_SECRET}_TRAIT` }],
      conditions: [],
      rulepack: SECRET_RULEPACK,
    };
    createCharacterStore(createEntityStore(database)).saveProfile(campaignId, hero.id, profile, GM_VISIBILITY);
    database.prepare(INSERT_FACT).run(randomUUID(), campaignId, `${GM_SECRET}_NOTE`, 'canon', GM_VISIBILITY);
    const note = JSON.stringify({ note: `${GM_SECRET}_EVENT` });
    database.prepare(INSERT_EVENT).run(randomUUID(), campaignId, opening.id, 'GmNote', note, GM_VISIBILITY, null);
  } finally {
    connection.close();
  }
};

const campaignEnv = async (t: TestContext) => {
  const dataDir = tempDataDir(t);
  await createCampaigns(dataDir, [CAMPAIGN]);
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;
  const database = new DatabaseSync(join(dataDir, `${CAMPAIGN}${DATABASE_EXTENSION}`));
  database.exec(SHOW_NEW_EVENTS_TO_PLAYER);
  database.close();
  return { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir, [CAMPAIGN_ENV]: CAMPAIGN }, campaignId };
};

const D20_INTENT = 'A fantasy adventure using the D20-Lite rules';
const D20_CHARACTER = 'A scout named Wren with might 6, agility 5, wits 7 and presence 4.';
const EDITED_MIGHT = 8;

const heroEnv = async (t: TestContext) => {
  const dataDir = tempDataDir(t);
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, D20_INTENT, async () => D20_CHARACTER));
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;
  return { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir, [CAMPAIGN_ENV]: CAMPAIGN }, campaignId };
};

const snapshotCommand = (campaignId: string) => ({
  version: PROTOCOL_VERSION,
  type: 'GetCampaignSnapshot',
  campaignId,
});

const subscribeCommand = (campaignId: string, fromRevision: number) => ({
  version: PROTOCOL_VERSION,
  type: 'SubscribeEvents',
  campaignId,
  fromRevision,
});

const actionCommand = (snapshot: CampaignSnapshot, input: string) => ({
  version: PROTOCOL_VERSION,
  type: 'SubmitPlayerAction',
  campaignId: snapshot.campaignId,
  actionId: input,
  expectedRevision: snapshot.revision,
  sceneId: snapshot.currentScene?.id,
  actorId: snapshot.characters[0]?.id,
  input,
});

const rejectionOf = (reply: Reply) => {
  assert.equal(reply.type, 'Result');
  assert.equal(reply.result?.ok, false);
  return reply.result.error.code;
};

const acceptedValue = <T>(reply: Reply) => {
  assert.equal(reply.type, 'Result');
  assert.ok(reply.result?.ok);
  return reply.result.value as T;
};

const snapshotOf = async (daemon: ReturnType<typeof startDaemon>, campaignId: string) => {
  const reply = await daemon.command(snapshotCommand(campaignId));
  assert.equal(reply.type, 'Result');
  assert.ok(reply.result?.ok);
  return reply.result.value as CampaignSnapshot;
};

describe('validate windows/macos/linux packaging, daemon lifecycle and node engine embedding', () => {
  it('checks that the spike doc platform matrix lists win32, darwin and linux', () => {
    const doc = readFileSync(SPIKE_DOC, 'utf8');
    for (const platform of TARGET_PLATFORMS) assert.match(doc, new RegExp(`^\\| \`${platform}\` \\|`, 'm'));
  });

  it('spawns the node engine, handshakes, answers ping and shuts down gracefully', async (t) => {
    const daemon = supervise(t, { env: baseEnv() });
    const ready = await daemon.ready();
    assert.equal(ready.type, 'Ready');
    assert.equal(ready.version, PROTOCOL_VERSION);
    assert.equal(ready.node, process.version);
    assert.equal(ready.sqlite, true);
    assert.equal(ready.gm, 'fake');
    const pong = await daemon.request('Ping');
    assert.equal(pong.type, 'Pong');
    assert.equal(await daemon.stop(), 0);
  });

  it('exits 0 on SIGTERM after the handshake', async () => {
    const child = spawn(process.execPath, [DAEMON_ENTRY], { env: daemonEnv(baseEnv()) });
    const ready = Promise.withResolvers<void>();
    child.stdout.once('data', () => ready.resolve());
    const exit = new Promise<[number | null, string | null]>((resolve) =>
      child.once('exit', (code, signal) => resolve([code, signal])),
    );
    await ready.promise;
    child.kill('SIGTERM');
    assert.deepEqual(await exit, [0, null]);
  });

  it('detects a crash and restarts the engine with a new handshake', async (t) => {
    const crashes: number[] = [];
    const restarted = Promise.withResolvers<Ready>();
    const daemon = supervise(t, {
      env: baseEnv(),
      onCrash: (pid) => {
        crashes.push(pid);
        daemon.ready().then(restarted.resolve, restarted.reject);
      },
    });
    const first = await daemon.ready();
    process.kill(first.pid, KILL);
    const second = await restarted.promise;
    assert.deepEqual(crashes, [first.pid]);
    assert.notEqual(second.pid, first.pid);
    assert.equal(daemon.restarts(), 1);
    assert.equal((await daemon.request('Ping')).type, 'Pong');
    assert.equal(await daemon.stop(), 0);
  });

  it('stops an engine that died from a signal after restarts ran out', { timeout: STOP_TEST_TIMEOUT_MS }, async (t) => {
    const daemon = supervise(t, { env: baseEnv(), maxRestarts: NO_RESTARTS });
    const { pid } = await daemon.ready();
    process.kill(pid, KILL);
    while (isAlive(pid)) await setImmediate();
    assert.equal(await daemon.stop(), null);
  });

  it('runs the engine in node mode when the supervisor runs inside electron', () => {
    assert.deepEqual(daemonEnv({}, ELECTRON_VERSIONS), { [ELECTRON_RUN_AS_NODE_ENV]: ENABLED });
    assert.deepEqual(daemonEnv({}, {}), {});
  });
});

describe('serve client-protocol commands over the desktop engine daemon', () => {
  it('serves a snapshot, accepts a player action and pushes the committed event to a subscriber', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const before = await snapshotOf(daemon, campaignId);
    const events: ClientEvent[] = [];
    const { reply } = await daemon.subscribe(subscribeCommand(campaignId, before.revision), (event) =>
      events.push(event),
    );
    assert.equal(reply.type, 'Result');
    const submitted = await daemon.command(actionCommand(before, ACTION));
    assert.ok(submitted.result?.ok);
    const { revision } = submitted.result.value as { revision: number };
    assert.ok(revision > before.revision);
    assert.equal((await snapshotOf(daemon, campaignId)).revision, revision);
    assert.ok(events.some((event) => event.type === 'EventCommitted' && event.revision === revision));
  });

  it('returns the stored turn when the same player action is submitted twice', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const before = await snapshotOf(daemon, campaignId);
    const first = acceptedValue<Accepted>(await daemon.command(actionCommand(before, ACTION)));
    const repeated = acceptedValue<Accepted>(await daemon.command(actionCommand(before, ACTION)));
    assert.deepEqual(repeated, first);
    const after = await snapshotOf(daemon, campaignId);
    assert.equal(after.revision, first.revision);
    assert.equal(after.turns.length, before.turns.length + 1);
  });

  it('forwards rejected results for a stale revision, capabilities, unknown views and sheet edits', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const before = await snapshotOf(daemon, campaignId);
    acceptedValue<Accepted>(await daemon.command(actionCommand(before, ACTION)));
    assert.equal(rejectionOf(await daemon.command(actionCommand(before, THIRD_ACTION))), 'StaleRevision');
    const scoped = snapshotCommand(campaignId);
    const capability = { ...scoped, type: 'SelectCapability', capabilityId: 'combat', enabled: true };
    assert.equal(rejectionOf(await daemon.command(capability)), 'Rejected');
    assert.equal(
      rejectionOf(await daemon.command({ ...scoped, type: 'RequestView', viewId: UNKNOWN_VIEW })),
      'Rejected',
    );
    const { revision } = await snapshotOf(daemon, campaignId);
    const edit = { ...scoped, type: 'EditSheetField', actionId: 'edit', expectedRevision: revision, actorId: 'h' };
    assert.equal(rejectionOf(await daemon.command({ ...edit, fieldId: 'stress', value: 1 })), 'Rejected');
  });

  it('rpg-42a.21: pushes EventCommitted for a sheet edit so the open sheet view refreshes', async (t) => {
    const { env, campaignId } = await heroEnv(t);
    const daemon = supervise(t, { env });
    const before = await snapshotOf(daemon, campaignId);
    const events: ClientEvent[] = [];
    await daemon.subscribe(subscribeCommand(campaignId, before.revision), (event) => events.push(event));
    const edit = {
      ...snapshotCommand(campaignId),
      type: 'EditSheetField',
      actionId: 'edit-might',
      expectedRevision: before.revision,
      actorId: before.characters[0]?.id,
      fieldId: 'might',
      value: EDITED_MIGHT,
    };
    const { revision } = acceptedValue<Accepted>(await daemon.command(edit));
    await daemon.request('Ping');
    assert.ok(events.some((event) => event.type === 'EventCommitted' && event.revision === revision));
    const view = { ...snapshotCommand(campaignId), type: 'RequestView', viewId: SHEET_VIEW };
    const sheet = acceptedValue<ViewDescriptor>(await daemon.command(view));
    const might = sheet.components.find(({ id }) => id === 'might');
    assert.deepEqual(might, {
      kind: 'field',
      id: 'might',
      label: 'Might',
      value: EDITED_MIGHT,
      group: 'core',
      editable: true,
    });
  });

  it('A21: saves voice settings through the engine so a restarted daemon serves them', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const { revision } = await snapshotOf(daemon, campaignId);
    const settings = { microphone: 'off', spokenOutput: 'full', locale: 'en-US', speed: 1.5 };
    const save = { ...snapshotCommand(campaignId), type: 'SaveVoiceSettings', actionId: 'voice', ...settings };
    acceptedValue<Accepted>(await daemon.command({ ...save, expectedRevision: revision }));
    await daemon.stop();
    assert.deepEqual((await snapshotOf(supervise(t, { env }), campaignId)).voice, settings);
  });

  it('rpg-42a.37: saves the campaign GM model and shows it in the next snapshot', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const { revision } = await snapshotOf(daemon, campaignId);
    const save = { ...snapshotCommand(campaignId), type: 'SaveGmSettings', actionId: 'gm', model: 'opus' };
    acceptedValue<Accepted>(await daemon.command({ ...save, expectedRevision: revision }));
    assert.deepEqual((await snapshotOf(daemon, campaignId)).gm?.settings, { model: 'opus' });
  });

  it('rpg-42a.67: changes the campaign language and shows it in the next snapshot', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const { revision } = await snapshotOf(daemon, campaignId);
    const set = { ...snapshotCommand(campaignId), type: 'SetCampaignLanguage', actionId: 'lang', language: 'pt-BR' };
    acceptedValue<Accepted>(await daemon.command({ ...set, expectedRevision: revision }));
    assert.equal((await snapshotOf(daemon, campaignId)).language, 'pt-BR');
  });

  it('rpg-42a.37: saves the app-default GM model without touching the campaign', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const { revision } = await snapshotOf(daemon, campaignId);
    const save = { ...snapshotCommand(campaignId), type: 'SaveGmDefaults', actionId: 'gm-defaults' };
    acceptedValue(await daemon.command({ ...save, model: 'sonnet', sessionBudgetTokens: 900 }));
    const { gm, revision: after } = await snapshotOf(daemon, campaignId);
    assert.equal(after, revision);
    assert.deepEqual(gm?.defaults, { model: 'sonnet', sessionBudgetTokens: 900 });
    assert.deepEqual(gm?.campaignSettings, {});
    assert.deepEqual(gm?.settings, { model: 'sonnet', sessionBudgetTokens: 900 });
    const bad = await daemon.command({ ...save, model: '--dangerously-skip-permissions' });
    assert.equal(bad.result?.ok, false);
  });

  it('serves campaign panels and the sheet view', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const { revision } = await snapshotOf(daemon, campaignId);
    const panels = acceptedValue<CampaignPanels>(
      await daemon.command({ ...snapshotCommand(campaignId), type: 'GetCampaignPanels' }),
    );
    assert.equal(panels.campaignId, campaignId);
    assert.equal(panels.revision, revision);
    const view = { ...snapshotCommand(campaignId), type: 'RequestView', viewId: SHEET_VIEW };
    const sheet = acceptedValue<ViewDescriptor>(await daemon.command(view));
    assert.equal(sheet.viewId, SHEET_VIEW);
    assert.equal(sheet.campaignId, campaignId);
  });

  it('rejects invalid commands with an error and keeps serving', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    assert.equal((await daemon.command({ version: PROTOCOL_VERSION, type: 'Nope', campaignId })).type, 'Error');
    assert.equal((await daemon.command({ ...snapshotCommand(campaignId), extra: true })).type, 'Error');
    assert.equal((await daemon.command('not an object')).type, 'Error');
    assert.equal((await daemon.command(snapshotCommand('other-campaign'))).type, 'Error');
    assert.equal((await daemon.request('Ping')).type, 'Pong');
  });

  it('stops pushing events after unsubscribe and refuses requests after shutdown', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const before = await snapshotOf(daemon, campaignId);
    const events: ClientEvent[] = [];
    const { unsubscribe } = await daemon.subscribe(subscribeCommand(campaignId, before.revision), (event) =>
      events.push(event),
    );
    assert.equal((await unsubscribe()).type, 'Unsubscribed');
    const submitted = await daemon.command(actionCommand(before, SECOND_ACTION));
    assert.ok(submitted.result?.ok);
    assert.equal((await daemon.request('Ping')).type, 'Pong');
    assert.deepEqual(events, []);
    assert.equal(await daemon.stop(), 0);
    await assert.rejects(daemon.command(snapshotCommand(campaignId)));
  });

  it('lists every campaign in the data dir when no campaign is served (rpg-7x3.1)', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN, SECOND_CAMPAIGN]);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    assert.deepEqual(await campaignNames(daemon), [CAMPAIGN, SECOND_CAMPAIGN]);
  });

  it('lists the served campaign and the other campaigns in the data dir (rpg-7x3.1)', async (t) => {
    const { env } = await campaignEnv(t);
    await createCampaigns(String(env[DATA_DIR_ENV]), [SECOND_CAMPAIGN]);
    const daemon = supervise(t, { env });
    assert.deepEqual(await campaignNames(daemon), [CAMPAIGN, SECOND_CAMPAIGN]);
  });

  it('skips files that are not campaigns and leaves every file unchanged (rpg-7x3.1)', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN]);
    writeFileSync(join(dataDir, `${EMPTY_FILE}${DATABASE_EXTENSION}`), '');
    writeFileSync(join(dataDir, `${GARBAGE_FILE}${DATABASE_EXTENSION}`), GARBAGE);
    const files = [CAMPAIGN, EMPTY_FILE, GARBAGE_FILE].map((name) => join(dataDir, `${name}${DATABASE_EXTENSION}`));
    const before = files.map(fileStamp);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    assert.deepEqual(healthOf(await summariesOf(daemon)), {
      [CAMPAIGN]: 'ok',
      [EMPTY_FILE]: 'unreadable',
      [GARBAGE_FILE]: 'unreadable',
    });
    assert.deepEqual(files.map(fileStamp), before);
  });

  it('rpg-42a.12: lists corrupted, older and newer schema campaigns with their health', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN, NEWER_FILE]);
    writeFileSync(campaignFile(dataDir, GARBAGE_FILE), GARBAGE);
    const newer = new DatabaseSync(campaignFile(dataDir, NEWER_FILE));
    newer.prepare(MARK_NEWER_SCHEMA).run(KNOWN_SCHEMA_VERSION + 1, FINISHED);
    newer.close();
    const older = openDatabase(campaignFile(dataDir, OLDER_FILE), {
      migrations: MIGRATIONS.filter(({ version }) => version === FIRST_MIGRATION),
    });
    older.database.prepare(INSERT_OLD_CAMPAIGN).run(randomUUID(), OLDER_FILE);
    older.close();
    const files = [CAMPAIGN, NEWER_FILE, OLDER_FILE, GARBAGE_FILE].map((name) => campaignFile(dataDir, name));
    const before = files.map(fileStamp);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const summaries = await summariesOf(daemon);
    assert.deepEqual(healthOf(summaries), {
      [OLDER_FILE]: 'needs-migration',
      [CAMPAIGN]: 'ok',
      [NEWER_FILE]: 'unreadable',
      [GARBAGE_FILE]: 'unreadable',
    });
    const broken = summaries.find(({ name }) => name === GARBAGE_FILE);
    assert.deepEqual(
      { ...broken, lastPlayedAt: null },
      {
        id: null,
        name: GARBAGE_FILE,
        health: 'unreadable',
        lastPlayedAt: null,
        sceneTitle: null,
        characters: [],
        ruleset: null,
        genre: null,
        lastNarration: null,
        turnCount: 0,
      },
    );
    assert.deepEqual(files.map(fileStamp), before);
  });

  it('rpg-42a.12: summarizes a campaign for resume without GM-only traits, notes or events', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN]);
    seedGmSecrets(dataDir);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const [summary] = await summariesOf(daemon);
    assert.ok(summary !== undefined);
    const state = readCampaignState(dataDir, CAMPAIGN);
    assert.equal(summary.id, state.campaign.id);
    assert.equal(summary.health, 'ok');
    assert.equal(summary.sceneTitle, state.currentScene?.title);
    assert.deepEqual(
      summary.characters,
      state.characters.map(({ id, name }) => ({ id, name })),
    );
    assert.equal(summary.turnCount, state.turns.length);
    assert.ok(summary.lastNarration);
    assert.equal(summary.ruleset, null);
    assert.equal(summary.genre, null);
    assert.ok(!Number.isNaN(Date.parse(String(summary.lastPlayedAt))));
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(GM_SECRET));
  });

  it('rpg-42a.12: creates, archives and deletes campaigns over json lines and lists each step', async (t) => {
    const dataDir = tempDataDir(t);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const created = acceptedValue<CampaignSummary>(
      await daemon.command(lifecycle('CreateCampaign', { name: CAMPAIGN, intent: FANTASY_INTENT })),
    );
    assert.equal(created.name, CAMPAIGN);
    assert.equal(created.health, 'ok');
    assert.equal(created.genre?.id, 'fantasy');
    assert.equal(created.genre?.provenance, 'derived');
    const chosen = acceptedValue<CampaignSummary>(
      await daemon.command(lifecycle('CreateCampaign', { name: SECOND_CAMPAIGN, choices: NARRATIVE_CHOICES })),
    );
    assert.deepEqual(
      [chosen.ruleset?.id, chosen.ruleset?.edition, chosen.ruleset?.provenance],
      ['narrative', 'original', 'explicit'],
    );
    assert.equal(chosen.genre?.provenance, 'explicit');
    assert.equal(rejectionOf(await daemon.command(lifecycle('CreateCampaign', { name: CAMPAIGN }))), 'Rejected');
    assert.deepEqual(
      (await summariesOf(daemon)).map(({ name }) => name),
      [CAMPAIGN, SECOND_CAMPAIGN],
    );

    acceptedValue(await daemon.command(lifecycle('ArchiveCampaign', { name: CAMPAIGN })));
    assert.ok(existsSync(campaignFile(join(dataDir, ARCHIVE_DIR), CAMPAIGN)));
    assert.deepEqual(
      (await summariesOf(daemon)).map(({ name }) => name),
      [SECOND_CAMPAIGN],
    );
    assert.equal(rejectionOf(await daemon.command(lifecycle('ArchiveCampaign', { name: CAMPAIGN }))), 'Rejected');

    assert.equal(
      rejectionOf(
        await daemon.command(lifecycle('DeleteCampaign', { name: SECOND_CAMPAIGN, confirm: SECOND_CAMPAIGN })),
      ),
      'Rejected',
    );
    acceptedValue(await daemon.command(lifecycle('DeleteCampaign', { name: CAMPAIGN, confirm: CAMPAIGN })));
    assert.deepEqual(
      (await summariesOf(daemon)).map(({ name }) => name),
      [SECOND_CAMPAIGN],
    );
    assert.ok(!existsSync(campaignFile(join(dataDir, ARCHIVE_DIR), CAMPAIGN)));
  });

  it('rpg-42a.12: refuses to delete without the confirm token or to substitute an uninstalled ruleset', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN]);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    assert.equal((await daemon.command(lifecycle('DeleteCampaign', { name: CAMPAIGN }))).type, 'Error');
    const wrong = await daemon.command(lifecycle('DeleteCampaign', { name: CAMPAIGN, confirm: SECOND_CAMPAIGN }));
    assert.equal(rejectionOf(wrong), 'Rejected');
    assert.ok(existsSync(campaignFile(dataDir, CAMPAIGN)));
    const uninstalled = await daemon.command(
      lifecycle('CreateCampaign', { name: SECOND_CAMPAIGN, intent: UNINSTALLED_INTENT }),
    );
    assert.equal(rejectionOf(uninstalled), 'UnknownEdition');
    assert.match(String(uninstalled.result?.ok === false && uninstalled.result.error.message), /not installed/);
    const unknownChoice = await daemon.command(
      lifecycle('CreateCampaign', { name: SECOND_CAMPAIGN, choices: { ruleset: { id: 'dnd', edition: '1.9' } } }),
    );
    assert.equal(rejectionOf(unknownChoice), 'UnknownEdition');
    assert.ok(!existsSync(campaignFile(dataDir, SECOND_CAMPAIGN)));
  });

  it('rpg-42a.14: plans and creates a playable campaign through each guided start path', async (t) => {
    const dataDir = tempDataDir(t);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const described = DESCRIBE_ACTIONS.reduce(nextDraft, { ...INITIAL_DRAFT, name: CAMPAIGN });
    const guided = GUIDE_ACTIONS.reduce(nextDraft, INITIAL_DRAFT);
    const plan = acceptedValue<CampaignPlan>(await daemon.command(planCommand(described)));
    assert.deepEqual(plan.entries[1], { field: 'genre', value: 'fantasy', provenance: 'derived' });
    assert.ok(plan.options.rulesets.some(({ recommended }) => recommended));
    const guidedPlan = acceptedValue<CampaignPlan>(await daemon.command(planCommand(guided, DESKTOP_CLIENT)));
    assert.deepEqual(
      guidedPlan.entries.filter(({ provenance }) => provenance === 'explicit').map(({ field }) => field),
      ['ruleset', 'genre', 'character', 'voiceOutput'],
    );
    acceptedValue(await daemon.command(createCommand(described)));
    acceptedValue(await daemon.command(createCommand(guided, DESKTOP_CLIENT)));
    assert.equal(readCampaignState(dataDir, GUIDED_CAMPAIGN).characters[0]?.name, 'Ash');
    for (const name of [CAMPAIGN, GUIDED_CAMPAIGN]) {
      const campaignId = readCampaignState(dataDir, name).campaign.id;
      const served = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir, [CAMPAIGN_ENV]: name } });
      const before = await snapshotOf(served, campaignId);
      acceptedValue<Accepted>(await served.command(actionCommand(before, ACTION)));
    }
  });

  it('rpg-42a.8: the describe path turns dice animation on from free text', async (t) => {
    const dataDir = tempDataDir(t);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const actions: readonly StartAction[] = [
      { kind: 'path', path: 'describe' },
      { kind: 'enter', text: DICE_ANIMATION_INTENT },
    ];
    const described = actions.reduce(nextDraft, { ...INITIAL_DRAFT, name: CAMPAIGN });
    const plan = acceptedValue<CampaignPlan>(await daemon.command(planCommand(described, DESKTOP_CLIENT)));
    assert.ok(plan.entries.some(({ field, value }) => field === 'diceVisualization' && value === 'on'));
    acceptedValue(await daemon.command(createCommand(described, DESKTOP_CLIENT)));
    assert.deepEqual(visualizationPreferenceOf(readCampaignState(dataDir, CAMPAIGN).events), { enabled: true });
  });

  it('rpg-42a.14: plans an uninstalled edition as unknown and never substitutes another', async (t) => {
    const dataDir = tempDataDir(t);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const unknown = await daemon.command(lifecycle('PlanCampaign', { intent: UNINSTALLED_INTENT }));
    assert.equal(rejectionOf(unknown), 'UnknownEdition');
    assert.match(String(unknown.result?.ok === false && unknown.result.error.message), /D&D 1\.9 is not installed/);
    const chosen = lifecycle('PlanCampaign', { choices: { ruleset: { id: 'd20-lite', edition: '5e' } } });
    assert.equal(rejectionOf(await daemon.command(chosen)), 'UnknownEdition');
    assert.deepEqual(await campaignNames(daemon), []);
  });

  it('rpg-42a.20: serves the campaign it just created and refuses to archive or delete it', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const dataDir = String(env[DATA_DIR_ENV]);
    const daemon = supervise(t, { env });
    const created = acceptedValue<CampaignSummary>(
      await daemon.command(lifecycle('CreateCampaign', { name: SECOND_CAMPAIGN, intent: FANTASY_INTENT })),
    );
    assert.ok(created.id !== null);
    const before = await snapshotOf(daemon, created.id);
    acceptedValue<Accepted>(await daemon.command(actionCommand(before, ACTION)));
    assert.equal((await daemon.command(snapshotCommand(campaignId))).type, 'Error');
    assert.equal(
      rejectionOf(await daemon.command(lifecycle('ArchiveCampaign', { name: SECOND_CAMPAIGN }))),
      'Rejected',
    );
    const remove = lifecycle('DeleteCampaign', { name: SECOND_CAMPAIGN, confirm: SECOND_CAMPAIGN });
    assert.equal(rejectionOf(await daemon.command(remove)), 'Rejected');
    assert.ok(existsSync(campaignFile(dataDir, SECOND_CAMPAIGN)));
    acceptedValue(await daemon.command(lifecycle('ArchiveCampaign', { name: CAMPAIGN })));
  });

  it('rpg-42a.64: rejects story memory commands until the daemon serves them', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    const get = lifecycle('GetStoryMemory', { campaignId });
    const correct = lifecycle('CorrectStoryFact', {
      campaignId,
      actionId: 'fix-1',
      expectedRevision: 0,
      actorId: 'any',
      entityId: 'bob',
      kind: 'name',
      value: 'Bob',
    });
    assert.equal(rejectionOf(await daemon.command(get)), 'Rejected');
    assert.equal(rejectionOf(await daemon.command(correct)), 'Rejected');
  });

  it('rpg-42a.13: opens another campaign, drops old subscriptions and rejects an unknown name', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    await createCampaigns(String(env[DATA_DIR_ENV]), [SECOND_CAMPAIGN]);
    const daemon = supervise(t, { env });
    const events: ClientEvent[] = [];
    await daemon.subscribe(subscribeCommand(campaignId, (await snapshotOf(daemon, campaignId)).revision), (event) =>
      events.push(event),
    );
    const opened = acceptedValue<CampaignSummary>(
      await daemon.command(lifecycle('OpenCampaign', { name: SECOND_CAMPAIGN })),
    );
    assert.equal(opened.name, SECOND_CAMPAIGN);
    assert.ok(opened.id !== null);
    assert.equal((await daemon.command(snapshotCommand(campaignId))).type, 'Error');
    acceptedValue<Accepted>(await daemon.command(actionCommand(await snapshotOf(daemon, opened.id), ACTION)));
    acceptedValue(await daemon.command(lifecycle('OpenCampaign', { name: CAMPAIGN })));
    acceptedValue<Accepted>(await daemon.command(actionCommand(await snapshotOf(daemon, campaignId), ACTION)));
    assert.equal((await daemon.request('Ping')).type, 'Pong');
    assert.deepEqual(events, []);
    const unknown = await daemon.command(lifecycle('OpenCampaign', { name: UNKNOWN_CAMPAIGN }));
    assert.equal(rejectionOf(unknown), 'Rejected');
    assert.match(String(unknown.result?.ok === false && unknown.result.error.message), /No campaign named/);
    await snapshotOf(daemon, campaignId);
  });

  it('rpg-42a.13: lists archived campaigns and unarchives one to undo an archive', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN, SECOND_CAMPAIGN]);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    const list = async () =>
      acceptedValue<CampaignList>(await daemon.command({ version: PROTOCOL_VERSION, type: 'ListCampaigns' }));
    acceptedValue(await daemon.command(lifecycle('ArchiveCampaign', { name: CAMPAIGN })));
    const archived = await list();
    assert.deepEqual(
      [archived.campaigns.map(({ name }) => name), archived.archived?.map(({ name }) => name)],
      [[SECOND_CAMPAIGN], [CAMPAIGN]],
    );
    assert.equal(archived.archived?.[0]?.health, 'ok');
    const restored = acceptedValue(await daemon.command(lifecycle('UnarchiveCampaign', { name: CAMPAIGN })));
    assert.deepEqual(restored, { version: PROTOCOL_VERSION, name: CAMPAIGN });
    const listed = await list();
    assert.deepEqual([listed.campaigns.map(({ name }) => name), listed.archived], [[CAMPAIGN, SECOND_CAMPAIGN], []]);
    assert.equal(rejectionOf(await daemon.command(lifecycle('UnarchiveCampaign', { name: CAMPAIGN }))), 'Rejected');
  });

  it('rpg-42a.13: deleting an archived campaign keeps the active campaign with the same name', async (t) => {
    const dataDir = tempDataDir(t);
    await createCampaigns(dataDir, [CAMPAIGN]);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dataDir } });
    acceptedValue(await daemon.command(lifecycle('ArchiveCampaign', { name: CAMPAIGN })));
    await createCampaigns(dataDir, [CAMPAIGN]);
    const remove = lifecycle('DeleteCampaign', { name: CAMPAIGN, confirm: CAMPAIGN, archived: true });
    acceptedValue(await daemon.command(remove));
    const listed = acceptedValue<CampaignList>(
      await daemon.command({ version: PROTOCOL_VERSION, type: 'ListCampaigns' }),
    );
    assert.deepEqual([listed.campaigns.map(({ name }) => name), listed.archived], [[CAMPAIGN], []]);
    assert.ok(existsSync(campaignFile(dataDir, CAMPAIGN)));
  });

  it('rpg-42a.12: refuses to archive or delete the campaign the engine serves', async (t) => {
    const { env } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    assert.equal(rejectionOf(await daemon.command(lifecycle('ArchiveCampaign', { name: CAMPAIGN }))), 'Rejected');
    const remove = lifecycle('DeleteCampaign', { name: CAMPAIGN, confirm: CAMPAIGN });
    assert.equal(rejectionOf(await daemon.command(remove)), 'Rejected');
    assert.ok(existsSync(campaignFile(String(env[DATA_DIR_ENV]), CAMPAIGN)));
  });

  it('rpg-42a.12: refuses to archive or delete the served campaign through another name for its file', async (t) => {
    const { env } = await campaignEnv(t);
    const dataDir = String(env[DATA_DIR_ENV]);
    symlinkSync(campaignFile(dataDir, CAMPAIGN), campaignFile(dataDir, SERVED_ALIAS));
    const daemon = supervise(t, { env });
    for (const name of [SERVED_ALIAS, SERVED_OTHER_CASE]) {
      assert.equal(rejectionOf(await daemon.command(lifecycle('ArchiveCampaign', { name }))), 'Rejected');
      const remove = lifecycle('DeleteCampaign', { name, confirm: name });
      assert.equal(rejectionOf(await daemon.command(remove)), 'Rejected');
    }
    assert.ok(existsSync(campaignFile(dataDir, CAMPAIGN)));
    assert.ok(existsSync(campaignFile(dataDir, SERVED_ALIAS)));
    const missing = await daemon.command(lifecycle('ArchiveCampaign', { name: SECOND_CAMPAIGN }));
    assert.equal(rejectionOf(missing), 'Rejected');
    assert.match(String(missing.result?.ok === false && missing.result.error.message), /No campaign named/);
  });

  it('replies an error with the request id when the data dir is a file (rpg-7x3.1)', {
    timeout: STOP_TEST_TIMEOUT_MS,
  }, async (t) => {
    const dataDir = tempDataDir(t);
    const file = join(dataDir, GARBAGE_FILE);
    writeFileSync(file, GARBAGE);
    const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: file } });
    const reply = await daemon.command({ version: PROTOCOL_VERSION, type: 'ListCampaigns' });
    assert.equal(reply.type, 'Error');
    assert.ok(reply.message);
    assert.equal((await daemon.request('Ping')).type, 'Pong');
  });

  it('lists no campaigns for an empty or missing data dir (rpg-7x3.1)', async (t) => {
    const dataDir = tempDataDir(t);
    for (const dir of [dataDir, join(dataDir, MISSING_DIR)]) {
      const daemon = supervise(t, { env: { ...baseEnv(), [DATA_DIR_ENV]: dir } });
      assert.deepEqual(await campaignNames(daemon), []);
    }
  });

  it('replies no campaign when the engine runs without one', async (t) => {
    const daemon = supervise(t, { env: baseEnv() });
    const fake = 'campaign';
    for (const command of [snapshotCommand(fake), subscribeCommand(fake, 0)]) {
      const reply = await daemon.command(command);
      assert.equal(reply.type, 'Error');
      assert.equal(reply.message, NO_CAMPAIGN);
    }
    const action = { ...snapshotCommand(fake), type: 'SubmitPlayerAction', actionId: 'a', expectedRevision: 0 };
    const submitted = await daemon.command({ ...action, sceneId: 's', actorId: 'h', input: ACTION });
    assert.equal(submitted.message, NO_CAMPAIGN);
  });
});

describe('rpg-cm63.17 desktop playback controls', () => {
  it('acknowledges pause, resume, skip and stop and rejects anything else', async (t) => {
    const daemon = supervise(t, { env: baseEnv() });
    await daemon.ready();
    for (const command of ['pause', 'resume', 'skip', 'stop'])
      assert.equal((await daemon.playback(command)).type, 'Played');
    assert.equal((await daemon.playback('format-disk')).type, 'Error');
    assert.equal((await daemon.playback(undefined)).type, 'Error');
  });

  it('answers a playback command while a narration is still streaming', async (t) => {
    const provider = await startProviderServer([{ hang: true }]);
    t.after(provider.close);
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env: { ...env, [API_KEY_ENV]: FAKE_API_KEY, [GM_API_URL_ENV]: provider.url } });
    await daemon.ready();
    const before = await snapshotOf(daemon, campaignId);
    const narrating = daemon.command(actionCommand(before, ACTION));
    narrating.catch(() => undefined);
    while (provider.received.length === 0) await setImmediate();
    assert.equal((await daemon.playback('pause')).type, 'Played');
  });
});

describe('rpg-cm63.22 desktop streamed narration and speech metrics', () => {
  it('keeps the tool call and commits proposals when a listener is attached and spoken output is off', async (t) => {
    const proposal = { kind: 'entity', id: 'brannoch', entityKind: 'npc', name: 'Brannoch', facts: ['Keeps the inn.'] };
    const toolReply = {
      body: JSON.stringify({
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'narrate',
            input: { segments: [{ text: API_NARRATION }], proposals: [proposal] },
          },
        ],
      }),
    };
    const provider = await startProviderServer([toolReply]);
    t.after(provider.close);
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env: { ...env, [API_KEY_ENV]: FAKE_API_KEY, [GM_API_URL_ENV]: provider.url } });
    await daemon.ready();
    const before = await snapshotOf(daemon, campaignId);
    const narrations: unknown[] = [];
    const submitted = await daemon.command(actionCommand(before, ACTION), (narration) => narrations.push(narration));
    assert.ok(submitted.result?.ok);
    assert.notEqual(provider.received[0]?.body.stream, true);
    assert.ok(provider.received[0]?.body.tools);
    assert.deepEqual(narrations, []);
    const connection = openDatabase(campaignFile(env[DATA_DIR_ENV] ?? '', CAMPAIGN), { readOnly: true });
    try {
      const names = createEntityStore(connection.database)
        .listEntities(campaignId)
        .map(({ name }) => name);
      assert.ok(names.includes('Brannoch'));
    } finally {
      connection.close();
    }
  });

  it('keeps the model call non-streaming when no listener is given', async (t) => {
    const provider = await startProviderServer([textReply(API_NARRATION)]);
    t.after(provider.close);
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env: { ...env, [API_KEY_ENV]: FAKE_API_KEY, [GM_API_URL_ENV]: provider.url } });
    await daemon.ready();
    const before = await snapshotOf(daemon, campaignId);
    assert.ok((await daemon.command(actionCommand(before, ACTION))).result?.ok);
    assert.notEqual(provider.received[0]?.body.stream, true);
  });

  it('answers a diagnostics request with no summary before any spoken turn', async (t) => {
    const daemon = supervise(t, { env: baseEnv() });
    await daemon.ready();
    const reply = await daemon.diagnostics();
    assert.equal(reply.type, 'Diagnosed');
    assert.equal(reply.summary, undefined);
  });
});

describe('desktop does not require unsupported reuse of consumer claude subscription credentials', () => {
  it('scrubs consumer claude variables from the engine environment', () => {
    const env = daemonEnv({ [OAUTH_ENV]: FAKE_SECRET, [CONFIG_DIR_ENV]: FAKE_SECRET, [API_KEY_ENV]: FAKE_API_KEY });
    assert.deepEqual(Object.keys(env), [API_KEY_ENV]);
  });

  it('scrubs claude login variables in any letter case and the auth token variables', () => {
    const env = daemonEnv({
      [OAUTH_ENV.toLowerCase()]: FAKE_SECRET,
      ANTHROPIC_AUTH_TOKEN: FAKE_SECRET,
      CLAUDECODE: ENABLED,
      ENABLE_CLAUDEAI_MCP_SERVERS: ENABLED,
      [API_KEY_ENV]: FAKE_API_KEY,
    });
    assert.deepEqual(Object.keys(env), [API_KEY_ENV]);
  });

  it('starts the engine with a fake gm and no consumer variables when only a claude login exists', async (t) => {
    const daemon = supervise(t, { env: { ...baseEnv(), [OAUTH_ENV]: FAKE_SECRET, [CONFIG_DIR_ENV]: FAKE_SECRET } });
    const ready = await daemon.ready();
    assert.equal(ready.gm, 'fake');
    assert.equal(await daemon.stop(), 0);
  });

  it('selects the api gm route when a provider api key is configured', async (t) => {
    const daemon = supervise(t, { env: { ...baseEnv(), [API_KEY_ENV]: FAKE_API_KEY } });
    assert.equal((await daemon.ready()).gm, 'api');
    assert.equal(await daemon.stop(), 0);
  });

  it('rpg-42a.28 reports the api route for an environment or stored key', () => {
    assert.equal(gmRouteOf({}), 'fake');
    assert.equal(gmRouteOf({}, FAKE_API_KEY), 'api');
    assert.equal(gmRouteOf({ [API_KEY_ENV]: FAKE_API_KEY }), 'api');
    assert.equal(gmRouteOf({ [API_KEY_ENV]: FAKE_API_KEY, [GM_ROUTE_ENV]: FAKE_ROUTE }), 'fake');
  });

  it('rpg-42a.28 narrates a submitted action through the provider before the next reply', async (t) => {
    const provider = await startProviderServer([textReply(API_NARRATION)]);
    t.after(provider.close);
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env: { ...env, [API_KEY_ENV]: FAKE_API_KEY, [GM_API_URL_ENV]: provider.url } });
    assert.equal((await daemon.ready()).gm, 'api');
    const before = await snapshotOf(daemon, campaignId);
    assert.ok((await daemon.command(actionCommand(before, ACTION))).result?.ok);
    assert.equal((await snapshotOf(daemon, campaignId)).turns.at(-1)?.narration, API_NARRATION);
    assert.equal(provider.received.length, 1);
    assert.equal(provider.received[0]?.headers['x-api-key'], FAKE_API_KEY);
  });

  it('rpg-42a.28 tells the desktop player once that no provider key is set', async (t) => {
    const { env, campaignId } = await campaignEnv(t);
    const daemon = supervise(t, { env });
    assert.equal((await daemon.ready()).gm, 'fake');
    const first = await snapshotOf(daemon, campaignId);
    assert.ok((await daemon.command(actionCommand(first, ACTION))).result?.ok);
    const second = await snapshotOf(daemon, campaignId);
    assert.ok(second.turns.at(-1)?.narration.startsWith(NO_KEY_NOTICE));
    assert.ok((await daemon.command(actionCommand(second, SECOND_ACTION))).result?.ok);
    assert.equal((await snapshotOf(daemon, campaignId)).turns.at(-1)?.narration, FAKE_GM_REPLY);
  });

  it('rpg-42a.28 keeps a committed action and keeps serving when narration fails', async (t) => {
    const provider = await startProviderServer([textReply(API_NARRATION)]);
    t.after(provider.close);
    const { env, campaignId } = await campaignEnv(t);
    const database = new DatabaseSync(campaignFile(env[DATA_DIR_ENV] ?? '', CAMPAIGN));
    database.exec(DROP_FACTS);
    database.close();
    const daemon = supervise(t, { env: { ...env, [API_KEY_ENV]: FAKE_API_KEY, [GM_API_URL_ENV]: provider.url } });
    const before = await snapshotOf(daemon, campaignId);
    const submitted = await daemon.command(actionCommand(before, ACTION));
    assert.equal(submitted.type, 'Result');
    assert.ok(submitted.result?.ok);
    const after = await snapshotOf(daemon, campaignId);
    assert.ok(after.revision > before.revision);
    assert.equal(after.turns.at(-1)?.input, ACTION);
  });

  it('refuses to start when launched directly with consumer claude variables', () => {
    const run = spawnSync(process.execPath, [DAEMON_ENTRY], { env: { ...baseEnv(), [OAUTH_ENV]: FAKE_SECRET } });
    assert.equal(run.status, EXIT_CONSUMER_CREDENTIALS);
    assert.match(String(run.stderr), new RegExp(CONSUMER_CREDENTIAL_PREFIX));
    assert.doesNotMatch(String(run.stderr), /does not use a Claude login/);
    assert.match(String(run.stderr), /Claude Code session variables/);
  });
});
