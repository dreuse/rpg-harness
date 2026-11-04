import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  type CampaignSnapshot,
  type ClientCommand,
  PROTOCOL_VERSION,
} from '../../../packages/client-protocol/src/protocol.ts';
import { API_KEY_ENV, CAMPAIGN_ENV, startDaemon } from '../../cli/src/desktop-daemon.ts';
import { createEngineGateway, openClientSession } from '../../cli/src/engine-gateway.ts';
import { DATA_DIR_ENV } from '../../cli/src/setup-check.ts';
import { PLAIN_TERMINAL, runTui } from '../../cli/src/tui.ts';
import { daemonTransport } from './main.ts';
import { createDesktopClient, type Transport } from './renderer.ts';

const CAMPAIGN = 'Ember';
const TEMP_PREFIX = 'rpg-cross-client-';
const NO_CHARACTER = async () => undefined;
const DESKTOP_ACTIONS = ['I greet the stranger', 'I sit by the fire'];
const TUI_ACTION = 'I ask about the road north';
const RECONNECT_ACTION = 'I check the door';
const RESTART_ACTION = 'I count my coins';
const LOG_PANE = '3';
const QUIT = 'q';
const LOST_REPLY = 'Connection lost before the reply.';
const ENGINE_CRASHED = 'Engine crashed.';
const KILL = 'SIGKILL';
const IGNORE = () => {};

type Daemon = ReturnType<typeof startDaemon>;
type Wire = Transport & {
  readonly settled: () => Promise<void>;
  readonly dropNextActionReply: () => void;
  readonly close: (error: string) => void;
};

const campaignDir = async (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const env: NodeJS.ProcessEnv = { ...process.env, [DATA_DIR_ENV]: dataDir, [CAMPAIGN_ENV]: CAMPAIGN };
  delete env[API_KEY_ENV];
  return { dataDir, env };
};

const daemonWire = (daemon: Daemon): Wire => {
  const inflight = new Set<Promise<unknown>>();
  let onClose = (_error: string) => {};
  let dropReply = false;
  const track = <T>(work: Promise<T>) => {
    const tracked = work.then(IGNORE, IGNORE).finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    return work;
  };
  const lossy = async (command: ClientCommand) => {
    const reply = await daemon.command(command);
    if (!dropReply || command.type !== 'SubmitPlayerAction') return reply;
    dropReply = false;
    throw new Error(LOST_REPLY);
  };
  const transport = daemonTransport({
    ready: () => track(daemon.ready()),
    command: (command) => track(lossy(command as ClientCommand)),
  });
  return {
    ...transport,
    onClose: (listener) => {
      onClose = listener;
      transport.onClose(listener);
    },
    settled: async () => {
      while (inflight.size > 0) await Promise.all(inflight);
    },
    dropNextActionReply: () => {
      dropReply = true;
    },
    close: (error) => onClose(error),
  };
};

const actionIds = () => {
  let next = 0;
  return () => `desktop-${next++}`;
};

const openDesktop = async (t: TestContext, env: NodeJS.ProcessEnv) => {
  const crashed = Promise.withResolvers<void>();
  const daemon = startDaemon({
    env,
    onCrash: () => {
      wire.close(ENGINE_CRASHED);
      crashed.resolve();
    },
  });
  t.after(() => daemon.stop());
  const wire = daemonWire(daemon);
  const client = createDesktopClient({ transport: wire, newActionId: actionIds() });
  await wire.settled();
  const [campaign] = client.state().campaigns;
  assert.ok(campaign);
  client.select(campaign.id);
  await wire.settled();
  const refresh = async () => {
    client.select(campaign.id);
    await wire.settled();
    const { snapshot } = client.state();
    assert.ok(snapshot);
    return snapshot;
  };
  const play = async (input: string) => {
    assert.equal(client.submit(input).ok, true);
    await wire.settled();
    return refresh();
  };
  return { daemon, wire, client, refresh, play, crashed: crashed.promise };
};

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const tuiSnapshot = (dataDir: string): CampaignSnapshot => {
  const { session, campaignId, close } = openClientSession(dataDir, CAMPAIGN);
  try {
    const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
    assert.ok(snapshot.ok);
    return viaJson(snapshot.value);
  } finally {
    close();
  }
};

const playTui = async (dataDir: string, lines: readonly string[]) => {
  const { session, campaignId, close } = openClientSession(dataDir, CAMPAIGN);
  const output: string[] = [];
  try {
    await runTui(session, campaignId, {
      capabilities: PLAIN_TERMINAL,
      lines: (async function* () {
        yield* lines;
      })(),
      write: (text) => output.push(text),
    });
  } finally {
    close();
  }
  return output.join('');
};

const inputs = ({ turns }: CampaignSnapshot) => turns.map(({ input }) => input).filter((input) => input !== '');

const assertNoDuplicateTurns = ({ turns }: CampaignSnapshot) => {
  const ids = turns.map(({ actionId }) => actionId);
  assert.equal(new Set(ids).size, ids.length);
};

describe('UI12: cross-client end-to-end gameplay', () => {
  it('play campaign in desktop, resume in tui and compare identical state', async (t) => {
    const { dataDir, env } = await campaignDir(t);
    const desktop = await openDesktop(t, env);
    for (const action of DESKTOP_ACTIONS) await desktop.play(action);
    const played = desktop.client.state().snapshot;
    assert.ok(played);
    assert.deepEqual(inputs(played).slice(-DESKTOP_ACTIONS.length), DESKTOP_ACTIONS);
    assert.equal(await desktop.daemon.stop(), 0);

    assert.deepEqual(tuiSnapshot(dataDir), viaJson(played));
    const screen = await playTui(dataDir, [LOG_PANE, TUI_ACTION, QUIT]);
    for (const action of DESKTOP_ACTIONS) assert.match(screen, new RegExp(action));
    assert.match(screen, new RegExp(TUI_ACTION));
    const resumed = tuiSnapshot(dataDir);
    assert.deepEqual(inputs(resumed).slice(-DESKTOP_ACTIONS.length - 1), [...DESKTOP_ACTIONS, TUI_ACTION]);
    assert.ok(resumed.revision > played.revision);

    const reopened = await openDesktop(t, env);
    assert.deepEqual(viaJson(await reopened.refresh()), resumed);
    assertNoDuplicateTurns(resumed);
  });

  it('no duplicate turns on reconnect, restart or renderer switch', async (t) => {
    const { dataDir, env } = await campaignDir(t);
    const desktop = await openDesktop(t, env);
    const start = await desktop.refresh();

    desktop.wire.dropNextActionReply();
    assert.equal(desktop.client.submit(RECONNECT_ACTION).ok, true);
    await desktop.wire.settled();
    assert.equal(desktop.client.state().connection.status, 'disconnected');
    assert.equal(desktop.client.state().outbox.length, 1);
    desktop.client.retry();
    await desktop.wire.settled();
    assert.equal(desktop.client.state().outbox.length, 0);
    assert.deepEqual(desktop.client.state().rejected, []);
    const reconnected = await desktop.refresh();
    assert.deepEqual(inputs(reconnected), [...inputs(start), RECONNECT_ACTION]);

    const { pid } = await desktop.daemon.ready();
    process.kill(pid, KILL);
    await desktop.crashed;
    await desktop.wire.settled();
    assert.equal(desktop.client.state().connection.status, 'disconnected');
    assert.equal(desktop.daemon.restarts(), 1);
    assert.equal(desktop.client.submit(RESTART_ACTION).ok, true);
    desktop.client.retry();
    await desktop.wire.settled();
    assert.equal(desktop.client.state().outbox.length, 0);
    const restarted = await desktop.refresh();
    assert.deepEqual(inputs(restarted), [...inputs(reconnected), RESTART_ACTION]);
    assert.equal(await desktop.daemon.stop(), 0);

    await playTui(dataDir, [LOG_PANE, QUIT]);
    assert.deepEqual(tuiSnapshot(dataDir), viaJson(restarted));
    const switched = await openDesktop(t, env);
    const back = viaJson(await switched.refresh());
    assert.deepEqual(back, viaJson(restarted));
    assertNoDuplicateTurns(back);
  });
});
