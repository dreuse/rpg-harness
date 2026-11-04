import { parseRuleDsl, type RuleDsl } from '../../rules/src/dsl.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import type { Provenance } from './provenance.ts';
import { type ImportedData, interpretImported, type UntrustedContent } from './untrusted.ts';

export const MIN_CONFIDENCE = 0.7;
const MAX_CONFIDENCE = 1;
const NO_CONFIDENCE = 0;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

export const FLAG_REASONS = [
  'no_evidence',
  'low_confidence',
  'invalid_rule',
  'invalid_output',
  'interpreter_failed',
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

export type Interpreter = (clause: ImportedData) => Promise<unknown>;

export type DraftMechanic = {
  readonly status: 'draft';
  readonly flagged: boolean;
  readonly reasons: readonly FlagReason[];
  readonly provenance: Provenance;
  readonly sourceText: string;
  readonly confidence: number;
  readonly evidence: string;
  readonly rule?: RuleDsl;
};

const isConfidence = (value: unknown): value is number =>
  typeof value === 'number' && value >= NO_CONFIDENCE && value <= MAX_CONFIDENCE;

function assess(text: string, output: unknown) {
  if (!isRecord(output)) return { confidence: NO_CONFIDENCE, evidence: '', reasons: ['invalid_output' as const] };
  const evidence = typeof output.evidence === 'string' ? output.evidence : '';
  const confidence = isConfidence(output.confidence) ? output.confidence : NO_CONFIDENCE;
  const parsed = parseRuleDsl(output.rule);
  const reasons: FlagReason[] = [
    ...(WORD_CHARACTER.test(evidence) && text.includes(evidence) ? [] : ['no_evidence' as const]),
    ...(confidence >= MIN_CONFIDENCE ? [] : ['low_confidence' as const]),
    ...(parsed.ok ? [] : ['invalid_rule' as const]),
  ];
  return { confidence, evidence, reasons, ...(parsed.ok && !reasons.length && { rule: parsed.rule }) };
}

async function interpretClause(clause: UntrustedContent, interpret: Interpreter): Promise<DraftMechanic> {
  const data = interpretImported(clause);
  const base = { status: 'draft' as const, provenance: data.provenance, sourceText: data.text };
  try {
    const assessed = assess(data.text, await interpret(data));
    return { ...base, flagged: assessed.reasons.length > 0, ...assessed };
  } catch {
    return { ...base, flagged: true, reasons: ['interpreter_failed'], confidence: NO_CONFIDENCE, evidence: '' };
  }
}

export const interpretClauses = (clauses: readonly UntrustedContent[], interpret: Interpreter) =>
  Promise.all(clauses.map((clause) => interpretClause(clause, interpret)));
