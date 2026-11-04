import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CampaignConfig, generateCampaignConfig, parseCampaignConfig } from './config.ts';
import { type CampaignIntentInput, createCampaignIntent, type IntentField } from './intent.ts';
import type { Registry } from './registry.ts';
import { CAMPAIGN_CONFIG_CHANGED, changeSettings, type SettingsChangeResult } from './settings-change.ts';

const RULESET_ID = 'fantasy-core';
const FULL_EDITION = '2e';
const BARE_EDITION = '3e';

const REGISTRY: Registry = {
  rulepacks: [
    {
      id: RULESET_ID,
      edition: FULL_EDITION,
      revision: '1.2.0',
      capabilities: { dice: true, combat: 'adjudicated' },
      sourceRefs: ['srd:core'],
    },
    { id: RULESET_ID, edition: BARE_EDITION, revision: '0.1.0', capabilities: {}, sourceRefs: [] },
  ],
  genres: [],
};

const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });

const configFor = (edition: string, client: 'cli' | 'desktop', extra: CampaignIntentInput = {}): CampaignConfig => {
  const combat = edition === FULL_EDITION ? { combat: explicit('on' as const) } : {};
  const intent = createCampaignIntent({
    ruleset: explicit({ id: RULESET_ID, edition }),
    client: explicit(client),
    ...combat,
    ...extra,
  });
  const result = generateCampaignConfig(intent, REGISTRY);
  assert.ok(result.ok);
  return result.config;
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
};

const changed = (result: SettingsChangeResult) => {
  assert.ok(result.ok);
  return result;
};

const assertChanged = (text: string, field: IntentField, value: unknown, startOn = false) => {
  const previous = configFor(FULL_EDITION, 'desktop', startOn ? { [field]: explicit(true) } : {});
  const { config, event } = changed(changeSettings(previous, text));
  assert.deepEqual(config.values[field], value);
  assert.equal(config.provenance[field], 'explicit');
  assert.equal(event.type, CAMPAIGN_CONFIG_CHANGED);
  assert.deepEqual(
    event.payload.changes.map((change) => [change.field, change.from, change.to]),
    [[field, { value: previous.values[field], provenance: previous.provenance[field] }, explicit(value)]],
  );
  assert.deepEqual(parseCampaignConfig(JSON.parse(JSON.stringify(config))), { ok: true, config });
};

test('N08 change simulation setting via dialogue', () => {
  assertChanged("Let's switch to a living world from now on.", 'simulation', true);
});

test('N08 change tone setting via dialogue', () => {
  assertChanged('Change the tone to grim.', 'mood', 'grim');
});

test('N08 change combat frequency setting via dialogue', () => {
  assertChanged('Can we play with no combat for a while?', 'combat', 'off');
});

test('N08 change voice setting via dialogue', () => {
  assertChanged('Please turn on voice narration.', 'voiceOutput', true);
  assertChanged('I want voice input now.', 'voiceInput', true);
});

test('N08 config changes preserve prior events: prior config is not mutated', () => {
  const previous = deepFreeze(configFor(FULL_EDITION, 'desktop'));
  const before = structuredClone(previous);
  const { config, event } = changed(changeSettings(previous, 'No combat, a static world, and make the mood eerie.'));
  assert.deepEqual(previous, before);
  assert.notEqual(config, previous);
  assert.deepEqual(config.rulepack, previous.rulepack);
  assert.deepEqual(config.capabilities.modes.combat, 'off');
  assert.deepEqual(
    event.payload.changes.map((change) => change.field),
    ['combat', 'simulation', 'mood'],
  );
  assert.equal(event.payload.configVersion, previous.configVersion);
});

test('N08 change incompatible with pinned rulepack returns a typed error', () => {
  const previous = deepFreeze(configFor(BARE_EDITION, 'cli'));
  const before = structuredClone(previous);
  assert.deepEqual(changeSettings(previous, 'I want lots of combat.'), {
    ok: false,
    issues: [{ code: 'conflict', path: 'combat' }],
  });
  assert.deepEqual(changeSettings(previous, 'Turn on voice narration.'), {
    ok: false,
    issues: [{ code: 'conflict', path: 'voiceOutput' }],
  });
  assert.deepEqual(previous, before);
});

test('N08 unknown or ambiguous request returns a typed issue', () => {
  const previous = configFor(FULL_EDITION, 'desktop');
  const issues = (raw: unknown, text: unknown) => {
    const result = changeSettings(raw, text);
    assert.ok(!result.ok);
    return result.issues;
  };
  assert.deepEqual(issues(previous, 'Hmm, whatever you think.'), [{ code: 'unrecognized', path: '' }]);
  assert.deepEqual(issues(previous, "Don't make the tone grim."), [{ code: 'unrecognized', path: '' }]);
  assert.deepEqual(issues(previous, 'Lots of combat, actually no combat.'), [{ code: 'ambiguous', path: 'combat' }]);
  assert.deepEqual(issues(previous, 'Use fast pacing.'), [{ code: 'not_changeable', path: 'pacing' }]);
  assert.deepEqual(issues(previous, 'Tactical combat please.'), [{ code: 'unchanged', path: '' }]);
  assert.deepEqual(issues(previous, 42), [{ code: 'invalid_type', path: '' }]);
  assert.deepEqual(issues({}, 'No combat.'), [{ code: 'unsupported_version', path: 'previous.configVersion' }]);
});

test('N08 conflicting tone requests in one message are ambiguous', () => {
  const result = changeSettings(
    configFor(FULL_EDITION, 'desktop'),
    'Make the tone grim, no, set the mood to cheerful.',
  );
  assert.deepEqual(result, { ok: false, issues: [{ code: 'ambiguous', path: 'mood' }] });
});

test('N08 off verbs turn settings off', () => {
  assertChanged('Turn off voice narration.', 'voiceOutput', false, true);
  assertChanged('Disable voice input.', 'voiceInput', false, true);
  assertChanged('Stop the living world.', 'simulation', false, true);
  const previous = configFor(FULL_EDITION, 'desktop');
  const on = changed(changeSettings(previous, 'Turn on voice narration.')).config;
  const { config } = changed(changeSettings(on, 'Set the tone to grim and turn off voice narration.'));
  assert.equal(config.values.mood, 'grim');
  assert.equal(config.values.voiceOutput, false);
  assert.deepEqual(changeSettings(on, "Don't turn off voice narration."), {
    ok: false,
    issues: [{ code: 'ambiguous', path: 'voiceOutput' }],
  });
});

test('N08 tone filler words are not stored as mood', () => {
  const previous = configFor(FULL_EDITION, 'desktop');
  for (const text of ['Change the tone to a darker one.', 'Make the mood not so grim.'])
    assert.deepEqual(changeSettings(previous, text), { ok: false, issues: [{ code: 'ambiguous', path: 'mood' }] });
});

test('N08 off word after the setting turns it off', () => {
  for (const text of [
    'Turn voice narration off.',
    'Switch voice narration off.',
    'Set voice narration to off.',
    'Voice narration off please.',
    'No more voice narration.',
  ])
    assertChanged(text, 'voiceOutput', false, true);
  const silent = configFor(FULL_EDITION, 'desktop', { voiceOutput: explicit(false) });
  assert.deepEqual(changeSettings(silent, 'Turn voice narration off.'), {
    ok: false,
    issues: [{ code: 'unchanged', path: '' }],
  });
  for (const previous of [silent, configFor(FULL_EDITION, 'desktop', { voiceOutput: explicit(true) })])
    assert.deepEqual(changeSettings(previous, 'Turn on voice narration off.'), {
      ok: false,
      issues: [{ code: 'ambiguous', path: 'voiceOutput' }],
    });
});

test('N08 off verb carries across settings joined by and', () => {
  const previous = configFor(FULL_EDITION, 'desktop', { voiceInput: explicit(true), voiceOutput: explicit(true) });
  const both = changed(changeSettings(previous, 'Disable voice input and voice narration.')).config;
  assert.equal(both.values.voiceInput, false);
  assert.equal(both.values.voiceOutput, false);
  const list = changed(changeSettings(previous, 'Turn off combat and voice narration.')).config;
  assert.equal(list.values.voiceOutput, false);
  const split = changed(changeSettings(previous, 'Turn off voice input and add voice narration.')).config;
  assert.equal(split.values.voiceInput, false);
  assert.equal(split.values.voiceOutput, true);
});
