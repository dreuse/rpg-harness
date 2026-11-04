import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from '../../rules/src/rulepack.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import { reviewSources, type SourceClaim } from './ambiguity.ts';
import { compileDrafts, type MechanicDraft } from './compile-drafts.ts';
import { decideActivation, previewImport, type SourceExample } from './preview.ts';
import { makeProvenance } from './provenance.ts';

const HIGH_CONFIDENCE = 0.9;
const SEED = 7;
const FOCUS_START = 3;
const FOCUS_MAX = 5;
const FOCUS_AFTER = 2;
const WRONG_FOCUS = 4;
const EDITION = 'lite';

const provenance = makeProvenance({
  sourceHash: 'e'.repeat(64),
  fileName: 'rules.md',
  format: 'markdown',
  locator: { kind: 'known', page: 4 },
  quality: 'high',
});

const rulePack: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'pack',
  edition: EDITION,
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

const sheet = (): TraitSheet => ({
  characterId: 'hero' as TraitSheet['characterId'],
  traits: [{ id: 'focus', kind: 'resource', current: FOCUS_START, max: FOCUS_MAX }],
});

const example = (ruleId: string, focus: number): SourceExample => ({
  ruleId,
  provenance,
  actionId: 'example-1',
  sheet: sheet(),
  seed: SEED,
  expected: { ok: true, changes: [{ id: 'focus', from: FOCUS_START, to: focus }], events: ['check.rerolled'] },
});

const claim = (definition: string): SourceClaim => ({
  term: 'focus',
  definition,
  edition: EDITION,
  kind: 'core',
  provenance,
});

const review = { knownEditions: [EDITION], claims: [claim('A pool of effort.')] };

test('generate import summary, executable coverage report and source-backed tests', () => {
  const compilation = compileDrafts([draft()], rulePack, []);
  const preview = previewImport({
    rulePack,
    compilation,
    review: reviewSources(review),
    examples: [example('focus-reroll', FOCUS_AFTER)],
  });
  assert.deepEqual(preview.summary, {
    rulePack: { id: 'pack', edition: EDITION, revision: '2' },
    sourceHashes: [provenance.sourceHash],
    executable: 1,
    plugins: 0,
    unsupported: 0,
    findings: 0,
    testsPassed: 1,
    testsFailed: 0,
    mismatchedRulePack: 0,
    materialUnresolved: false,
  });
  assert.deepEqual(preview.coverage, [
    { status: 'executable', ruleId: 'focus-reroll', deterministic: true, provenance },
  ]);
  assert.deepEqual(
    preview.tests.map(({ ruleId, status, provenance: cited }) => [ruleId, status, cited]),
    [['focus-reroll', 'passed', provenance]],
  );
  const decision = decideActivation(preview, 'activate');
  assert.equal(decision.activated, true);
  assert.deepEqual(decision.activated && decision.rulePack, preview.summary.rulePack);
  assert.deepEqual(decision.activated && decision.rules, [compilation.compiled[0]?.rule]);
});

test('player can decline activation when material mechanics remain unresolved', () => {
  const compilation = compileDrafts(
    [draft(), draft({ kind: 'token', rule: rule('token-move') }), draft({ rule: rule('second') })],
    { ...rulePack, capabilities: { effects: true } },
    [],
  );
  const preview = previewImport({
    rulePack,
    compilation,
    review: reviewSources({ ...review, claims: [claim('A pool.'), claim('A stat.')] }),
    examples: [example('focus-reroll', WRONG_FOCUS)],
  });
  assert.equal(preview.summary.materialUnresolved, true);
  assert.deepEqual(
    preview.coverage.map((entry) => [entry.status, entry.status === 'unsupported' && entry.reason]),
    [
      ['unsupported', 'compile_failed'],
      ['unsupported', 'needs_plugin'],
      ['unsupported', 'compile_failed'],
    ],
  );
  assert.ok(preview.coverage.every((entry) => entry.provenance === provenance));
  assert.deepEqual(
    preview.tests.map(({ status }) => status),
    ['not_executable'],
  );
  const before = structuredClone(preview);
  assert.deepEqual(decideActivation(preview, 'decline'), { activated: false, failure: 'rejected_by_user' });
  assert.deepEqual(decideActivation(preview, 'activate'), {
    activated: false,
    failure: 'validation_failed',
    unresolved: { unsupported: 3, findings: 1, testsFailed: 1, mismatchedRulePack: 0 },
  });
  assert.deepEqual(preview, before);
});

test('activation is refused when compiled rules are pinned to a different rule pack revision', () => {
  const preview = previewImport({
    rulePack: { ...rulePack, revision: '3' },
    compilation: compileDrafts([draft()], rulePack, []),
    review: reviewSources(review),
    examples: [],
  });
  assert.equal(preview.summary.materialUnresolved, true);
  assert.deepEqual(decideActivation(preview, 'activate'), {
    activated: false,
    failure: 'validation_failed',
    unresolved: { unsupported: 0, findings: 0, testsFailed: 0, mismatchedRulePack: 1 },
  });
});

test('a source-backed test fails when the compiled mechanic disagrees with the source example', () => {
  const preview = previewImport({
    rulePack,
    compilation: compileDrafts([draft()], rulePack, []),
    review: reviewSources(review),
    examples: [example('focus-reroll', WRONG_FOCUS)],
  });
  assert.deepEqual(
    preview.tests.map(({ status }) => status),
    ['failed'],
  );
  assert.equal(preview.summary.materialUnresolved, true);
});
