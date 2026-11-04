import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { RULEPACK_CONTRACT_VERSION, type RulePackManifest } from '../../rules/src/rulepack.ts';
import type { RawPage } from './extraction.ts';
import type { Interpreter } from './interpretation.ts';
import { type ImportOutcome, type ImportWorkflowInput, runImportConversation } from './workflow.ts';

const HIGH_CONFIDENCE = 0.9;
const LOW_CONFIDENCE = 0.2;
const FOCUS_CLAUSE = 'Spend 1 focus to reroll.';
const VAGUE_CLAUSE = 'The moon decides everything.';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 scanned');
const GIF_BYTES = new TextEncoder().encode('GIF89a');
const READ_FAILURE = 'no pdf reader';

const pack = (id: string, capabilities: RulePackManifest['capabilities']): RulePackManifest => ({
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id,
  edition: 'first',
  revision: '3',
  capabilities,
  sourceRefs: [],
});

const PACKS = [pack('focus-pack', { resourceCost: true, effects: true }), pack('bare-pack', {})];

const focusRule: RuleDsl = {
  dslVersion: RULE_DSL_VERSION,
  id: 'focus-reroll',
  costs: [{ kind: 'cost', resource: 'focus', amount: { kind: 'const', value: 1 } }],
  effects: [{ kind: 'emitEvent', event: 'check.rerolled' }],
};

const text = (value: string) => new TextEncoder().encode(value);

const readPages = (bytes: Uint8Array): RawPage[] => {
  if (bytes[0] === PDF_BYTES[0]) throw new Error(READ_FAILURE);
  const paragraphs = new TextDecoder().decode(bytes).split('\n\n').filter(Boolean);
  return [{ page: 1, blocks: paragraphs.map((paragraph) => ({ type: 'text', text: paragraph, quality: 'high' })) }];
};

const interpret: Interpreter = async ({ text: clause }) =>
  clause.includes('focus')
    ? { rule: focusRule, confidence: HIGH_CONFIDENCE, evidence: 'Spend 1 focus' }
    : { confidence: LOW_CONFIDENCE, evidence: '' };

const input = (files: ImportWorkflowInput['files']): ImportWorkflowInput => ({
  files,
  packs: PACKS,
  extract: { readPages },
  interpret,
});

const converse = async (files: ImportWorkflowInput['files'], replies: readonly string[]) => {
  const conversation = runImportConversation(
    input(files),
    (async function* () {
      yield* replies;
    })(),
  );
  const transcript: string[] = [];
  for (;;) {
    const step = await conversation.next();
    if (step.done) return { outcome: step.value as ImportOutcome, transcript: transcript.join('\n') };
    transcript.push(step.value);
  }
};

test('import files, preview rules, change mechanics and select effective ruleset using conversation', async () => {
  const { outcome, transcript } = await converse(
    [{ fileName: 'rules.md', bytes: text(FOCUS_CLAUSE) }],
    ['use focus-pack', 'set focus-reroll costs.0.amount.value=2', 'activate'],
  );
  assert.match(transcript, /focus-pack/);
  assert.match(transcript, /bare-pack/);
  assert.match(transcript, /focus-reroll costs\.0\.amount\.value=1/);
  assert.match(transcript, /focus-reroll costs\.0\.amount\.value=2/);
  assert.equal(outcome.status, 'activated');
  assert.ok(outcome.status === 'activated');
  assert.deepEqual(outcome.rulePack, { id: 'focus-pack', edition: 'first', revision: '3' });
  const [compiled] = outcome.rules;
  assert.deepEqual(compiled?.rule.costs?.[0]?.amount, { kind: 'const', value: 2 });
  assert.deepEqual(compiled?.rulePack, outcome.rulePack);
  assert.equal(compiled?.sourceRefs.length, 1);
  assert.deepEqual(outcome.edits, [{ ruleId: 'focus-reroll', field: 'costs.0.amount.value', from: 1, to: 2 }]);
  assert.deepEqual(outcome.gaps, []);
});

test('user does not need to write schema by hand', async () => {
  const { outcome, transcript } = await converse(
    [{ fileName: 'rules.md', bytes: text(FOCUS_CLAUSE) }],
    [
      'activate',
      'use missing-pack',
      'use focus-pack',
      'set focus-reroll costs.0.amount.value=lots',
      'set focus-reroll __proto__.polluted=1',
      'set focus-reroll kind=adjustResource',
      'set unknown-rule costs.0.amount.value=2',
      'set focus-reroll costs.0.amount.value to 3',
      'set focus-reroll effects.0.event=check.boosted',
      'activate',
    ],
  );
  assert.match(transcript, /Choose a rule pack first/);
  assert.match(transcript, /No rule pack named missing-pack/);
  assert.match(transcript, /must be a number/);
  assert.match(transcript, /No field __proto__\.polluted/);
  assert.match(transcript, /No field kind/);
  assert.match(transcript, /No rule named unknown-rule/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(outcome.status === 'activated');
  const [compiled] = outcome.rules;
  assert.deepEqual(compiled?.rule.costs?.[0]?.amount, { kind: 'const', value: 3 });
  assert.deepEqual(compiled?.rule.effects, [{ kind: 'emitEvent', event: 'check.boosted' }]);
  assert.deepEqual(
    outcome.edits.map(({ field, to }) => [field, to]),
    [
      ['costs.0.amount.value', 3],
      ['effects.0.event', 'check.boosted'],
    ],
  );
});

test('an edit the rules engine rejects keeps the previous mechanic', async () => {
  const { outcome, transcript } = await converse(
    [{ fileName: 'rules.md', bytes: text(FOCUS_CLAUSE) }],
    ['use focus-pack', 'set focus-reroll costs.0.resource=not valid', 'activate'],
  );
  assert.match(transcript, /costs\.0\.resource must be an identifier/);
  assert.ok(outcome.status === 'activated');
  assert.equal(outcome.rules[0]?.rule.costs?.[0]?.resource, 'focus');
  assert.deepEqual(outcome.edits, []);
});

test('import never silently completes with gaps', async () => {
  const { outcome, transcript } = await converse(
    [
      { fileName: 'rules.md', bytes: text(`${FOCUS_CLAUSE}\n\n${VAGUE_CLAUSE}`) },
      { fileName: 'art.gif', bytes: GIF_BYTES },
      { fileName: 'scan.pdf', bytes: PDF_BYTES },
      { fileName: 'empty.txt', bytes: text('') },
    ],
    ['use focus-pack', 'activate', 'use bare-pack', 'activate'],
  );
  assert.equal(outcome.status, 'incomplete');
  assert.deepEqual(
    outcome.gaps.map(({ kind, source }) => [kind, source]),
    [
      ['stage_failed', 'art.gif'],
      ['extraction_failed', 'scan.pdf'],
      ['no_content', 'empty.txt'],
      ['unsupported_mechanic', 'rules.md p.1'],
      ['unsupported_mechanic', 'rules.md p.1'],
    ],
  );
  assert.match(transcript, /art\.gif/);
  assert.match(transcript, /scan\.pdf/);
  assert.match(transcript, /empty\.txt/);
  assert.match(transcript, /Activation refused/);
  assert.match(transcript, /Import not completed/);
  assert.doesNotMatch(transcript, /Activated/);
});

test('declining ends the import without activating any rules', async () => {
  const { outcome } = await converse([{ fileName: 'rules.md', bytes: text(FOCUS_CLAUSE) }], ['decline']);
  assert.deepEqual(outcome, { status: 'declined', edits: [], gaps: [] });
});
