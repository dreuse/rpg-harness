import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  DEFAULT_ADVENTURE_NAME,
  INITIAL_DRAFT,
  type StartAction,
  type StartDraft,
} from '../../../packages/client-protocol/src/guided-start.ts';
import type { ClientCommand } from '../../../packages/client-protocol/src/protocol.ts';
import { CAMPAIGN_ENV, startDaemon } from '../../cli/src/desktop-daemon.ts';
import { hermeticGmEnv } from '../../cli/src/gm-test-env.ts';
import { DATA_DIR_ENV } from '../../cli/src/setup-check.ts';
import { daemonTransport } from './main.ts';
import { createDesktopClient } from './renderer.ts';

const TEMP_PREFIX = 'rpg-desktop-start-';
const HORROR_INTENT = 'A horror story using the Narrative rules';
const UNINSTALLED_INTENT = 'Play D&D 1.9 in a noir mystery';
const GUIDED_NAME = 'Ashfall';
const PLAYER_ACTION = 'I look around';
const IGNORE = () => {};
const DESCRIBE: readonly StartAction[] = [
  { kind: 'path', path: 'describe' },
  { kind: 'enter', text: HORROR_INTENT },
];
const GUIDE: readonly StartAction[] = [
  { kind: 'path', path: 'guide' },
  { kind: 'next' },
  { kind: 'choose', field: 'genre', value: 'fantasy' },
  { kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } },
  { kind: 'skip' },
  { kind: 'next' },
  { kind: 'enter', text: GUIDED_NAME },
];

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const envFor = (dataDir: string, campaign?: string) => {
  const env: NodeJS.ProcessEnv = { ...hermeticGmEnv(), [DATA_DIR_ENV]: dataDir };
  delete env[CAMPAIGN_ENV];
  return campaign === undefined ? env : { ...env, [CAMPAIGN_ENV]: campaign };
};

const openDesktop = async (t: TestContext, env: NodeJS.ProcessEnv, startDraft?: StartDraft) => {
  const daemon = startDaemon({ env });
  t.after(() => daemon.stop());
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>) => {
    const tracked = work.then(IGNORE, IGNORE).finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    return work;
  };
  const transport = daemonTransport({
    ready: () => track(daemon.ready()),
    command: (command) => track(daemon.command(command as ClientCommand)),
    subscribe: (command, listener) => track(daemon.subscribe(command, listener)),
  });
  const saved: StartDraft[] = [];
  let next = 0;
  const client = createDesktopClient({
    transport,
    newActionId: () => `desktop-${next++}`,
    startDraft,
    saveStart: (draft) => saved.push(draft),
  });
  const settled = async () => {
    while (inflight.size > 0) await Promise.all(inflight);
  };
  await settled();
  const act = async (actions: readonly StartAction[]) => {
    for (const action of actions) {
      client.startAction(action);
      await settled();
    }
    return client.startScreen();
  };
  return { client, saved, settled, act };
};

const playOneTurn = async (t: TestContext, dataDir: string, name: string) => {
  const { client, settled } = await openDesktop(t, envFor(dataDir, name));
  const id = client.state().campaigns.find((item) => item.name === name)?.id;
  assert.ok(id);
  client.select(id);
  await settled();
  assert.equal(client.submit(PLAYER_ACTION).ok, true);
  await settled();
  client.select(id);
  await settled();
  return client.state().snapshot?.turns.at(-1)?.input;
};

const createThrough = async (t: TestContext, actions: readonly StartAction[]) => {
  const dataDir = tempDataDir(t);
  const desktop = await openDesktop(t, envFor(dataDir));
  assert.equal(desktop.client.state().start.options, undefined);
  desktop.client.openStart();
  await desktop.settled();
  assert.ok((desktop.client.state().start.options?.rulesets.length ?? 0) > 0);
  const summary = await desktop.act(actions);
  assert.equal(summary?.step, 'summary');
  assert.equal(summary?.canStart, true, summary?.error);
  await desktop.act([{ kind: 'start' }]);
  assert.deepEqual(desktop.saved.at(-1), INITIAL_DRAFT);
  assert.equal(desktop.client.state().start.open, false);
  return { dataDir, desktop, summary };
};

test('rpg-42a.14 desktop describe it path creates a playable campaign', async (t) => {
  const { dataDir, desktop, summary } = await createThrough(t, DESCRIBE);
  assert.ok(summary?.text.includes('Genre: horror (chosen)'));
  assert.ok(desktop.client.state().campaigns.some(({ name }) => name === DEFAULT_ADVENTURE_NAME));
  assert.equal(await playOneTurn(t, dataDir, DEFAULT_ADVENTURE_NAME), PLAYER_ACTION);
});

test('rpg-42a.14 desktop guide me path creates a playable campaign with chosen settings', async (t) => {
  const { dataDir, summary } = await createThrough(t, GUIDE);
  assert.ok(summary?.text.includes('Rules: narrative original (chosen)'));
  assert.ok(summary?.text.includes('Character: none (default)'));
  assert.equal(await playOneTurn(t, dataDir, GUIDED_NAME), PLAYER_ACTION);
});

test('rpg-42a.14 desktop never substitutes an uninstalled edition and asks for an import', async (t) => {
  const dataDir = tempDataDir(t);
  const desktop = await openDesktop(t, envFor(dataDir));
  const summary = await desktop.act([
    { kind: 'path', path: 'describe' },
    { kind: 'enter', text: UNINSTALLED_INTENT },
  ]);
  assert.equal(summary?.canStart, false);
  assert.match(summary?.error ?? '', /^Import your rulebook\. Ruleset D&D 1\.9 is not installed/);
  await desktop.act([{ kind: 'start' }]);
  assert.deepEqual(desktop.client.state().campaigns, []);
  assert.deepEqual(readdirSync(dataDir), []);
});

test('rpg-42a.14 desktop reopening restores the saved wizard step', async (t) => {
  const dataDir = tempDataDir(t);
  const first = await openDesktop(t, envFor(dataDir));
  await first.act(GUIDE.slice(0, 3));
  const saved = first.saved.at(-1);
  assert.ok(saved);
  const reopened = await openDesktop(t, envFor(dataDir), JSON.parse(JSON.stringify(saved)));
  assert.equal(reopened.client.state().start.open, true);
  assert.equal(reopened.client.startScreen()?.step, 'rules');
  assert.ok((reopened.client.startScreen()?.options.length ?? 0) > 0);
  assert.ok(!existsSync(join(dataDir, `${DEFAULT_ADVENTURE_NAME}.sqlite`)));
});
