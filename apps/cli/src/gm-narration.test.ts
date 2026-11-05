import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { type ProviderReply, startProviderServer, textReply } from '../../../packages/testkit/src/provider-server.ts';
import {
  apiGameMaster,
  createEngineGateway,
  FAKE_GM_REPLY,
  type GameMaster,
  gameMasterFor,
  NO_KEY_NOTICE,
  noKeyGameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import { API_KEY_ENV, apiRouteOf, FAKE_ROUTE, GM_API_URL_ENV, GM_ROUTE_ENV } from './gm-api.ts';
import { hermeticGmEnv } from './gm-test-env.ts';

const CAMPAIGN = 'api-gm';
const KEY = 'sk-ant-gateway-test-key';
const NARRATION = 'Firelight catches the stranger smiling as you sit down.';
const ACTION = 'I sit by the fire';
const SECOND_ACTION = 'I order a drink';
const GM_SECRET = 'SECRET_THE_STRANGER_IS_THE_KING';
const PLAYER_FACT = 'The inn is called the Crossroads.';
const INSERT_FACT = 'INSERT INTO fact (id, campaign_id, statement, layer, visibility) VALUES (?, ?, ?, ?, ?)';
const CANON = 'canon';
const UNAUTHORIZED = 401;
const NO_DELAY_MS = 0;
const NO_CHARACTER = async () => undefined;

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-api-gm-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const seededCampaign = async (t: TestContext) => {
  const dataDir = tempDataDir(t);
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const campaignId = readCampaignState(dataDir, CAMPAIGN).campaign.id;
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  try {
    const insert = connection.database.prepare(INSERT_FACT);
    insert.run(randomUUID(), campaignId, GM_SECRET, CANON, 'gm');
    insert.run(randomUUID(), campaignId, PLAYER_FACT, CANON, 'player');
  } finally {
    connection.close();
  }
  return dataDir;
};

const providerGm = async (t: TestContext, replies: readonly ProviderReply[]) => {
  const provider = await startProviderServer(replies);
  t.after(provider.close);
  const route = { ...apiRouteOf(KEY, { [GM_API_URL_ENV]: provider.url }), retryDelayMs: NO_DELAY_MS };
  return { received: provider.received, gm: apiGameMaster(route) };
};

const play = async (dataDir: string, gm: GameMaster, actions: readonly string[]) => {
  const lines = (async function* () {
    yield* actions;
  })();
  const output: string[] = [];
  for await (const text of createEngineGateway(dataDir, gm).open(CAMPAIGN, 'play', lines, assert.ifError))
    output.push(text);
  return output.slice(1);
};

const lastNarration = (dataDir: string) => readCampaignState(dataDir, CAMPAIGN).turns.at(-1)?.narration;

describe('rpg-42a.28 API game master wiring', () => {
  it('records the provider narration from a player-only brief', async (t) => {
    const dataDir = await seededCampaign(t);
    const { received, gm } = await providerGm(t, [textReply(NARRATION)]);
    const [output] = await play(dataDir, gm, [ACTION]);
    assert.match(output ?? '', new RegExp(NARRATION));
    assert.equal(lastNarration(dataDir), NARRATION);
    const sent = JSON.stringify(received[0]?.body);
    assert.ok(sent.includes(ACTION));
    assert.ok(sent.includes(PLAYER_FACT));
    assert.ok(!sent.includes(GM_SECRET));
  });

  it('keeps a narration that leaks a GM secret out of the story', async (t) => {
    const dataDir = await seededCampaign(t);
    const { gm } = await providerGm(t, [textReply(`${NARRATION} ${GM_SECRET}`)]);
    await play(dataDir, gm, [ACTION]);
    assert.equal(lastNarration(dataDir), FAKE_GM_REPLY);
  });

  it('tells the player once about a provider error and continues on the fake route', async (t) => {
    const dataDir = await seededCampaign(t);
    const { received, gm } = await providerGm(t, [{ status: UNAUTHORIZED, body: KEY }]);
    const [first, second] = await play(dataDir, gm, [ACTION, SECOND_ACTION]);
    assert.match(first ?? '', /HTTP 401/);
    assert.ok(first?.endsWith(FAKE_GM_REPLY));
    assert.ok(!second?.includes('HTTP'));
    assert.ok(second?.endsWith(FAKE_GM_REPLY));
    assert.equal(received.length, 1);
    for (const text of [first, second]) assert.ok(!text?.includes(KEY));
  });

  it('tells the player once that no provider key is set', async (t) => {
    const dataDir = await seededCampaign(t);
    const [first, second] = await play(dataDir, noKeyGameMaster(), [ACTION, SECOND_ACTION]);
    assert.ok(first?.includes(NO_KEY_NOTICE));
    assert.ok(!second?.includes(NO_KEY_NOTICE));
    assert.ok(second?.endsWith(FAKE_GM_REPLY));
  });

  it('narrates a client session turn before the next snapshot', async (t) => {
    const dataDir = await seededCampaign(t);
    const { gm } = await providerGm(t, [textReply(NARRATION)]);
    const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm);
    t.after(close);
    const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
    const before = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(before.ok);
    const { revision, currentScene, characters } = before.value;
    const submitted = session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: revision,
      sceneId: currentScene?.id ?? '',
      actorId: characters[0]?.id ?? '',
      input: ACTION,
    });
    assert.ok(submitted.ok);
    await narrate();
    const after = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(after.ok);
    assert.equal(after.value.turns.at(-1)?.narration, NARRATION);
  });

  it('picks the game master from the key, or the built-in narrator when the player asks for it', async (t) => {
    const dataDir = await seededCampaign(t);
    const chosen = await gameMasterFor({ ...hermeticGmEnv(), [API_KEY_ENV]: KEY, [GM_ROUTE_ENV]: FAKE_ROUTE });
    assert.equal(chosen.route, 'fake');
    assert.deepEqual(await play(dataDir, chosen.gm, [ACTION]), [`The Wanderer: ${ACTION}\n${FAKE_GM_REPLY}`]);
    const missing = await gameMasterFor(hermeticGmEnv());
    assert.equal(missing.route, 'fake');
    assert.ok((await play(dataDir, missing.gm, [ACTION]))[0]?.includes(NO_KEY_NOTICE));
    assert.equal((await gameMasterFor({ ...hermeticGmEnv(), [API_KEY_ENV]: KEY })).route, 'api');
  });
});
