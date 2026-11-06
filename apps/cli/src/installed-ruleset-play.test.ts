import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { CHECK_RESOLVED } from '../../../packages/domain/src/campaign.ts';
import { compileRule } from '../../../packages/rules/src/compile.ts';
import { D20_LITE_MANIFEST } from '../../../packages/rules/src/d20-lite.ts';
import { createSeededRng } from '../../../packages/rules/src/dice.ts';
import {
  createCampaignFrom,
  FAKE_GAME_MASTER,
  FAKE_GM_REPLY,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import { INSTALLED_DIR, installRuleset } from './installed-rulesets.ts';

const CAMPAIGN = 'installed-play';
const SEED = 7;
const ACTION = 'I try to climb the wall';
const REWRITTEN = 'check.rewritten';
const CHECK_RULE_IDS = ['check.critical', 'check.fumble', 'check.success', 'check.failure'];
const REWRITTEN_RULES = CHECK_RULE_IDS.map((id) => ({
  dslVersion: 1,
  id,
  effects: [{ kind: 'emitEvent', event: REWRITTEN }],
}));

const gm: GameMaster = {
  request: async () => ({ narration: FAKE_GM_REPLY, segments: [{ text: FAKE_GM_REPLY }] }),
  summarizer: FAKE_GAME_MASTER.summarizer,
};

const dataDirIn = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-installed-play-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const install = (dataDir: string, rules: readonly unknown[]) => {
  const manifest = { ...D20_LITE_MANIFEST, id: `${D20_LITE_MANIFEST.id}-import-0123456789ab` };
  const compiled = rules.map((rule) => {
    const result = compileRule({ rule: rule as never, rulePack: manifest, sourceRefs: ['sha256-imported'] });
    assert.ok(result.ok, JSON.stringify(result));
    return result.rule;
  });
  return installRuleset(dataDir, D20_LITE_MANIFEST, compiled);
};

const createOn = (dataDir: string, id: string) =>
  createCampaignFrom(dataDir, {
    version: PROTOCOL_VERSION,
    type: 'CreateCampaign',
    name: CAMPAIGN,
    choices: { ruleset: { id, edition: D20_LITE_MANIFEST.edition }, dice: 'rulepack' },
  });

const play = (dataDir: string) => {
  const opened = openClientSession(dataDir, CAMPAIGN, gm, createSeededRng(SEED));
  try {
    const envelope = { version: PROTOCOL_VERSION, campaignId: opened.campaignId } as const;
    const snapshot = opened.session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
    assert.ok(snapshot.ok);
    return opened.session.submitPlayerAction({
      ...envelope,
      type: 'SubmitPlayerAction',
      actionId: randomUUID(),
      expectedRevision: snapshot.value.revision,
      sceneId: snapshot.value.currentScene?.id ?? '',
      actorId: snapshot.value.characters[0]?.id ?? '',
      input: ACTION,
    });
  } finally {
    opened.close();
  }
};

const resolved = (dataDir: string) =>
  readCampaignState(dataDir, CAMPAIGN).events.filter(({ type }) => type === CHECK_RESOLVED);

test('rpg-42a.123 live play resolves the stored rules of the installed ruleset the campaign is pinned to', async (t) => {
  const dataDir = dataDirIn(t);
  const manifest = install(dataDir, REWRITTEN_RULES);
  await createOn(dataDir, manifest.id);
  assert.ok(play(dataDir).ok);
  const [check] = resolved(dataDir);
  const payload = check?.payload as { resolution: { events: { event: string }[]; version: { base: { id: string } } } };
  assert.equal(payload.resolution.events[0]?.event, REWRITTEN);
  assert.equal(payload.resolution.version.base.id, manifest.id);
});

test('rpg-42a.123 a base-pack campaign rolls the built-in table and pins no installed ruleset', async (t) => {
  const dataDir = dataDirIn(t);
  install(dataDir, REWRITTEN_RULES);
  await createOn(dataDir, D20_LITE_MANIFEST.id);
  assert.ok(play(dataDir).ok);
  const [check] = resolved(dataDir);
  const payload = check?.payload as { resolution: { events: { event: string }[]; version?: unknown } };
  assert.notEqual(payload.resolution.events[0]?.event, REWRITTEN);
  assert.equal(payload.resolution.version, undefined);
});

test('rpg-42a.123 a stored file that went missing or corrupt stops the roll with a clear error', async (t) => {
  const dataDir = dataDirIn(t);
  const manifest = install(dataDir, REWRITTEN_RULES);
  await createOn(dataDir, manifest.id);
  writeFileSync(join(dataDir, INSTALLED_DIR, `${manifest.id}.json`), '{not json');
  const refused = play(dataDir);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error.message, /Installed ruleset .* rejected: the file is not valid JSON/);
  assert.deepEqual(resolved(dataDir), []);
});
