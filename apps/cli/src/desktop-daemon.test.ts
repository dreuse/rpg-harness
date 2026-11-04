import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import {
  API_KEY_ENV,
  CONSUMER_CREDENTIAL_PREFIX,
  DAEMON_ENTRY,
  daemonEnv,
  ELECTRON_RUN_AS_NODE_ENV,
  EXIT_CONSUMER_CREDENTIALS,
  type Ready,
  startDaemon,
} from './desktop-daemon.ts';

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
  return env;
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
