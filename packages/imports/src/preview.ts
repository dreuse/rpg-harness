import { isDeepStrictEqual } from 'node:util';
import { runCompiledRule } from '../../rules/src/compile.ts';
import type { CompiledRule } from '../../rules/src/dsl.ts';
import type { ActionResolution, ResolutionErrorCode, TraitChange } from '../../rules/src/resolve.ts';
import type { RulePackManifest } from '../../rules/src/rulepack.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import type { SourceReview } from './ambiguity.ts';
import type { DraftCompilation, UnsupportedMechanic } from './compile-drafts.ts';
import type { FailureKind } from './journey.ts';
import type { Provenance } from './provenance.ts';

export type SourceExample = {
  readonly ruleId: string;
  readonly provenance: Provenance;
  readonly actionId: string;
  readonly sheet: TraitSheet;
  readonly seed: number;
  readonly expected:
    | { readonly ok: true; readonly changes: readonly TraitChange[]; readonly events: readonly string[] }
    | { readonly ok: false; readonly errorCode: ResolutionErrorCode };
};

export type CoverageEntry =
  | { status: 'executable'; ruleId: string; deterministic: boolean; provenance: Provenance }
  | { status: 'plugin'; pluginId: string; provenance: Provenance }
  | {
      status: 'unsupported';
      reason: UnsupportedMechanic['reason'];
      error?: UnsupportedMechanic['error'];
      provenance: Provenance;
    };

export type SourceTestStatus = 'passed' | 'failed' | 'not_executable';
export type SourceTest = {
  ruleId: string;
  provenance: Provenance;
  status: SourceTestStatus;
  actual?: ActionResolution;
};

export type RulePackRef = CompiledRule['rulePack'];
export type ImportSummary = {
  rulePack: RulePackRef;
  sourceHashes: string[];
  executable: number;
  plugins: number;
  unsupported: number;
  findings: number;
  testsPassed: number;
  testsFailed: number;
  mismatchedRulePack: number;
  materialUnresolved: boolean;
};

export type ImportPreview = {
  summary: ImportSummary;
  coverage: CoverageEntry[];
  tests: SourceTest[];
  rules: CompiledRule[];
};

export type PreviewInput = {
  readonly rulePack: RulePackManifest;
  readonly compilation: DraftCompilation;
  readonly review: SourceReview;
  readonly examples: readonly SourceExample[];
};

export type ActivationChoice = 'activate' | 'decline';
export type ActivationDecision =
  | { activated: true; rulePack: RulePackRef; rules: CompiledRule[] }
  | { activated: false; failure: Extract<FailureKind, 'rejected_by_user'> }
  | {
      activated: false;
      failure: Extract<FailureKind, 'validation_failed'>;
      unresolved: { unsupported: number; findings: number; testsFailed: number; mismatchedRulePack: number };
    };

const matches = (expected: SourceExample['expected'], actual: ActionResolution) =>
  expected.ok
    ? actual.ok &&
      isDeepStrictEqual(actual.changes, expected.changes) &&
      isDeepStrictEqual(
        actual.events.map(({ event }) => event),
        expected.events,
      )
    : !actual.ok && actual.error.code === expected.errorCode;

function runExample(rules: readonly CompiledRule[], example: SourceExample): SourceTest {
  const { ruleId, provenance, actionId, sheet, seed, expected } = example;
  const compiled = rules.find((candidate) => candidate.rule.id === ruleId);
  if (!compiled) return { ruleId, provenance, status: 'not_executable' };
  const actual = runCompiledRule(compiled, { actionId, sheet, seed });
  return { ruleId, provenance, status: matches(expected, actual) ? 'passed' : 'failed', actual };
}

export function previewImport({ rulePack, compilation, review, examples }: PreviewInput): ImportPreview {
  const rules = compilation.compiled.map(({ rule }) => rule);
  const coverage: CoverageEntry[] = [
    ...compilation.compiled.map(({ rule, draft }) => ({
      status: 'executable' as const,
      ruleId: rule.rule.id,
      deterministic: rule.deterministic,
      provenance: draft.provenance,
    })),
    ...compilation.plugins.map(({ pluginId, draft }) => ({
      status: 'plugin' as const,
      pluginId,
      provenance: draft.provenance,
    })),
    ...compilation.unsupported.map(({ reason, error, draft }) => ({
      status: 'unsupported' as const,
      reason,
      ...(error && { error }),
      provenance: draft.provenance,
    })),
  ];
  const tests = examples.map((example) => runExample(rules, example));
  const testsPassed = tests.filter(({ status }) => status === 'passed').length;
  const testsFailed = tests.length - testsPassed;
  const unsupported = compilation.unsupported.length;
  const findings = review.findings.length;
  const pinned = { id: rulePack.id, edition: rulePack.edition, revision: rulePack.revision };
  const mismatchedRulePack = rules.filter((rule) => !isDeepStrictEqual(rule.rulePack, pinned)).length;
  const summary: ImportSummary = {
    rulePack: pinned,
    sourceHashes: [...new Set(coverage.map(({ provenance }) => provenance.sourceHash))],
    executable: rules.length,
    plugins: compilation.plugins.length,
    unsupported,
    findings,
    testsPassed,
    testsFailed,
    mismatchedRulePack,
    materialUnresolved: unsupported > 0 || findings > 0 || testsFailed > 0 || mismatchedRulePack > 0,
  };
  return { summary, coverage, tests, rules };
}

export function decideActivation({ summary, rules }: ImportPreview, choice: ActivationChoice): ActivationDecision {
  if (choice === 'decline') return { activated: false, failure: 'rejected_by_user' };
  const { unsupported, findings, testsFailed, mismatchedRulePack, materialUnresolved, rulePack } = summary;
  if (materialUnresolved) {
    return {
      activated: false,
      failure: 'validation_failed',
      unresolved: { unsupported, findings, testsFailed, mismatchedRulePack },
    };
  }
  return { activated: true, rulePack, rules: [...rules] };
}
