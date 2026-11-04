import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CampaignIntent,
  createCampaignIntent,
  INTENT_FIELDS,
  isExplicitConsent,
  PROVENANCES,
  parseCampaignIntent,
} from './intent.ts';

const issueOf = (input: unknown) => {
  const result = parseCampaignIntent(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues;
};

test('N01 represents ruleset with edition, genre, mood, simulation, pacing, character and optional features', () => {
  const intent = createCampaignIntent({
    ruleset: { value: { id: 'open-d6', edition: '2' }, provenance: 'explicit' },
    genre: { value: 'noir', provenance: 'explicit' },
    mood: { value: 'tense', provenance: 'explicit' },
    simulation: { value: 'dynamic', provenance: 'explicit' },
    pacing: { value: 'fast', provenance: 'explicit' },
    character: { value: 'retired cartographer', provenance: 'explicit' },
    voiceInput: { value: true, provenance: 'explicit' },
    houseRules: { value: ['no-crits'], provenance: 'explicit' },
    timeline: { value: 'branching', provenance: 'explicit' },
  });
  assert.deepEqual(intent.ruleset.value, { id: 'open-d6', edition: '2' });
  assert.equal(intent.genre.value, 'noir');
  assert.equal(intent.mood.value, 'tense');
  assert.equal(intent.simulation.value, 'dynamic');
  assert.equal(intent.pacing.value, 'fast');
  assert.equal(intent.character.value, 'retired cartographer');
  assert.equal(intent.voiceInput.value, true);
  assert.deepEqual(intent.houseRules.value, ['no-crits']);
  assert.equal(intent.timeline.value, 'branching');
});

test('N01 unspecified capabilities are defaulted with provenance default and are not explicit consent', () => {
  const intent = createCampaignIntent({});
  assert.equal(intent.ruleset.value, null);
  assert.equal(intent.dice.value, 'rulepack');
  assert.equal(intent.attributes.value, 'rulepack');
  assert.equal(intent.combat.value, 'rulepack');
  assert.equal(intent.simulation.value, 'off');
  assert.equal(intent.pacing.value, 'balanced');
  for (const key of [
    'voiceInput',
    'voiceOutput',
    'ambience',
    'diceVisualization',
    'rulebookImport',
    'doltStorage',
  ] as const) {
    assert.equal(intent[key].value, false);
  }
  assert.equal(intent.client.value, 'cli');
  assert.deepEqual(intent.houseRules.value, []);
  assert.equal(intent.timeline.value, 'linear');
  for (const field of INTENT_FIELDS) {
    assert.equal(intent[field].provenance, 'default');
    assert.equal(isExplicitConsent(intent[field]), false);
  }
});

test('N01 an unspecified edition is kept unspecified, never substituted', () => {
  const intent = createCampaignIntent({ ruleset: { value: { id: 'open-d6', edition: null }, provenance: 'explicit' } });
  assert.deepEqual(intent.ruleset.value, { id: 'open-d6', edition: null });
});

test('N01 derived values are not consent, only explicit provenance is', () => {
  const intent: CampaignIntent = createCampaignIntent({
    voiceOutput: { value: true, provenance: 'derived' },
    ambience: { value: true, provenance: 'explicit' },
  });
  assert.deepEqual([...PROVENANCES], ['default', 'explicit', 'derived']);
  assert.equal(isExplicitConsent(intent.voiceOutput), false);
  assert.equal(isExplicitConsent(intent.ambience), true);
});

test('N01 malformed input yields structured errors with code and path', () => {
  assert.deepEqual(issueOf('nope'), [{ code: 'invalid_type', path: '' }]);
  assert.deepEqual(issueOf({ flavour: {} }), [{ code: 'unknown_field', path: 'flavour' }]);
  assert.deepEqual(issueOf({ genre: 'noir' }), [{ code: 'invalid_type', path: 'genre' }]);
  assert.deepEqual(issueOf({ genre: { value: 'noir', provenance: 'guess' } }), [
    { code: 'invalid_provenance', path: 'genre.provenance' },
  ]);
  assert.deepEqual(issueOf({ pacing: { value: 'warp', provenance: 'explicit' } }), [
    { code: 'invalid_value', path: 'pacing.value' },
  ]);
  assert.deepEqual(issueOf({ ruleset: { value: { id: '', edition: null }, provenance: 'explicit' } }), [
    { code: 'invalid_value', path: 'ruleset.value' },
  ]);
});

test('N01 parse fills defaults for valid partial input', () => {
  const result = parseCampaignIntent({ mood: { value: 'cozy', provenance: 'explicit' } });
  assert.ok(result.ok);
  assert.equal(result.intent.mood.value, 'cozy');
  assert.equal(result.intent.timeline.provenance, 'default');
});

test('N01 inherited and special keys are unknown fields, not crashes', () => {
  assert.deepEqual(issueOf({ toString: { value: 1, provenance: 'explicit' } }), [
    { code: 'unknown_field', path: 'toString' },
  ]);
  assert.deepEqual(issueOf(JSON.parse('{"__proto__":{"value":1,"provenance":"explicit"}}')), [
    { code: 'unknown_field', path: '__proto__' },
  ]);
  assert.deepEqual(issueOf({ constructor: 'x' }), [{ code: 'unknown_field', path: 'constructor' }]);
});

test('N01 unknown nested keys are rejected', () => {
  assert.deepEqual(issueOf({ genre: { value: 'noir', provenance: 'explicit', evil: 1 } }), [
    { code: 'unknown_field', path: 'genre.evil' },
  ]);
  assert.deepEqual(issueOf({ ruleset: { value: { id: 'a', edition: null, evil: 1 }, provenance: 'explicit' } }), [
    { code: 'unknown_field', path: 'ruleset.value.evil' },
  ]);
});

test('N01 parse result shares no references with the input', () => {
  const input = {
    ruleset: { value: { id: 'a', edition: null }, provenance: 'explicit' },
    houseRules: { value: ['x'], provenance: 'explicit' },
  };
  const result = parseCampaignIntent(input);
  assert.ok(result.ok);
  assert.notEqual(result.intent.ruleset, input.ruleset);
  assert.notEqual(result.intent.ruleset.value, input.ruleset.value);
  assert.notEqual(result.intent.houseRules, input.houseRules);
  assert.notEqual(result.intent.houseRules.value, input.houseRules.value);
  assert.deepEqual(result.intent.houseRules.value, ['x']);
});

test('N01 arrays with holes are rejected', () => {
  const sparse = new Array<string>(2);
  sparse[1] = 'a';
  assert.deepEqual(issueOf({ houseRules: { value: sparse, provenance: 'explicit' } }), [
    { code: 'invalid_value', path: 'houseRules.value' },
  ]);
});

test('N01 sparse arrays with an extra property are rejected', () => {
  const sparse = new Array<string>(2) as string[] & { extra?: string };
  sparse[1] = 'a';
  sparse.extra = 'b';
  assert.deepEqual(issueOf({ houseRules: { value: sparse, provenance: 'explicit' } }), [
    { code: 'invalid_value', path: 'houseRules.value' },
  ]);
});

test('N01 only plain objects are accepted as records', () => {
  assert.deepEqual(issueOf(new Date()), [{ code: 'invalid_type', path: '' }]);
  assert.deepEqual(issueOf(new Map()), [{ code: 'invalid_type', path: '' }]);
  assert.deepEqual(issueOf(new (class Foo {})()), [{ code: 'invalid_type', path: '' }]);
  assert.deepEqual(issueOf({ genre: new Date() }), [{ code: 'invalid_type', path: 'genre' }]);
  assert.ok(parseCampaignIntent(Object.create(null)).ok);
});

test('N01 default provenance must carry the fallback value', () => {
  assert.deepEqual(issueOf({ voiceOutput: { value: true, provenance: 'default' } }), [
    { code: 'invalid_value', path: 'voiceOutput.value' },
  ]);
  assert.ok(parseCampaignIntent({ voiceOutput: { value: false, provenance: 'default' } }).ok);
});
