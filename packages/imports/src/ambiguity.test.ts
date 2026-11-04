import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Finding, reviewSources, type SourceClaim } from './ambiguity.ts';
import { makeProvenance } from './provenance.ts';

const KNOWN_EDITIONS = ['1e', '2e'];
const CORE_HASH = 'a'.repeat(64);
const SUPPLEMENT_HASH = 'b'.repeat(64);
const ERRATA_HASH = 'c'.repeat(64);
const AMBIGUOUS_EDITION = '1.9e';
const TERM = 'Focus';

const provenanceFor = (sourceHash: string, fileName: string) =>
  makeProvenance({
    sourceHash,
    fileName,
    format: 'markdown',
    locator: { kind: 'known', section: TERM },
    quality: 'high',
  });

const core = provenanceFor(CORE_HASH, 'core.md');
const supplement = provenanceFor(SUPPLEMENT_HASH, 'supplement.md');
const errata = provenanceFor(ERRATA_HASH, 'errata.md');

const claim = (overrides: Partial<SourceClaim> & Pick<SourceClaim, 'provenance'>): SourceClaim => ({
  term: TERM,
  definition: 'Spend 1 focus to reroll.',
  edition: '1e',
  kind: 'core',
  ...overrides,
});

const findingOf = <K extends Finding['kind']>(findings: readonly Finding[], kind: K) => {
  const found = findings.find((finding) => finding.kind === kind);
  assert.ok(found, `missing ${kind}`);
  return found as Extract<Finding, { kind: K }>;
};

test('report unknown editions, competing definitions, errata conflicts and suggested decisions', () => {
  const review = reviewSources({
    knownEditions: KNOWN_EDITIONS,
    claims: [
      claim({ provenance: core }),
      claim({ provenance: supplement, term: ' focus ', definition: 'Spend 2 focus to reroll.' }),
      claim({ provenance: errata, kind: 'errata', definition: 'Spend 1 focus to reroll once per scene.' }),
      claim({ provenance: supplement, term: 'Grit', edition: null }),
    ],
  });

  assert.equal(review.resolved, false);

  const unknown = findingOf(review.findings, 'unknown_edition');
  assert.equal(unknown.edition, null);
  assert.equal(unknown.status, 'unresolved');
  assert.deepEqual(
    unknown.claims.map((entry) => entry.provenance),
    [supplement],
  );
  assert.deepEqual(unknown.suggestions, [
    { kind: 'confirm_edition', edition: '1e' },
    { kind: 'confirm_edition', edition: '2e' },
    { kind: 'keep_unresolved' },
  ]);

  const competing = findingOf(review.findings, 'competing_definition');
  assert.equal(competing.term, 'focus');
  assert.equal(competing.status, 'unresolved');
  assert.deepEqual(
    competing.claims.map((entry) => entry.provenance.sourceHash),
    [CORE_HASH, SUPPLEMENT_HASH],
  );
  assert.deepEqual(competing.suggestions, [
    { kind: 'prefer_claim', claimIndex: 0 },
    { kind: 'prefer_claim', claimIndex: 1 },
    { kind: 'keep_unresolved' },
  ]);

  const conflict = findingOf(review.findings, 'errata_conflict');
  assert.equal(conflict.term, 'focus');
  assert.deepEqual(
    conflict.claims.map((entry) => entry.provenance.sourceHash),
    [ERRATA_HASH, CORE_HASH, SUPPLEMENT_HASH],
  );
  assert.deepEqual(conflict.suggestions, [
    { kind: 'apply_errata', claimIndex: 0 },
    { kind: 'keep_original' },
    { kind: 'keep_unresolved' },
  ]);
});

test('agreeing sources and whitespace-only restatements produce no findings', () => {
  const review = reviewSources({
    knownEditions: KNOWN_EDITIONS,
    claims: [
      claim({ provenance: core }),
      claim({ provenance: supplement, definition: '  Spend 1   focus to reroll. ' }),
      claim({ provenance: core, definition: 'Spend 1 focus\tto reroll.' }),
      claim({ provenance: supplement, edition: '2e', definition: 'Spend 2 focus to reroll.' }),
      claim({ provenance: errata, kind: 'errata' }),
    ],
  });
  assert.deepEqual(review, { resolved: true, findings: [] });
});

test('one source defining a term two ways is a competing definition', () => {
  const first = claim({ provenance: core, term: 'Grit', definition: 'Ignore one wound.' });
  const second = claim({ provenance: core, term: 'Grit', definition: 'Ignore two wounds.' });
  const review = reviewSources({ knownEditions: KNOWN_EDITIONS, claims: [first, second] });

  assert.equal(review.findings.length, 1);
  const competing = findingOf(review.findings, 'competing_definition');
  assert.deepEqual(competing.claims, [first, second]);
  assert.deepEqual(competing.suggestions, [
    { kind: 'prefer_claim', claimIndex: 0 },
    { kind: 'prefer_claim', claimIndex: 1 },
    { kind: 'keep_unresolved' },
  ]);
});

test('two differing errata from one source each get an apply suggestion', () => {
  const review = reviewSources({
    knownEditions: KNOWN_EDITIONS,
    claims: [
      claim({ provenance: core }),
      claim({ provenance: errata, kind: 'errata', definition: 'Spend 1 focus once per scene.' }),
      claim({ provenance: errata, kind: 'errata', definition: 'Spend 1 focus once per session.' }),
    ],
  });
  const conflict = findingOf(review.findings, 'errata_conflict');
  assert.deepEqual(conflict.suggestions, [
    { kind: 'apply_errata', claimIndex: 0 },
    { kind: 'apply_errata', claimIndex: 1 },
    { kind: 'keep_original' },
    { kind: 'keep_unresolved' },
  ]);
});

test('errata without a core claim produce no finding', () => {
  const review = reviewSources({
    knownEditions: KNOWN_EDITIONS,
    claims: [claim({ provenance: errata, kind: 'errata' })],
  });
  assert.deepEqual(review, { resolved: true, findings: [] });
});

test('near-miss editions are flagged unknown, not mapped', () => {
  const upper = claim({ provenance: core, edition: '1E' });
  const padded = claim({ provenance: supplement, edition: '1e ' });
  const review = reviewSources({ knownEditions: KNOWN_EDITIONS, claims: [upper, padded] });

  assert.deepEqual(
    review.findings.filter((finding) => finding.kind === 'unknown_edition').map((finding) => finding.claims),
    [[upper], [padded]],
  );
});

test('duplicate known editions yield one confirm suggestion each', () => {
  const review = reviewSources({
    knownEditions: [...KNOWN_EDITIONS, ...KNOWN_EDITIONS],
    claims: [claim({ provenance: core, edition: null })],
  });
  assert.deepEqual(findingOf(review.findings, 'unknown_edition').suggestions, [
    { kind: 'confirm_edition', edition: '1e' },
    { kind: 'confirm_edition', edition: '2e' },
    { kind: 'keep_unresolved' },
  ]);
});

test('__proto__ terms and editions are plain data', () => {
  const PROTO = '__proto__';
  const first = claim({ provenance: core, term: PROTO, edition: PROTO });
  const second = claim({ provenance: supplement, term: PROTO, edition: PROTO, definition: 'Other.' });
  const review = reviewSources({ knownEditions: [PROTO], claims: [first, second] });

  assert.equal(review.findings.length, 1);
  const competing = findingOf(review.findings, 'competing_definition');
  assert.equal(competing.term, PROTO);
  assert.deepEqual(competing.claims, [first, second]);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('an ambiguous official edition cannot be silently converted to another edition', () => {
  const ambiguous = claim({ provenance: core, edition: AMBIGUOUS_EDITION });
  const review = reviewSources({ knownEditions: KNOWN_EDITIONS, claims: [ambiguous] });

  assert.equal(review.resolved, false);
  assert.equal(review.findings.length, 1);
  const unknown = findingOf(review.findings, 'unknown_edition');
  assert.equal(unknown.status, 'unresolved');
  assert.equal(unknown.edition, AMBIGUOUS_EDITION);
  assert.deepEqual(unknown.claims, [ambiguous]);
  assert.equal(unknown.claims[0]?.edition, AMBIGUOUS_EDITION);
  assert.ok(unknown.suggestions.some((suggestion) => suggestion.kind === 'keep_unresolved'));
  assert.ok(!('resolvedEdition' in unknown));
  assert.deepEqual(
    reviewSources({ knownEditions: [], claims: [ambiguous] }).findings.flatMap((finding) => finding.suggestions),
    [{ kind: 'keep_unresolved' }],
  );
});
