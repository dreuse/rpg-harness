import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignStore, SYSTEM_TURN } from '../../../packages/domain/src/campaign.ts';
import type { RuleCitation } from '../../../packages/domain/src/character.ts';
import { type CitedRuleMove, RuleCitationError, resolveCitedRule } from '../../../packages/engine/src/mechanics.ts';
import { effectiveMechanics } from '../../../packages/imports/src/effective-mechanics.ts';
import { type LayerInput, resolveLayers } from '../../../packages/imports/src/layer-precedence.ts';
import { GM_VIEWER } from '../../../packages/memory/src/knowledge.ts';
import { assembleGmContext, citeRule } from '../../../packages/narrative/src/context.ts';
import { FREEFORM_INTENT, interpretAction } from '../../../packages/narrative/src/interpret.ts';
import { createCampaignStore } from '../../../packages/persistence/src/campaign-store.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { RULE_DSL_VERSION } from '../../../packages/rules/src/dsl.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from '../../../packages/rules/src/rulepack.ts';
import type { TraitSheet } from '../../../packages/rules/src/traits.ts';
import { createScriptedRng } from '../../../packages/testkit/src/fixtures.ts';

const IN_MEMORY = ':memory:';
const SETUP_REVISION = 1;
const BUDGET = 10_000;
const DIE_SIDES = 10;
const SKILL = 3;
const DRAW = 0.45;
const FACE = 5;
const RESOLVED = 'RuleResolved';
const ADJUDICATED = 'RuleAdjudicated';
const GM_ADJUDICATED = 'gm-adjudicated';
const BASE_SOURCE = 'core-book';
const ERRATA_SOURCE = 'errata-1';
const STRIKE = 'rule-strike';
const PARLEY = 'rule-parley';
const RITUAL = 'rule-ritual';
const RULE_PACK = { id: 'house-pack', edition: 'core', revision: 'r2' };
const MANIFEST: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  ...RULE_PACK,
  capabilities: { random: true, arithmetic: true, effects: true, condition: 'adjudicated', comparison: 'adjudicated' },
  sourceRefs: [BASE_SOURCE, ERRATA_SOURCE],
};
const CAMPAIGN = { id: 'campaign-1', name: 'Salt Roads' };
const HERO = { id: 'hero', campaignId: CAMPAIGN.id, name: 'Ilse' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Toll Bridge' };

const strike = (sides: number) => ({
  dslVersion: RULE_DSL_VERSION,
  id: STRIKE,
  effects: [
    {
      kind: 'setTrait',
      trait: 'outcome',
      value: {
        kind: 'arith',
        op: 'add',
        left: { kind: 'dice', count: 1, sides, modifier: 0 },
        right: { kind: 'ref', id: 'skill' },
      },
    },
    { kind: 'emitEvent', event: 'strike.made' },
  ],
});
const PARLEY_RULE = {
  dslVersion: RULE_DSL_VERSION,
  id: PARLEY,
  when: { kind: 'compare', op: 'gte', left: { kind: 'ref', id: 'skill' }, right: { kind: 'const', value: 1 } },
  effects: [{ kind: 'emitEvent', event: 'parley.opened' }],
};
const LAYERS: LayerInput = {
  rulePack: RULE_PACK,
  layers: [
    {
      kind: 'base',
      sourceRef: BASE_SOURCE,
      rulePack: RULE_PACK,
      entries: [
        { id: STRIKE, revision: 'b1', value: strike(DIE_SIDES * 2) },
        { id: PARLEY, revision: 'b1', value: PARLEY_RULE },
        { id: RITUAL, revision: 'b1', value: 'The spirits answer if the moon agrees.' },
      ],
    },
    {
      kind: 'errata',
      sourceRef: ERRATA_SOURCE,
      rulePack: RULE_PACK,
      entries: [{ id: STRIKE, revision: 'e1', value: strike(DIE_SIDES) }],
    },
  ],
};
const SHEET: TraitSheet = {
  characterId: HERO.id,
  traits: [
    { id: 'skill', kind: 'trait', value: SKILL },
    { id: 'outcome', kind: 'trait', value: 0 },
  ],
};

const mechanics = () => {
  const layered = resolveLayers(LAYERS);
  assert.ok(layered.ok);
  const result = effectiveMechanics(layered.resolved, MANIFEST);
  assert.ok(result.ok);
  return result.mechanics;
};

const gmContext = () =>
  assembleGmContext(
    {
      snapshot: {
        scene: SCENE,
        sceneEntityIds: [],
        pinnedFactIds: [],
        entities: [],
        relationships: [],
        threads: [],
        facts: [],
        events: [],
      },
      rulepack: RULE_PACK,
      rules: mechanics().map(({ ruleId, source }) => ({
        id: ruleId,
        summary: `imported ${ruleId}`,
        section: source.sourceRef,
        visibility: 'public',
        actorId: null,
      })),
      budget: BUDGET,
    },
    GM_VIEWER,
  );

const openStore = () => {
  const { database } = openDatabase(IN_MEMORY);
  const store = createCampaignStore(database);
  store.createCampaign(CAMPAIGN, {
    id: 'created-1',
    campaignId: CAMPAIGN.id,
    branchId: 'main',
    actionId: 'create',
    type: 'CampaignCreated',
    payload: { name: CAMPAIGN.name },
  });
  store.commitTurn({
    expectedRevision: 0,
    turn: {
      id: 'turn-0',
      campaignId: CAMPAIGN.id,
      sceneId: SCENE.id,
      actionId: 'setup',
      actorId: HERO.id,
      input: 'Begin.',
      narration: 'Wind drags at the ropes.',
    },
    characters: [HERO],
    scenes: [SCENE],
    events: [],
  });
  return store;
};

const proposalCiting = (actionId: string, ruleId: string) => {
  const context = gmContext();
  const interpretation = interpretAction(
    { actionId, sceneId: SCENE.id, actorId: HERO.id, input: 'I try my luck.' },
    context,
    [],
  );
  assert.equal(interpretation.kind, 'proposal');
  return { ...interpretation.proposal, citation: citeRule(context, ruleId) };
};

const move = (actionId: string, citation: RuleCitation, rng = createScriptedRng([DRAW])): CitedRuleMove => ({
  ...proposalCiting(actionId, citation.ruleId),
  citation,
  campaignId: CAMPAIGN.id,
  expectedRevision: SETUP_REVISION,
  rulePack: RULE_PACK,
  mechanics: mechanics(),
  sheet: SHEET,
  rng,
});

const cited = (ruleId: string): RuleCitation => {
  const citation = proposalCiting(ruleId, ruleId).citation;
  assert.ok(citation);
  return citation;
};

const lastEvent = (store: CampaignStore, actionId: string, ruleId: string) =>
  resolveCitedRule(store, move(actionId, cited(ruleId))).events.at(-1);

test('gm selects and cites imported rules while engine resolves supported mechanics', () => {
  assert.deepEqual(
    mechanics().map(({ ruleId, kind }) => [ruleId, kind]),
    [
      [PARLEY, GM_ADJUDICATED],
      [RITUAL, GM_ADJUDICATED],
      [STRIKE, 'deterministic'],
    ],
  );
  const proposal = proposalCiting('strike-1', STRIKE);
  assert.equal(proposal.intent, FREEFORM_INTENT);
  assert.deepEqual(proposal.citation, { ruleId: STRIKE, rulepack: RULE_PACK, section: ERRATA_SOURCE });
  assert.equal(citeRule(gmContext(), 'rule-unknown'), undefined);

  const event = lastEvent(openStore(), 'strike-1', STRIKE);
  assert.equal(event?.type, RESOLVED);
  const payload = (event?.payload ?? {}) as Record<string, unknown>;
  assert.deepEqual(payload.citation, proposal.citation);
  assert.deepEqual(payload.rulePack, RULE_PACK);
  assert.deepEqual(payload.source, { kind: 'errata', sourceRef: ERRATA_SOURCE, revision: 'e1' });
  const resolution = payload.resolution as Record<string, unknown>;
  assert.equal(resolution.ok, true);
  assert.deepEqual(resolution.changes, [{ id: 'outcome', from: 0, to: FACE + SKILL }]);
  assert.deepEqual(resolution.events, [{ actionId: 'strike-1', ruleId: STRIKE, event: 'strike.made' }]);
  assert.equal((resolution.rolls as unknown[]).length, 1);
  assert.deepEqual(lastEvent(openStore(), 'strike-1', STRIKE)?.payload, event?.payload);
});

test('unsupported mechanics use visibly designated adjudication, never a fake deterministic check', () => {
  const store = openStore();
  const neverRolls = () => assert.fail('adjudicated mechanics must not draw randomness');
  const parley = resolveCitedRule(store, move('parley-1', cited(PARLEY), neverRolls)).events.at(-1);
  assert.equal(parley?.type, ADJUDICATED);
  assert.deepEqual(parley?.payload, {
    mode: GM_ADJUDICATED,
    citation: cited(PARLEY),
    rulePack: RULE_PACK,
    source: { kind: 'base', sourceRef: BASE_SOURCE, revision: 'b1' },
    reason: 'AdjudicatedCapability',
    issues: [
      { path: 'capabilities.comparison', message: `is adjudicated in rule pack ${RULE_PACK.id}` },
      { path: 'capabilities.condition', message: `is adjudicated in rule pack ${RULE_PACK.id}` },
    ],
  });
  const ritual = resolveCitedRule(store, { ...move('ritual-1', cited(RITUAL), neverRolls), expectedRevision: 2 });
  const payload = ritual.events.at(-1)?.payload ?? {};
  assert.equal(ritual.turn.kind, SYSTEM_TURN);
  assert.equal(ritual.events.at(-1)?.type, ADJUDICATED);
  assert.equal(payload.mode, GM_ADJUDICATED);
  assert.equal(payload.reason, 'InvalidRuleDsl');
  assert.ok(!Object.hasOwn(payload, 'resolution'));
  assert.ok(ritual.events.every(({ payload: data }) => !Object.hasOwn(data, 'rolls')));
});

test('engine rejects citations outside the pinned effective ruleset without writing state', () => {
  const store = openStore();
  const reject = (citation: RuleCitation, code: string) =>
    assert.throws(
      () => resolveCitedRule(store, move('bad', citation)),
      (error) => error instanceof RuleCitationError && error.code === code,
    );
  const strikeCitation = cited(STRIKE);
  reject({ ...strikeCitation, ruleId: 'rule-unknown' }, 'UnknownRule');
  reject({ ...strikeCitation, rulepack: { ...RULE_PACK, revision: 'r1' } }, 'RulePackMismatch');
  reject({ ...strikeCitation, section: BASE_SOURCE }, 'SourceMismatch');
  assert.equal(store.load(CAMPAIGN.id)?.revision, SETUP_REVISION);

  const layered = resolveLayers(LAYERS);
  assert.ok(layered.ok);
  const stale = effectiveMechanics(layered.resolved, { ...MANIFEST, revision: 'r1' });
  assert.deepEqual(stale, {
    ok: false,
    error: { code: 'RulePackMismatch', issues: [{ path: 'rulePack.revision', message: 'must be r2' }] },
  });
});
