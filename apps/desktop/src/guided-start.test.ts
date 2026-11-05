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
import { CHECK_RESOLVED } from '../../../packages/domain/src/campaign.ts';
import { campaignLanguageOf } from '../../../packages/engine/src/engine.ts';
import { gmSettingsOf } from '../../../packages/engine/src/gm-settings.ts';
import { voiceSettingsOf } from '../../../packages/engine/src/voice-settings.ts';
import { D20_SIDES } from '../../../packages/rules/src/d20-lite.ts';
import { CAMPAIGN_ENV, startDaemon } from '../../cli/src/desktop-daemon.ts';
import { readCampaignState } from '../../cli/src/engine-gateway.ts';
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
const PORTUGUESE = 'pt-BR';
const DESCRIBE: readonly StartAction[] = [
  { kind: 'path', path: 'describe' },
  { kind: 'enter', text: HORROR_INTENT },
  { kind: 'next' },
];
const GUIDE: readonly StartAction[] = [
  { kind: 'path', path: 'guide' },
  { kind: 'next' },
  { kind: 'choose', field: 'genre', value: 'fantasy' },
  { kind: 'choose', field: 'ruleset', value: { id: 'narrative', edition: 'original' } },
  { kind: 'skip' },
  { kind: 'next' },
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

const openDesktop = async (t: TestContext, env: NodeJS.ProcessEnv, startDraft?: StartDraft, locale?: string) => {
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
    ...(locale === undefined ? {} : { locale: () => locale }),
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
  assert.ok(summary?.text.includes('Rules: Story only: no dice, no sheet (chosen)'));
  assert.ok(summary?.text.includes('Character: none (default)'));
  assert.equal(await playOneTurn(t, dataDir, GUIDED_NAME), PLAYER_ACTION);
});

test('rpg-42a.14 desktop never substitutes an uninstalled edition and asks for an import', async (t) => {
  const dataDir = tempDataDir(t);
  const desktop = await openDesktop(t, envFor(dataDir));
  const summary = await desktop.act([
    { kind: 'path', path: 'describe' },
    { kind: 'enter', text: UNINSTALLED_INTENT },
    { kind: 'next' },
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

test('rpg-42a.39 desktop guided start follows the player language and names the adventure in it', async (t) => {
  const dataDir = tempDataDir(t);
  const desktop = await openDesktop(t, envFor(dataDir), undefined, PORTUGUESE);
  desktop.client.openStart();
  await desktop.settled();
  assert.equal(desktop.client.startScreen()?.title, 'Nova aventura');
  const summary = await desktop.act(DESCRIBE);
  assert.ok(summary?.text.includes('Gênero: horror (escolhido)'));
  await desktop.act([{ kind: 'start' }]);
  assert.ok(desktop.client.state().campaigns.some(({ name }) => name === 'Minha aventura'));
});

const D20_GUIDE: readonly StartAction[] = GUIDE.map((action) =>
  action.kind === 'choose' && action.field === 'ruleset'
    ? { ...action, value: { id: 'd20-lite', edition: 'original' } }
    : action,
);
const DEFAULT_GUIDE: readonly StartAction[] = [
  { kind: 'path', path: 'guide' },
  { kind: 'next' },
  { kind: 'next' },
  { kind: 'next' },
  { kind: 'skip' },
  { kind: 'next' },
  { kind: 'next' },
  { kind: 'enter', text: GUIDED_NAME },
];

const rolledSides = (dataDir: string) => {
  const [resolved] = readCampaignState(dataDir, GUIDED_NAME).events.filter(({ type }) => type === CHECK_RESOLVED);
  const resolution = resolved?.payload.resolution as { rolls: { pool: { dice: { sides: number }[] } }[] } | undefined;
  return resolution?.rolls[0]?.pool.dice[0]?.sides;
};

const attackThroughDesktop = async (t: TestContext, actions: readonly StartAction[], input: string) => {
  const { dataDir } = await createThrough(t, actions);
  const { client, settled } = await openDesktop(t, envFor(dataDir, GUIDED_NAME));
  const id = client.state().campaigns.find((item) => item.name === GUIDED_NAME)?.id;
  assert.ok(id);
  client.select(id);
  await settled();
  assert.equal(client.submit(input).ok, true);
  await settled();
  return { client, dataDir };
};

test('rpg-42a.77 guided start with the classic d20 and no sheet rolls a d20 for Attack', async (t) => {
  const { client, dataDir } = await attackThroughDesktop(t, D20_GUIDE, 'Attack');
  assert.equal(rolledSides(dataDir), D20_SIDES);
  assert.equal(client.state().snapshot?.noRoll, undefined);
});

test('rpg-42a.77 guided start without a ruleset shows the no-rulebook reason for Attack', async (t) => {
  const { client, dataDir } = await attackThroughDesktop(t, DEFAULT_GUIDE, 'Attack');
  assert.equal(rolledSides(dataDir), undefined);
  assert.equal(client.state().snapshot?.noRoll?.reason, 'no-rulebook');
});

test('rpg-42a.77 /roll in the desktop input rolls a plain d20 and is not sent to the GM as text', async (t) => {
  const { client, dataDir } = await attackThroughDesktop(t, D20_GUIDE, '/roll');
  assert.equal(rolledSides(dataDir), D20_SIDES);
  assert.notEqual(client.state().snapshot?.turns.at(-1)?.input, '/roll');
});

const BEGIN_GUIDE = GUIDE.slice(0, 5);

test('rpg-42a.88 desktop creates nothing until Begin, then saves the chosen language, voice and dice before the opening', async (t) => {
  const dataDir = tempDataDir(t);
  const desktop = await openDesktop(t, envFor(dataDir));
  desktop.client.openStart();
  await desktop.settled();
  const begin = await desktop.act([
    ...BEGIN_GUIDE,
    { kind: 'next' },
    { kind: 'set', field: 'language', value: 'pt-BR' },
    { kind: 'set', field: 'whoRolls', value: 'ask' },
    { kind: 'toggle', field: 'voiceOutput' },
  ]);
  assert.equal(begin.step, 'begin');
  assert.deepEqual(
    readdirSync(dataDir).filter((file) => file.endsWith('.sqlite')),
    [],
  );
  const summary = await desktop.act([{ kind: 'next' }]);
  assert.equal(summary.step, 'summary');
  assert.deepEqual(
    readdirSync(dataDir).filter((file) => file.endsWith('.sqlite')),
    [],
  );
  await desktop.act([{ kind: 'start' }]);
  const { changes } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.equal(campaignLanguageOf(changes), 'pt-BR');
  assert.equal(voiceSettingsOf(changes)?.spokenOutput, 'narrator');
  assert.equal(voiceSettingsOf(changes)?.locale, 'pt-BR');
  assert.equal(gmSettingsOf(changes).whoRolls, 'ask');
});

test('rpg-42a.88 desktop Skip on the begin step keeps the defaults', async (t) => {
  const dataDir = tempDataDir(t);
  const desktop = await openDesktop(t, envFor(dataDir));
  desktop.client.openStart();
  await desktop.settled();
  await desktop.act([
    ...BEGIN_GUIDE,
    { kind: 'next' },
    { kind: 'set', field: 'language', value: 'pt-BR' },
    { kind: 'skip' },
  ]);
  await desktop.act([{ kind: 'start' }]);
  const { changes } = readCampaignState(dataDir, DEFAULT_ADVENTURE_NAME);
  assert.equal(campaignLanguageOf(changes), 'en');
  assert.equal(voiceSettingsOf(changes), undefined);
  assert.deepEqual(gmSettingsOf(changes), {});
});
