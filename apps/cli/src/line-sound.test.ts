import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EVENT_COMMITTED, PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { createEngineGateway, FAKE_GAME_MASTER, lineSoundSession, readCampaignState } from './engine-gateway.ts';

const NAME = 'Line sound';
const PITCH = 'a fantasy adventure in a drowned chapel';
const IGNORE = () => undefined;
const NO_ANSWERS = (async function* () {})();

test('rpg-asjw.35 line-mode play starts the sound runtime once for the campaign', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-line-sound-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const started: string[] = [];
  const gateway = createEngineGateway(dataDir, FAKE_GAME_MASTER, Math.random, undefined, async (dir, _session, id) => {
    started.push(`${dir}:${id}`);
    return undefined;
  });
  for await (const _ of gateway.create(NAME, PITCH, async () => ''));
  for await (const _ of gateway.open(NAME, 'play', NO_ANSWERS, IGNORE, 'en'));
  assert.equal(started.length, 1);
  assert.ok(started[0]?.startsWith(dataDir));
});

test('rpg-asjw.35 the line-mode adapter delivers a committed event on refresh and reads the current scene', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-line-sound-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const gateway = createEngineGateway(dataDir);
  for await (const _ of gateway.create(NAME, PITCH, async () => ''));
  const campaignId = readCampaignState(dataDir, NAME).campaign.id;
  const sound = lineSoundSession(dataDir, NAME, FAKE_GAME_MASTER, campaignId);
  const types: string[] = [];
  sound.session.subscribeEvents(
    { version: PROTOCOL_VERSION, type: 'SubscribeEvents', campaignId, fromRevision: 0 },
    (event) => types.push(event.type),
  );
  sound.refresh();
  const snapshot = sound.session.getSnapshot({ version: PROTOCOL_VERSION, type: 'GetCampaignSnapshot', campaignId });
  assert.deepEqual(types, [EVENT_COMMITTED]);
  assert.ok(snapshot.ok && snapshot.value.currentScene !== undefined);
});
