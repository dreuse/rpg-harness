import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { startProviderServer, textReply } from '../../../packages/testkit/src/provider-server.ts';
import { apiGameMaster, createEngineGateway, openClientSession, readCampaignState } from './engine-gateway.ts';
import { apiRouteOf, GM_API_URL_ENV, ProviderError } from './gm-api.ts';

const CAMPAIGN = 'recovery';
const KEY = 'sk-ant-recovery-key';
const REAL_NARRATION = 'The stranger nods and slides a worn key across the bar.';
const PLACEHOLDER = 'The world shifts in answer.';
const SUMMARY = 'The party met a stranger at the bar.';
const REFUSED = { status: 401, body: '{}' };
const NO_CHARACTER = async () => undefined;
const PENDING = '';

const start = async (t: TestContext, replies: Parameters<typeof startProviderServer>[0]) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const provider = await startProviderServer(replies);
  t.after(provider.close);
  const gm = apiGameMaster({ ...apiRouteOf(KEY, { [GM_API_URL_ENV]: provider.url }), retryDelayMs: 0 });
  const opened = openClientSession(dataDir, CAMPAIGN, gm);
  t.after(() => opened.close());
  return { dataDir, provider, gm, opened };
};

const act = (opened: ReturnType<typeof openClientSession>, actionId: string, input = 'I greet the stranger') => {
  const { session, campaignId } = opened;
  const snapshot = session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.ok(snapshot.ok);
  const result = session.submitPlayerAction({
    version: PROTOCOL_VERSION,
    type: 'SubmitPlayerAction',
    campaignId,
    actionId,
    expectedRevision: snapshot.value.revision,
    sceneId: snapshot.value.currentScene?.id ?? '',
    actorId: snapshot.value.characters[0]?.id ?? '',
    input,
  });
  assert.ok(result.ok);
};

const narrations = (dataDir: string) => readCampaignState(dataDir, CAMPAIGN).turns.map(({ narration }) => narration);

describe('rpg-42a.101 the game master recovers after a provider failure', () => {
  it('narrates the next turn with the provider after a failed turn', async (t) => {
    const { dataDir, opened } = await start(t, [REFUSED, textReply(REAL_NARRATION)]);
    act(opened, 'turn-1');
    await assert.rejects(opened.narrate(), ProviderError);
    act(opened, 'turn-2', 'I ask about the key');
    await opened.narrate();
    assert.equal(narrations(dataDir).at(-1), REAL_NARRATION);
  });

  it('commits no placeholder narration for a failed turn', async (t) => {
    const { dataDir, opened } = await start(t, [REFUSED]);
    act(opened, 'turn-1');
    await assert.rejects(opened.narrate(), ProviderError);
    const stored = narrations(dataDir);
    assert.equal(stored.at(-1), PENDING);
    assert.ok(!stored.some((text) => text.includes(PLACEHOLDER)));
  });

  it('retries the same action and replays it without a second turn', async (t) => {
    const { dataDir, opened } = await start(t, [REFUSED, textReply(REAL_NARRATION)]);
    act(opened, 'turn-1');
    const before = readCampaignState(dataDir, CAMPAIGN);
    await assert.rejects(opened.narrate(), ProviderError);
    act(opened, 'turn-1');
    await opened.narrate();
    const after = readCampaignState(dataDir, CAMPAIGN);
    assert.equal(after.turns.length, before.turns.length);
    assert.equal(after.turns.at(-1)?.narration, REAL_NARRATION);
    assert.equal(after.turns.at(-1)?.actionId, 'turn-1');
  });

  it('retries the provider for summaries after a failed turn', async (t) => {
    const { gm, opened } = await start(t, [REFUSED, textReply(SUMMARY)]);
    act(opened, 'turn-1');
    await assert.rejects(opened.narrate(), ProviderError);
    assert.equal(await gm.summarizer('scene', ['The party met a stranger.'], undefined), SUMMARY);
  });
});
