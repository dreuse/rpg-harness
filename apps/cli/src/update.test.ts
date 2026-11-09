import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createSigningKeys,
  RELEASES_PATH,
  type ReleaseServer,
  startReleaseServer,
} from '../../../packages/testkit/src/release-server.ts';
import { BUNDLE_FORMAT, previousDir, stagedDir } from '../../../packages/updater/src/apply.ts';
import { readState, UPDATE_STATE_FILE, writeState } from '../../../packages/updater/src/schedule.ts';
import { campaignDatabases, createEngineGateway, readCampaignState } from './engine-gateway.ts';
import { errorText } from './messages.ts';
import {
  cliAssetName,
  holdSession,
  startupUpdate,
  type UpdateContext,
  type UpdateRequest,
  updateCommand,
} from './update.ts';

const CURRENT = '1.2.0';
const NEXT = '1.3.0';
const NOTES = 'Faster saves and a new map.';
const CAMPAIGN = 'Ember';
const BIN = join('apps', 'cli', 'src', 'bin.ts');
const OLD_BIN = 'old bin';
const NEW_BIN = 'new bin';
const NOW = Date.parse('2026-11-04T10:00:00Z');
const CLOSED_PORT_URL = 'http://127.0.0.1:9/releases';
const CHECK: UpdateRequest = { check: true };
const INSTALL: UpdateRequest = { check: false };
const BROKEN_DATABASE = 'not a database';
const MIGRATION_FAILED = 'migration 99 failed';
const BROKEN_CAMPAIGN_FILE = 'Broken.sqlite';
const CLOCK_FAILED = 'clock failed';
const NO_CHECK = { check: false };

const bundle = (version: string) =>
  JSON.stringify({
    format: BUNDLE_FORMAT,
    version,
    files: [{ path: BIN, data: Buffer.from(NEW_BIN).toString('base64') }],
  });

const collect = async (lines: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out.join('\n');
};

const createCampaign = async (dataDir: string) => {
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, async () => undefined));
};

const setup = async (t: { after: (fn: () => unknown) => void }) => {
  const keys = createSigningKeys();
  const server: ReleaseServer = await startReleaseServer(keys);
  const root = mkdtempSync(join(tmpdir(), 'rpg-cli-update-'));
  t.after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dataDir = join(root, 'data');
  const installDir = join(root, 'rpg');
  mkdirSync(join(installDir, 'apps', 'cli', 'src'), { recursive: true });
  writeFileSync(join(installDir, BIN), OLD_BIN);
  await createCampaign(dataDir);
  server.publish({ version: NEXT, notes: NOTES, files: { [cliAssetName(NEXT)]: bundle(NEXT) } });
  const context: UpdateContext = {
    dataDir,
    installDir,
    version: CURRENT,
    releasesUrl: server.releasesUrl,
    publicKey: keys.publicKey,
    fetch,
    now: () => NOW,
    campaigns: () => campaignDatabases(dataDir),
    migrate: () => undefined,
  };
  const stateFile = join(dataDir, UPDATE_STATE_FILE);
  const readBin = () => readFileSync(join(installDir, BIN), 'utf8');
  return { server, dataDir, installDir, context, stateFile, readBin };
};

test('update --check shows the new version and notes without downloading', async (t) => {
  const { server, context, stateFile, readBin } = await setup(t);
  const text = await collect(updateCommand(context, CHECK));
  assert.match(text, /Version 1\.3\.0 is available\. You have 1\.2\.0\./);
  assert.match(text, new RegExp(NOTES));
  assert.deepEqual(server.requests, [RELEASES_PATH]);
  assert.equal(readBin(), OLD_BIN);
  assert.equal(readState(stateFile).lastCheckAt, NOW);
});

test('update stages the verified build and installs it only on restart', async (t) => {
  const { context, installDir, stateFile, readBin, dataDir } = await setup(t);
  const text = await collect(updateCommand(context, INSTALL));
  assert.match(text, /Version 1\.3\.0 is ready\. It installs the next time you start rpg\./);
  assert.equal(readBin(), OLD_BIN);
  assert.deepEqual(readState(stateFile).staged, { version: NEXT, installDir });
  assert.deepEqual(readdirSync(join(dataDir, 'updates')), []);

  const restart = await startupUpdate(context, { check: true });
  assert.equal(restart.restart, true);
  assert.equal(readBin(), NEW_BIN);
  const { applied } = readState(stateFile);
  assert.equal(applied?.backups.length, 1);
  assert.ok(applied?.backups.every(({ archive }) => existsSync(archive)));

  const finished = await startupUpdate({ ...context, version: NEXT }, { check: true });
  assert.deepEqual(finished, { restart: false, messages: ['Updated to version 1.3.0.'] });
  assert.equal(existsSync(previousDir(installDir)), false);
  assert.equal(readState(stateFile).applied, undefined);
});

test('a failed migration rolls back the files and the campaign backup', async (t) => {
  const { context, dataDir, readBin } = await setup(t);
  const [campaign] = campaignDatabases(dataDir);
  assert.ok(campaign);
  const original = readCampaignState(dataDir, CAMPAIGN);
  await collect(updateCommand(context, INSTALL));
  await startupUpdate(context, { check: true });
  const failing: UpdateContext = {
    ...context,
    version: NEXT,
    migrate: (database) => {
      writeFileSync(database, BROKEN_DATABASE);
      throw new Error(MIGRATION_FAILED);
    },
  };
  const result = await startupUpdate(failing, { check: true });
  assert.equal(result.restart, true);
  assert.match(result.messages.join('\n'), new RegExp(`${MIGRATION_FAILED}.*version 1\\.2\\.0`));
  assert.equal(readBin(), OLD_BIN);
  assert.deepEqual(readCampaignState(dataDir, CAMPAIGN), original);
});

test('refuses to install a staged build that is not newer', async (t) => {
  const { context, installDir, stateFile, readBin } = await setup(t);
  await collect(updateCommand(context, INSTALL));
  const result = await startupUpdate({ ...context, version: NEXT }, { check: false });
  assert.deepEqual(result, { restart: false, messages: [] });
  assert.equal(readBin(), OLD_BIN);
  assert.equal(existsSync(stagedDir(installDir)), false);
  assert.equal(readState(stateFile).staged, undefined);
});

test('ignores the same or an older release', async (t) => {
  const { context, readBin } = await setup(t);
  for (const version of [NEXT, '2.0.0']) {
    const text = await collect(updateCommand({ ...context, version }, INSTALL));
    assert.equal(text, `rpg ${version} is up to date.`);
  }
  assert.equal(readBin(), OLD_BIN);
});

test('rejects a tampered build and deletes the download', async (t) => {
  const { server, context, dataDir, stateFile, installDir } = await setup(t);
  server.serve(server.assetPath(NEXT, cliAssetName(NEXT)), { body: bundle('9.9.9') });
  const text = await collect(updateCommand(context, INSTALL));
  assert.match(text, /Update rejected: checksum does not match\. The download was deleted\./);
  assert.deepEqual(readdirSync(join(dataDir, 'updates')), []);
  assert.equal(readState(stateFile).staged, undefined);
  assert.equal(existsSync(stagedDir(installDir)), false);
});

test('fails with the reason when offline or rate limited', async (t) => {
  const { server, context } = await setup(t);
  await assert.rejects(collect(updateCommand({ ...context, releasesUrl: CLOSED_PORT_URL }, CHECK)), /offline/);
  server.serve(RELEASES_PATH, { status: 403 });
  await assert.rejects(collect(updateCommand(context, CHECK)), /GitHub asked to wait/);
});

test('checks at startup once a day and tells the player', async (t) => {
  const { server, context } = await setup(t);
  const first = await startupUpdate(context, { check: true });
  assert.deepEqual(first.messages, ['Version 1.3.0 is available. Run rpg update --check to read the release notes.']);
  await startupUpdate(context, { check: true });
  assert.equal(server.requests.length, 1);
});

test('auto-check off makes no network call at startup', async (t) => {
  const { server, context, stateFile } = await setup(t);
  const text = await collect(updateCommand(context, { check: false, autoCheck: false }));
  assert.match(text, /Automatic update checks are off\./);
  assert.equal(readState(stateFile).autoCheck, false);
  assert.deepEqual(await startupUpdate(context, { check: true }), { restart: false, messages: [] });
  assert.deepEqual(server.requests, []);
});

test('the pre-release channel is opt-in', async (t) => {
  const { server, context, stateFile } = await setup(t);
  server.publish({ version: '1.4.0-beta.1', files: {} });
  assert.match(await collect(updateCommand(context, CHECK)), /Version 1\.3\.0 is available/);
  await collect(updateCommand(context, { check: false, preRelease: true }));
  assert.equal(readState(stateFile).channel, 'pre-release');
  assert.match(await collect(updateCommand(context, CHECK)), /Version 1\.4\.0-beta\.1 is available/);
});

test('a source checkout checks but never replaces files', async (t) => {
  const { server, context, installDir, readBin, stateFile } = await setup(t);
  mkdirSync(join(installDir, '.git'));
  const text = await collect(updateCommand(context, INSTALL));
  assert.match(text, /This copy runs from source\. Update it with git\./);
  assert.equal(readBin(), OLD_BIN);
  writeState(stateFile, { autoCheck: true, channel: 'stable' });
  const requests = server.requests.length;
  await startupUpdate(context, { check: true });
  assert.equal(server.requests.length, requests);
});

test('an unreadable campaign file keeps the old version and clears the update', async (t) => {
  const { context, dataDir, installDir, stateFile, readBin } = await setup(t);
  await collect(updateCommand(context, INSTALL));
  writeFileSync(join(dataDir, BROKEN_CAMPAIGN_FILE), BROKEN_DATABASE);
  const result = await startupUpdate(context, NO_CHECK);
  assert.equal(result.restart, false);
  assert.match(result.messages.join('\n'), /^Could not install version 1\.3\.0: .+ Keeping version 1\.2\.0\.$/);
  assert.equal(readBin(), OLD_BIN);
  assert.equal(readState(stateFile).staged, undefined);
  assert.equal(readState(stateFile).applied, undefined);
  assert.equal(existsSync(stagedDir(installDir)), false);
});

test('a failed rollback is reported and clears the update state', async (t) => {
  const { context, stateFile } = await setup(t);
  await collect(updateCommand(context, INSTALL));
  await startupUpdate(context, NO_CHECK);
  const backups = readState(stateFile).applied?.backups ?? [];
  for (const { archive } of backups) rmSync(archive);
  const failing: UpdateContext = {
    ...context,
    version: NEXT,
    migrate: () => {
      throw new Error(MIGRATION_FAILED);
    },
  };
  const result = await startupUpdate(failing, NO_CHECK);
  assert.equal(result.restart, false);
  assert.match(result.messages.join('\n'), /could not restore everything/);
  assert.ok(backups.every(({ archive }) => result.messages.join('\n').includes(archive)));
  assert.equal(readState(stateFile).applied, undefined);
});

test('an unexpected error during startup never blocks the command', async (t) => {
  const { context } = await setup(t);
  const failing: UpdateContext = {
    ...context,
    now: () => {
      throw new Error(CLOCK_FAILED);
    },
  };
  assert.deepEqual(await startupUpdate(failing, { check: true }), {
    restart: false,
    messages: [`Skipped the update step: ${CLOCK_FAILED}`],
  });
});

test('waits to install while another rpg session is running', async (t) => {
  const { context, dataDir, installDir, stateFile, readBin } = await setup(t);
  await collect(updateCommand(context, INSTALL));
  const release = holdSession(dataDir, process.ppid);
  assert.deepEqual(await startupUpdate(context, NO_CHECK), {
    restart: false,
    messages: ['Version 1.3.0 installs when no other rpg session is running.'],
  });
  assert.equal(readBin(), OLD_BIN);
  assert.deepEqual(readState(stateFile).staged, { version: NEXT, installDir });
  assert.ok(existsSync(stagedDir(installDir)));
  release();
  holdSession(dataDir);
  assert.equal((await startupUpdate(context, NO_CHECK)).restart, true);
  assert.equal(readBin(), NEW_BIN);
});

test('ignores a session left by a process that has exited', async (t) => {
  const { context, dataDir, readBin } = await setup(t);
  await collect(updateCommand(context, INSTALL));
  holdSession(dataDir, spawnSync(process.execPath, ['--version']).pid);
  assert.equal((await startupUpdate(context, NO_CHECK)).restart, true);
  assert.equal(readBin(), NEW_BIN);
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.startsWith('session-')),
    [],
  );
});

test('leaves an update that belongs to another install alone', async (t) => {
  const { context, installDir, stateFile } = await setup(t);
  await collect(updateCommand(context, INSTALL));
  const other: UpdateContext = { ...context, installDir: `${installDir}-other` };
  assert.deepEqual(await startupUpdate(other, NO_CHECK), { restart: false, messages: [] });
  assert.deepEqual(readState(stateFile).staged, { version: NEXT, installDir });
  assert.ok(existsSync(stagedDir(installDir)));
  assert.equal((await startupUpdate(context, NO_CHECK)).restart, true);
  assert.deepEqual(await startupUpdate({ ...other, version: NEXT }, NO_CHECK), { restart: false, messages: [] });
  assert.equal(readState(stateFile).applied?.installDir, installDir);
});

test('rpg-42a.53 update messages read in Brazilian Portuguese', async (t) => {
  const { server, context } = await setup(t);
  const pt: UpdateContext = { ...context, locale: 'pt-BR' };
  const check = await collect(updateCommand(pt, CHECK));
  assert.match(check, /A versão 1\.3\.0 está disponível\. Você tem a 1\.2\.0\./);
  assert.match(check, new RegExp(NOTES));
  const settings = await collect(updateCommand(pt, { check: false, autoCheck: false, preRelease: true }));
  assert.match(settings, /A verificação automática de atualizações está desligada\./);
  assert.match(settings, /As versões de pré-lançamento estão incluídas\./);
  assert.match(
    await collect(updateCommand(pt, INSTALL)),
    /A versão 1\.3\.0 está pronta\. Ela é instalada na próxima vez que você abrir o rpg\./,
  );
  const failure = (request: Promise<string>) => request.then(assert.fail, (error) => errorText('pt-BR', error));
  assert.match(
    await failure(collect(updateCommand({ ...pt, releasesUrl: CLOSED_PORT_URL }, CHECK))),
    /Não foi possível verificar atualizações: você parece estar sem conexão\./,
  );
  server.serve(RELEASES_PATH, { status: 403 });
  assert.match(
    await failure(collect(updateCommand(pt, CHECK))),
    /o GitHub pediu para esperar\. Tente de novo mais tarde\./,
  );
});

test('rpg-42a.53 the startup update notice reads in Brazilian Portuguese', async (t) => {
  const { context } = await setup(t);
  const first = await startupUpdate({ ...context, locale: 'pt-BR' }, { check: true });
  assert.deepEqual(first.messages, [
    'A versão 1.3.0 está disponível. Rode rpg update --check para ler as notas da versão.',
  ]);
});
