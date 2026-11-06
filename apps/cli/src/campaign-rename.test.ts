import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { archiveCampaign, createCampaignFrom, listCampaignSummaries, renameCampaign } from './engine-gateway.ts';

const OLD_NAME = 'Ashfall';
const NEW_NAME = 'Cinders';
const OTHER_NAME = 'Embers';

const fileOf = (dataDir: string, name: string) => join(dataDir, `${encodeURIComponent(name)}.sqlite`);

const created = async (t: TestContext, ...names: string[]) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-rename-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for (const name of names)
    await createCampaignFrom(dataDir, { version: PROTOCOL_VERSION, type: 'CreateCampaign', name });
  return dataDir;
};

describe('rpg-42a.66 rename campaign', () => {
  it('moves the save and renames the campaign inside it', async (t) => {
    const dataDir = await created(t, OLD_NAME);
    renameCampaign(dataDir, OLD_NAME, ` ${NEW_NAME} `);
    assert.ok(!existsSync(fileOf(dataDir, OLD_NAME)));
    assert.ok(existsSync(fileOf(dataDir, NEW_NAME)));
    assert.deepEqual(
      listCampaignSummaries(dataDir).map(({ name }) => name),
      [NEW_NAME],
    );
  });

  it('refuses a taken, archived, blank or unknown name and keeps the save', async (t) => {
    const dataDir = await created(t, OLD_NAME, OTHER_NAME, 'Gone');
    archiveCampaign(dataDir, 'Gone');
    assert.throws(() => renameCampaign(dataDir, OLD_NAME, OTHER_NAME), /already exists/);
    assert.throws(() => renameCampaign(dataDir, OLD_NAME, 'Gone'), /already exists/);
    assert.throws(() => renameCampaign(dataDir, OLD_NAME, '  '), /blank/);
    assert.throws(() => renameCampaign(dataDir, 'Nobody', NEW_NAME), /No campaign named/);
    assert.ok(existsSync(fileOf(dataDir, OLD_NAME)));
  });
});
