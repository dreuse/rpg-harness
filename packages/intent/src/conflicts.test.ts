import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIENT_CAPABILITIES, detectConflicts } from './conflicts.ts';
import { type CampaignIntentInput, createCampaignIntent, type IntentField } from './intent.ts';
import type { CapabilityReport } from './registry.ts';

const NO_MECHANICS: CapabilityReport = { advertised: [], supported: [], unsupported: [] };
const FULL_MECHANICS: CapabilityReport = {
  advertised: ['dice', 'attributes', 'combat'],
  supported: [],
  unsupported: [],
};

const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });
const derived = <T>(value: T) => ({ value, provenance: 'derived' as const });
const summary = (input: CampaignIntentInput, rules: CapabilityReport) =>
  detectConflicts(createCampaignIntent(input), rules).map(({ code, severity, entries }) => ({
    code,
    severity,
    fields: entries.map((entry) => entry.field),
  }));
const conflict = (code: string, ...fields: IntentField[]) => ({ code, severity: 'conflict', fields });
const info = (code: string, ...fields: IntentField[]) => ({ code, severity: 'info', fields });

test('N05 explain requested combinations that are unsupported by active rules or ui', () => {
  assert.deepEqual(summary({}, NO_MECHANICS), []);
  assert.deepEqual(
    summary(
      {
        dice: explicit('on'),
        attributes: explicit('on'),
        combat: explicit('on'),
        diceVisualization: explicit(true),
        voiceInput: explicit(true),
        voiceOutput: explicit(true),
        ambience: explicit(true),
      },
      NO_MECHANICS,
    ),
    [
      conflict('rulepack_unsupported', 'dice'),
      conflict('rulepack_unsupported', 'attributes'),
      conflict('rulepack_unsupported', 'combat'),
      conflict('requires_dice', 'diceVisualization', 'dice'),
      conflict('client_unsupported', 'voiceInput', 'client'),
      conflict('client_unsupported', 'voiceOutput', 'client'),
      conflict('client_unsupported', 'ambience', 'client'),
      conflict('client_unsupported', 'diceVisualization', 'client'),
    ],
  );
  assert.deepEqual(
    summary({ dice: explicit('on'), diceVisualization: explicit(true), client: explicit('desktop') }, FULL_MECHANICS),
    [],
  );
  assert.deepEqual(summary({ diceVisualization: explicit(true), client: explicit('tui') }, FULL_MECHANICS), []);

  const [first] = detectConflicts(createCampaignIntent({ voiceOutput: explicit(true) }), NO_MECHANICS);
  assert.deepEqual(first?.entries, [
    { field: 'voiceOutput', value: true, provenance: 'explicit' },
    { field: 'client', value: 'cli', provenance: 'default' },
  ]);
  assert.match(first?.explanation ?? '', /voiceOutput.*cli/);

  assert.deepEqual(summary({ combat: derived('on'), voiceInput: derived(true) }, NO_MECHANICS), [
    info('rulepack_unsupported', 'combat'),
    info('client_unsupported', 'voiceInput', 'client'),
  ]);
  assert.deepEqual(
    detectConflicts(createCampaignIntent({ voiceInput: explicit(true) }), NO_MECHANICS, CLIENT_CAPABILITIES.desktop),
    [],
  );
});

test('N05 voice-disabled or dice-free campaigns cannot be forced into incompatible settings', () => {
  assert.deepEqual(
    summary({ dice: explicit('off'), diceVisualization: explicit(true), client: explicit('desktop') }, FULL_MECHANICS),
    [conflict('requires_dice', 'diceVisualization', 'dice')],
  );
  assert.deepEqual(summary({ diceVisualization: explicit(true), client: explicit('desktop') }, NO_MECHANICS), [
    conflict('requires_dice', 'diceVisualization', 'dice'),
  ]);
  assert.deepEqual(
    summary({ dice: explicit('off'), diceVisualization: derived(true), client: explicit('desktop') }, FULL_MECHANICS),
    [info('requires_dice', 'diceVisualization', 'dice')],
  );
  assert.deepEqual(
    summary(
      {
        client: explicit('tui'),
        voiceInput: explicit(true),
        voiceOutput: explicit(true),
        ambience: explicit(true),
        diceVisualization: explicit(true),
        dice: explicit('on'),
      },
      FULL_MECHANICS,
    ),
    [
      conflict('client_unsupported', 'voiceInput', 'client'),
      conflict('client_unsupported', 'voiceOutput', 'client'),
      conflict('client_unsupported', 'ambience', 'client'),
    ],
  );
});
