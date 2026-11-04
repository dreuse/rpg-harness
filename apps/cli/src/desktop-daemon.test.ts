import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  type Accepted,
  type CampaignPanels,
  type CampaignSnapshot,
  type ClientEvent,
  PROTOCOL_VERSION,
  type ViewDescriptor,
} from '../../../packages/client-protocol/src/protocol.ts';
import { SHEET_VIEW } from '../../../packages/client-protocol/src/view-registry.ts';
import type { Ready, Reply } from '../../../packages/client-protocol/src/wire.ts';
import {
  API_KEY_ENV,
  CAMPAIGN_ENV,
  CONSUMER_CREDENTIAL_PREFIX,
  DAEMON_ENTRY,
  daemonEnv,
  ELECTRON_RUN_AS_NODE_ENV,
  EXIT_CONSUMER_CREDENTIALS,
  NO_CAMPAIGN,
  startDaemon,
} from './desktop-daemon.ts';
import { createEngineGateway, readCampaignState } from './engine-gateway.ts';
import { DATA_DIR_ENV } from './setup-check.ts';

const SPIKE_DOC = new URL('../../../docs/product/ui07-desktop-packaging-spike.md', import.meta.url);
const TARGET_PLATFORMS = ['win32', 'darwin', 'linux'] as const;
const OAUTH_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const FAKE_SECRET = 'fake-consumer-token';
const FAKE_API_KEY = 'fake-api-key';
const KILL = 'SIGKILL';
const STOP_TEST_TIMEOUT_MS = 5000;
const NO_RESTARTS = 0;
const ELECTRON_VERSIONS = { electron: '43.7.7' };
const ENABLED = '1';
const CAMPAIGN = 'Ember';
const TEMP_PREFIX = 'rpg-daemon-';
const ACTION = 'I greet the stranger';
const SECOND_ACTION = 'I sit by the fire';
const THIRD_ACTION = 'I check the door';
const UNKNOWN_VIEW = 'atlas';
const NO_CHARACTER = async () => undefined;
const DATABASE_EXTENSION = '.sqlite';
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
  const env = { ...process.env };
  delete env[API_KEY_ENV];
  delete env[CAMPAIGN_ENV];
  return env;
};

const campaignEnv = async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;
  const database = new DatabaseSync(join(dataDir, `${CAMPAIGN}${DATABASE_EXTENSION}`));
  database.exec(SHOW_NEW_EVENTS_TO_PLAYER);
  database.close();
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

  it('refuses to start when launched directly with consumer claude variables', () => {
    const run = spawnSync(process.execPath, [DAEMON_ENTRY], { env: { ...baseEnv(), [OAUTH_ENV]: FAKE_SECRET } });
    assert.equal(run.status, EXIT_CONSUMER_CREDENTIALS);
    assert.match(String(run.stderr), new RegExp(CONSUMER_CREDENTIAL_PREFIX));
  });
});
