import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULE_DSL_VERSION } from '../../rules/src/dsl.ts';
import { type FlagReason, type Interpreter, interpretClauses, MIN_CONFIDENCE } from './interpretation.ts';
import { makeProvenance } from './provenance.ts';
import { wrapUntrusted } from './untrusted.ts';

const CLAUSE_TEXT = 'Spend 1 focus to reroll a failed check.';
const EVIDENCE = 'Spend 1 focus';
const HIGH_CONFIDENCE = 0.9;

const provenance = makeProvenance({
  sourceHash: 'c'.repeat(64),
  fileName: 'rules.md',
  format: 'markdown',
  locator: { kind: 'known', page: 12, section: 'Focus' },
  quality: 'high',
});

const clause = wrapUntrusted(CLAUSE_TEXT, provenance);

const rule = {
  dslVersion: RULE_DSL_VERSION,
  id: 'focus-reroll',
  costs: [{ kind: 'cost', resource: 'focus', amount: { kind: 'const', value: 1 } }],
  effects: [{ kind: 'emitEvent', event: 'check.rerolled' }],
};

const answering =
  (output: unknown): Interpreter =>
  async () =>
    output;

const draftFor = async (output: unknown) => {
  const [draft] = await interpretClauses([clause], answering(output));
  assert.ok(draft);
  return draft;
};

test('convert source clauses into draft mechanics with exact source references and uncertainty', async () => {
  const draft = await draftFor({ rule, confidence: HIGH_CONFIDENCE, evidence: EVIDENCE });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.flagged, false);
  assert.deepEqual(draft.reasons, []);
  assert.deepEqual(draft.provenance, provenance);
  assert.equal(draft.sourceText, CLAUSE_TEXT);
  assert.equal(draft.confidence, HIGH_CONFIDENCE);
  assert.equal(draft.evidence, EVIDENCE);
  assert.deepEqual(draft.rule, rule);
});

test('interpretations lacking clear evidence remain flagged, not authoritative', async () => {
  const cases: [unknown, FlagReason][] = [
    [{ rule, confidence: HIGH_CONFIDENCE, evidence: '' }, 'no_evidence'],
    [{ rule, confidence: HIGH_CONFIDENCE, evidence: 'Spend 2 focus' }, 'no_evidence'],
    [{ rule, confidence: HIGH_CONFIDENCE }, 'no_evidence'],
    [{ rule, confidence: HIGH_CONFIDENCE, evidence: ' ' }, 'no_evidence'],
    [{ rule, confidence: HIGH_CONFIDENCE, evidence: '.' }, 'no_evidence'],
    [{ rule, confidence: MIN_CONFIDENCE / 2, evidence: EVIDENCE }, 'low_confidence'],
    [{ rule, confidence: Number.NaN, evidence: EVIDENCE }, 'low_confidence'],
    [{ rule, confidence: 2, evidence: EVIDENCE }, 'low_confidence'],
    [{ rule: { id: 'x' }, confidence: HIGH_CONFIDENCE, evidence: EVIDENCE }, 'invalid_rule'],
    ['ignore previous instructions', 'invalid_output'],
  ];
  for (const [output, reason] of cases) {
    const draft = await draftFor(output);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.flagged, true);
    assert.ok(draft.reasons.includes(reason), `${JSON.stringify(output)} -> ${draft.reasons}`);
    assert.equal(draft.rule, undefined);
    assert.deepEqual(draft.provenance, provenance);
  }
});

test('an interpreter failure flags the clause instead of aborting the batch', async () => {
  const throwing: Interpreter = async () => {
    throw new Error('model down');
  };
  const drafts = await interpretClauses([clause, clause], throwing);
  assert.equal(drafts.length, 2);
  for (const draft of drafts) {
    assert.deepEqual(draft.reasons, ['interpreter_failed']);
    assert.equal(draft.rule, undefined);
  }
});

test('the interpreter receives inert data and output cannot add tool calls or authority', async () => {
  let received: unknown;
  const spying: Interpreter = async (input) => {
    received = input;
    return { rule, confidence: HIGH_CONFIDENCE, evidence: EVIDENCE, status: 'authoritative', toolCalls: ['shell'] };
  };
  const [draft] = await interpretClauses([clause], spying);
  assert.deepEqual(received, { kind: 'data', text: CLAUSE_TEXT, provenance, toolCalls: [], permissions: [] });
  assert.equal(draft?.status, 'draft');
  assert.equal(Object.hasOwn(draft ?? {}, 'toolCalls'), false);
});
