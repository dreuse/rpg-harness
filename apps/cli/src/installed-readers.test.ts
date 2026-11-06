import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { DEFAULT_RULES_USAGE } from '../../../packages/domain/src/rules-usage.ts';
import type { ContextPacket } from '../../../packages/memory/src/packet.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { createSeededRng } from '../../../packages/rules/src/dice.ts';
import { NARRATIVE_MANIFEST } from '../../../packages/rules/src/narrative.ts';
import { rulesUsageOf } from '../../../packages/rules/src/rulepack.ts';
import {
  createCampaignFrom,
  createEngineGateway,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  listCampaignSummaries,
  openClientSession,
} from './engine-gateway.ts';
import { installRuleset } from './installed-rulesets.ts';
import { creationRulesFor, packsIn, planCampaign, styleLinesOf, usageFor } from './quickstart.ts';

const withDataDir = (run: (dataDir: string) => void) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-installed-readers-'));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const pinnedTo = (dataDir: string, base: typeof D20_LITE_MANIFEST) => {
  const installed = installRuleset(dataDir, base, []);
  return planCampaign(undefined, { ruleset: { id: installed.id, edition: installed.edition } }, packsIn(dataDir));
};

test('rpg-42a.124 an installed ruleset yields its real usage, not the defaults', () =>
  withDataDir((dataDir) => {
    const { rulepack } = pinnedTo(dataDir, NARRATIVE_MANIFEST);
    assert.deepEqual(usageFor(rulepack), DEFAULT_RULES_USAGE);
    assert.deepEqual(usageFor(rulepack, packsIn(dataDir)), rulesUsageOf(NARRATIVE_MANIFEST));
  }));

const CAMPAIGN = 'readers';
const HERO = 'Ada, a baker';
const SEED = 7;

const createNarrative = async (dataDir: string) => {
  const installed = installRuleset(dataDir, NARRATIVE_MANIFEST, []);
  const gateway = createEngineGateway(dataDir);
  const intent = `A horror story using the ${installed.id} rules`;
  for await (const _ of gateway.create(CAMPAIGN, intent, async () => HERO));
  return { installed, gateway };
};

test('rpg-42a.124 rpg new resolves an installed ruleset named in the pitch and pins it', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-installed-readers-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { installed } = await createNarrative(dataDir);
  assert.equal(listCampaignSummaries(dataDir).find(({ name }) => name === CAMPAIGN)?.ruleset?.id, installed.id);
});

test('rpg-42a.124 the sheet view of an installed diceless ruleset says there are no sheets', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-installed-readers-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const { gateway } = await createNarrative(dataDir);
  assert.match(gateway.view(CAMPAIGN, 'sheet'), /does not use character sheets/);
});

const requestedPackets = async (dataDir: string, base: typeof D20_LITE_MANIFEST) => {
  const installed = installRuleset(dataDir, base, []);
  await createCampaignFrom(dataDir, {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: CAMPAIGN,
    choices: { ruleset: { id: installed.id, edition: installed.edition } },
  });
  const packets: ContextPacket[] = [];
  const gm: GameMaster = {
    request: async (packet) => {
      packets.push(packet);
      return { narration: FAKE_GM_REPLY, segments: [{ text: FAKE_GM_REPLY }] };
    },
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const opened = openClientSession(dataDir, CAMPAIGN, gm, createSeededRng(SEED));
  try {
    const envelope = { version: PROTOCOL_VERSION, campaignId: opened.campaignId } as const;
    const snapshot = opened.session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(snapshot.ok);
    await opened.session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: snapshot.value.revision,
      sceneId: snapshot.value.currentScene?.id ?? '',
      actorId: snapshot.value.characters[0]?.id ?? '',
      input: 'I look around',
    });
    await opened.narrate();
    return { rules: snapshot.value.rules, packets };
  } finally {
    opened.close();
  }
};

const freshDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-installed-readers-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

test('rpg-42a.124 live play reports the usage of the installed ruleset', async (t) => {
  const { rules } = await requestedPackets(freshDataDir(t), NARRATIVE_MANIFEST);
  assert.deepEqual(rules, rulesUsageOf(NARRATIVE_MANIFEST));
});

test('rpg-42a.124 live play sends the style of the installed ruleset to the GM', async (t) => {
  const { packets } = await requestedPackets(freshDataDir(t), D20_LITE_MANIFEST);
  const style = packets.flatMap((packet) =>
    packet.sections.filter(({ name }) => name === 'style').flatMap(({ items }) => items),
  );
  assert.ok(
    style.some((line) => line.startsWith('rulepack ')),
    JSON.stringify(style),
  );
});

test('rpg-42a.124 an installed ruleset yields its style lines', () =>
  withDataDir((dataDir) => {
    const config = pinnedTo(dataDir, D20_LITE_MANIFEST);
    assert.ok(D20_LITE_MANIFEST.style !== undefined);
    assert.equal(
      styleLinesOf(config).some((line) => line.startsWith('rulepack ')),
      false,
    );
    assert.equal(
      styleLinesOf(config, packsIn(dataDir)).some((line) => line.startsWith('rulepack ')),
      true,
    );
  }));

test('rpg-42a.124 an installed ruleset uses the creation rules of its base pack', () =>
  withDataDir((dataDir) => {
    const { rulepack } = pinnedTo(dataDir, D20_LITE_MANIFEST);
    assert.equal(creationRulesFor(rulepack)?.schema.rulepack.id, D20_LITE_MANIFEST.id);
  }));
