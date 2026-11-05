import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { type ClientSession, failure } from '../../../packages/client-protocol/src/protocol.ts';
import { startSound } from './engine-gateway.ts';
import { SOUND_SETTINGS_FILE } from './sound-files.ts';

const CAMPAIGN = 'campaign-1';
const REASON = 'snapshot is gone';
const dirs: string[] = [];

const dataDirWithSettings = async (withSettings: boolean) => {
  const dir = await mkdtemp(join(tmpdir(), 'sound-start-'));
  dirs.push(dir);
  if (withSettings) await writeFile(join(dir, SOUND_SETTINGS_FILE), '{}');
  return dir;
};

const brokenSession: Pick<ClientSession, 'getSnapshot' | 'subscribeEvents'> = {
  getSnapshot: () => failure('Rejected', REASON),
  subscribeEvents: () => () => undefined,
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('rpg-cm63.41 no sound settings file means no sound and no notice', async () => {
  assert.equal(await startSound(await dataDirWithSettings(false), brokenSession, CAMPAIGN, 'en'), undefined);
});

test('rpg-cm63.41 the unavailable notice is English by default', async () => {
  const notice = await startSound(await dataDirWithSettings(true), brokenSession, CAMPAIGN, 'en');
  assert.equal(notice, `Background sound is unavailable: ${REASON}`);
});

test('rpg-cm63.41 the unavailable notice follows the CLI locale', async () => {
  const notice = await startSound(await dataDirWithSettings(true), brokenSession, CAMPAIGN, 'pt-BR');
  assert.equal(notice, `O som de fundo não está disponível: ${REASON}`);
});
