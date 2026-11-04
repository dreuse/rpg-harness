import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from '../../rules/src/rulepack.ts';
import { type ApprovedPlugin, compileDrafts, type MechanicDraft } from './compile-drafts.ts';
import { makeProvenance } from './provenance.ts';

const HIGH_CONFIDENCE = 0.9;

const provenance = makeProvenance({
  sourceHash: 'd'.repeat(64),
  fileName: 'rules.md',
  format: 'markdown',
  locator: { kind: 'known', page: 3 },
  quality: 'high',
});

const rulePack: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'pack',
  edition: 'lite',
  revision: '2',
  capabilities: { resourceCost: true, effects: true },
  sourceRefs: [],
};

const rule = (id: string): RuleDsl => ({
  dslVersion: RULE_DSL_VERSION,
  id,
  costs: [{ kind: 'cost', resource: 'focus', amount: { kind: 'const', value: 1 } }],
  effects: [{ kind: 'emitEvent', event: 'check.rerolled' }],
});

const draft = (overrides: Partial<MechanicDraft> = {}): MechanicDraft => ({
  status: 'draft',
  flagged: false,
  reasons: [],
  provenance,
  sourceText: 'Spend 1 focus to reroll.',
  confidence: HIGH_CONFIDENCE,
  evidence: 'Spend 1 focus',
  rule: rule('focus-reroll'),
  ...overrides,
});

test('compile drafts into rules that keep rule pack version and source provenance', () => {
  const result = compileDrafts([draft()], rulePack, []);
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.compiled.length, 1);
  const [entry] = result.compiled;
  assert.deepEqual(entry?.rule.rulePack, { id: 'pack', edition: 'lite', revision: '2' });
  assert.deepEqual(entry?.rule.sourceRefs, [provenance.sourceHash]);
  assert.equal(entry?.draft.provenance, provenance);
});

test('unsupported card/token/custom mechanics are explicitly flagged or provided by approved plugins', () => {
  const plugins: ApprovedPlugin[] = [{ id: 'deck-plugin', kinds: ['card'] }];
  const card = draft({ kind: 'card' });
  const flaggedCard = draft({ kind: 'card', flagged: true, reasons: ['invalid_rule'] });
  const token = draft({ kind: 'token', rule: rule('token-move') });
  const custom = draft({ kind: 'custom' });
  const flagged = draft({ flagged: true, reasons: ['low_confidence'] });
  const { rule: _rule, ...missing } = draft();
  const disabled = draft();
  const result = compileDrafts(
    [card, flaggedCard, token, custom, flagged, missing, disabled],
    { ...rulePack, capabilities: { effects: true } },
    plugins,
  );
  assert.deepEqual(result.compiled, []);
  assert.deepEqual(result.plugins, [{ pluginId: 'deck-plugin', draft: card }]);
  assert.deepEqual(
    result.unsupported.map(({ reason, draft }) => [reason, draft]),
    [
      ['flagged', flaggedCard],
      ['needs_plugin', token],
      ['needs_plugin', custom],
      ['flagged', flagged],
      ['missing_rule', missing],
      ['compile_failed', disabled],
    ],
  );
  assert.equal(result.unsupported.at(-1)?.error?.code, 'CapabilityDisabled');
  assert.ok(result.unsupported.every((entry) => entry.draft.provenance === provenance));
});
