import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClarificationPlan } from './clarification.ts';
import { CONFIG_VERSION, generateCampaignConfig, parseCampaignConfig } from './config.ts';
import { createCampaignIntent } from './intent.ts';
import type { Registry } from './registry.ts';

const RULESET_ID = 'fantasy-core';
const EDITION = '2e';
const BARE_EDITION = '3e';
const ABSENT_EDITION = '1.9';
const REVISION = '1.2.0';
const GENRE_ID = 'noir';
const GENRE_VERSION = '1.0.0';
const OTHER_GENRE_VERSION = '2.0.0';

const REGISTRY: Registry = {
  rulepacks: [
    {
      id: RULESET_ID,
      edition: EDITION,
      revision: REVISION,
      capabilities: { dice: true, combat: 'adjudicated' },
      sourceRefs: ['srd:core'],
    },
    { id: RULESET_ID, edition: BARE_EDITION, revision: '0.1.0', capabilities: {}, sourceRefs: [] },
  ],
  genres: [{ id: GENRE_ID, version: GENRE_VERSION }],
};
const TWO_GENRES: Registry = {
  ...REGISTRY,
  genres: [...REGISTRY.genres, { id: GENRE_ID, version: OTHER_GENRE_VERSION }],
};

const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });
const derived = <T>(value: T) => ({ value, provenance: 'derived' as const });
const plan = (overrides: Partial<ClarificationPlan>): ClarificationPlan => ({
  questions: [],
  deferred: [],
  defaults: [],
  ...overrides,
});
const proposal = (field: 'pacing' | 'client', value: unknown) => ({
  field,
  value,
  provenance: 'default' as const,
  revert: { value, provenance: 'default' as const },
});

test('N07 store effective config, provenance of explicit/default choices and capability decisions', () => {
  const intent = createCampaignIntent({
    ruleset: explicit({ id: RULESET_ID, edition: EDITION }),
    genre: derived(GENRE_ID),
    combat: explicit('on'),
    pacing: explicit('fast'),
  });
  const result = generateCampaignConfig(intent, REGISTRY);
  assert.ok(result.ok);
  const { config } = result;

  assert.equal(config.configVersion, CONFIG_VERSION);
  assert.equal(config.values.pacing, 'fast');
  assert.equal(config.values.client, 'cli');
  assert.deepEqual(config.values.ruleset, { id: RULESET_ID, edition: EDITION });
  assert.equal(config.provenance.ruleset, 'explicit');
  assert.equal(config.provenance.genre, 'derived');
  assert.equal(config.provenance.client, 'default');
  assert.deepEqual(config.rulepack, { id: RULESET_ID, edition: EDITION, revision: REVISION });
  assert.deepEqual(config.genre, { id: GENRE_ID, version: GENRE_VERSION });
  assert.deepEqual(config.capabilities, {
    advertised: ['dice', 'combat'],
    supported: ['dice', 'combat'],
    unsupported: ['attributes'],
    modes: { dice: 'rulepack', attributes: 'rulepack', combat: 'on' },
  });
  assert.deepEqual(config.dropped, []);

  const stored = JSON.parse(JSON.stringify(config));
  assert.deepEqual(parseCampaignConfig(stored), { ok: true, config });

  const narrative = generateCampaignConfig(createCampaignIntent({}), REGISTRY);
  assert.ok(narrative.ok);
  assert.equal(narrative.config.rulepack, null);
  assert.equal(narrative.config.genre, null);
  assert.deepEqual(narrative.config.capabilities.advertised, []);

  const future = parseCampaignConfig({ ...stored, configVersion: CONFIG_VERSION + 1 });
  assert.deepEqual(future, { ok: false, issues: [{ code: 'unsupported_version', path: 'configVersion' }] });
  const repinned = parseCampaignConfig({ ...stored, rulepack: { ...stored.rulepack, edition: BARE_EDITION } });
  assert.deepEqual(repinned, { ok: false, issues: [{ code: 'mismatch', path: 'rulepack' }] });
  const flipped = parseCampaignConfig({ ...stored, capabilities: { ...stored.capabilities, modes: {} } });
  assert.ok(!flipped.ok);
  assert.ok(flipped.issues.some((issue) => issue.path === 'capabilities.modes'));
  assert.ok(!parseCampaignConfig({ ...stored, extra: true }).ok);
});

test('N07 invalid inferred options do not produce a campaign or override user intent', () => {
  const failing = (result: ReturnType<typeof generateCampaignConfig>) => {
    assert.ok(!result.ok);
    assert.ok(!('config' in result));
    return result.issues;
  };

  const absent = createCampaignIntent({ ruleset: explicit({ id: RULESET_ID, edition: ABSENT_EDITION }) });
  assert.deepEqual(failing(generateCampaignConfig(absent, REGISTRY)), [{ code: 'not_installed', path: 'ruleset' }]);

  const unpinned = createCampaignIntent({ ruleset: derived({ id: RULESET_ID, edition: null }) });
  assert.deepEqual(failing(generateCampaignConfig(unpinned, REGISTRY)), [{ code: 'ambiguous', path: 'ruleset' }]);

  const genre = createCampaignIntent({ genre: derived(GENRE_ID) });
  assert.deepEqual(failing(generateCampaignConfig(genre, TWO_GENRES)), [{ code: 'ambiguous', path: 'genre' }]);

  const inferredCombat = createCampaignIntent({
    ruleset: explicit({ id: RULESET_ID, edition: BARE_EDITION }),
    combat: derived('on'),
  });
  assert.deepEqual(failing(generateCampaignConfig(inferredCombat, REGISTRY)), [{ code: 'conflict', path: 'combat' }]);

  const badInference = createCampaignIntent({ pacing: derived('warp' as 'fast') });
  assert.deepEqual(failing(generateCampaignConfig(badInference, REGISTRY)), [
    { code: 'invalid_value', path: 'intent.pacing.value' },
  ]);

  const pending = plan({ questions: [{ code: 'ruleset_unknown', fields: ['ruleset'], options: [] }] });
  assert.deepEqual(failing(generateCampaignConfig(createCampaignIntent({}), REGISTRY, pending)), [
    { code: 'clarification_pending', path: 'ruleset' },
  ]);

  const forged = plan({ defaults: [proposal('client', 'desktop')] });
  assert.deepEqual(failing(generateCampaignConfig(createCampaignIntent({}), REGISTRY, forged)), [
    { code: 'invalid_value', path: 'intent.client.value' },
  ]);

  const user = createCampaignIntent({ pacing: explicit('fast') });
  const overriding = plan({ defaults: [proposal('pacing', 'balanced')] });
  const kept = generateCampaignConfig(user, REGISTRY, overriding);
  assert.ok(kept.ok);
  assert.equal(kept.config.values.pacing, 'fast');
  assert.equal(kept.config.provenance.pacing, 'explicit');
  assert.deepEqual(kept.config.dropped, [{ field: 'pacing', value: 'balanced', reason: 'explicit_wins' }]);
});

test('N07 stored configs that generation would refuse do not load', () => {
  const store = (result: ReturnType<typeof generateCampaignConfig>) => {
    assert.ok(result.ok);
    return JSON.parse(JSON.stringify(result.config));
  };
  const bare = store(
    generateCampaignConfig(
      createCampaignIntent({ ruleset: explicit({ id: RULESET_ID, edition: BARE_EDITION }) }),
      REGISTRY,
    ),
  );
  const forcedCombat = {
    ...bare,
    values: { ...bare.values, combat: 'on' },
    provenance: { ...bare.provenance, combat: 'explicit' },
    capabilities: { ...bare.capabilities, modes: { ...bare.capabilities.modes, combat: 'on' } },
  };
  assert.ok(!parseCampaignConfig(forcedCombat).ok);

  const inferredVisuals = {
    ...bare,
    values: { ...bare.values, diceVisualization: true },
    provenance: { ...bare.provenance, diceVisualization: 'derived' },
  };
  assert.ok(!parseCampaignConfig(inferredVisuals).ok);

  const full = store(
    generateCampaignConfig(createCampaignIntent({ ruleset: explicit({ id: RULESET_ID, edition: EDITION }) }), REGISTRY),
  );
  const widened = { ...full, capabilities: { ...full.capabilities, supported: ['dice', 'attributes', 'combat'] } };
  assert.ok(!parseCampaignConfig(widened).ok);
  const hidden = { ...full, capabilities: { ...full.capabilities, unsupported: [] } };
  assert.ok(!parseCampaignConfig(hidden).ok);

  const forgedDrop = { ...full, dropped: [{ field: 'client', value: 'cli', reason: 'explicit_wins' }] };
  assert.ok(!parseCampaignConfig(forgedDrop).ok);

  const inferred = createCampaignIntent({ pacing: derived('slow') });
  const derivedKept = generateCampaignConfig(inferred, REGISTRY, plan({ defaults: [proposal('pacing', 'balanced')] }));
  assert.ok(derivedKept.ok);
  assert.equal(derivedKept.config.values.pacing, 'slow');
  assert.deepEqual(derivedKept.config.dropped, [{ field: 'pacing', value: 'balanced', reason: 'derived_wins' }]);
  assert.ok(parseCampaignConfig(store(derivedKept)).ok);
  const misattributed = {
    ...store(derivedKept),
    dropped: [{ field: 'pacing', value: 'balanced', reason: 'explicit_wins' }],
  };
  assert.ok(!parseCampaignConfig(misattributed).ok);
});
