import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { createEngine } from '../../../packages/engine/src/engine.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import {
  campaignDatabases,
  createCampaignFrom,
  createEngineGateway,
  FAKE_GAME_MASTER,
  type GameMaster,
  readCampaignState,
} from './engine-gateway.ts';
import type { Terminal } from './tui.ts';

const NAME = 'Interrupted';
const PORTUGUESE = 'pt-BR';
const ENGLISH_DEFAULT = /Crossroads|Rain drums/;
const PITCH = 'a fantasy adventure in a drowned chapel';
const IGNORE = () => undefined;

const create = (fields: { language?: string }) => ({
  version: PROTOCOL_VERSION as 1,
  type: 'CreateCampaign' as const,
  name: NAME,
  intent: PITCH,
  ...fields,
});

const fileOf = (dataDir: string, name: string) => join(dataDir, `${encodeURIComponent(name)}.sqlite`);

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const interrupt = (dataDir: string, language: string) => {
  const connection = openDatabase(fileOf(dataDir, NAME));
  createEngine(createCampaignStore(connection.database)).createCampaign(NAME, language);
  connection.close();
};

const opened = async (dataDir: string, gm: GameMaster) => {
  const out: string[] = [];
  const lines = (async function* () {})();
  for await (const text of createEngineGateway(dataDir, gm).open(NAME, 'play', lines, IGNORE, PORTUGUESE))
    out.push(text);
  return out.join('\n');
};

describe('rpg-asjw.16 interrupted campaign creation', () => {
  it('completes a campaign with no scene in its own language on open', async (t) => {
    const dataDir = tempDataDir(t);
    interrupt(dataDir, PORTUGUESE);
    const out = await opened(dataDir, FAKE_GAME_MASTER);
    assert.ok(readCampaignState(dataDir, NAME).currentScene !== undefined);
    assert.doesNotMatch(out, ENGLISH_DEFAULT);
  });

  it('asks the GM for the opening in the campaign language', async (t) => {
    const dataDir = tempDataDir(t);
    interrupt(dataDir, PORTUGUESE);
    const sent: string[] = [];
    const gm: GameMaster = {
      ...FAKE_GAME_MASTER,
      request: async (packet) => {
        sent.push(JSON.stringify(packet.sections));
        return { narration: 'A chuva bate na capela.', segments: [{ text: 'A chuva bate na capela.' }] };
      },
    };
    const out = await opened(dataDir, gm);
    assert.match(out, /capela/);
    assert.match(sent[0] ?? '', /pt-BR|Portuguese|portugu/i);
  });

  it('shows no English default scene in the recap of a campaign with no scene', async (t) => {
    const dataDir = tempDataDir(t);
    interrupt(dataDir, PORTUGUESE);
    const recap = createEngineGateway(dataDir, FAKE_GAME_MASTER).view(NAME, 'recap', PORTUGUESE);
    assert.doesNotMatch(recap, ENGLISH_DEFAULT);
  });

  it('shows a retry message when the opening cannot be completed', async (t) => {
    const dataDir = tempDataDir(t);
    interrupt(dataDir, PORTUGUESE);
    const failing: GameMaster = {
      ...FAKE_GAME_MASTER,
      request: async () => {
        throw new Error('boom');
      },
    };
    await assert.rejects(opened(dataDir, failing), (error: Error) => {
      assert.equal((error as { key?: string }).key, 'campaign.openingFailed');
      return true;
    });
    assert.equal(readCampaignState(dataDir, NAME).currentScene, undefined);
    await opened(dataDir, FAKE_GAME_MASTER);
    assert.ok(readCampaignState(dataDir, NAME).currentScene !== undefined);
  });

  it('shows a retry message from the terminal UI when the opening cannot be completed', async (t) => {
    const dataDir = tempDataDir(t);
    interrupt(dataDir, PORTUGUESE);
    const failing: GameMaster = {
      ...FAKE_GAME_MASTER,
      request: async () => {
        throw new Error('boom');
      },
    };
    await assert.rejects(
      createEngineGateway(dataDir, failing).tui(NAME, {} as Terminal),
      (error: Error) => (error as { key?: string }).key === 'campaign.openingFailed',
    );
  });

  it('never lists a killed creation file as a campaign and replaces it on the next create', async (t) => {
    const dataDir = tempDataDir(t);
    writeFileSync(`${fileOf(dataDir, NAME)}.creating`, 'partial');
    assert.deepEqual(campaignDatabases(dataDir), []);
    await createCampaignFrom(dataDir, create({ language: PORTUGUESE }));
    assert.ok(existsSync(fileOf(dataDir, NAME)));
    assert.ok(!existsSync(`${fileOf(dataDir, NAME)}.creating`));
    assert.ok(readCampaignState(dataDir, NAME).currentScene !== undefined);
  });

  it('leaves no file behind when creation fails', async (t) => {
    const dataDir = tempDataDir(t);
    const failing: GameMaster = {
      ...FAKE_GAME_MASTER,
      request: async () => {
        throw new Error('boom');
      },
    };
    await assert.rejects(createCampaignFrom(dataDir, create({}), undefined, failing));
    assert.ok(!existsSync(fileOf(dataDir, NAME)));
    assert.ok(!existsSync(`${fileOf(dataDir, NAME)}.creating`));
  });
});
