import type { Provenance } from './provenance.ts';

export const CLAIM_KINDS = ['core', 'errata'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const FINDING_KINDS = ['unknown_edition', 'competing_definition', 'errata_conflict'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const UNRESOLVED = 'unresolved';
const MIN_DISTINCT = 2;
const WHITESPACE = /\s+/g;

export type SourceClaim = {
  readonly term: string;
  readonly definition: string;
  readonly edition: string | null;
  readonly kind: ClaimKind;
  readonly provenance: Provenance;
};

export type SuggestedDecision =
  | { readonly kind: 'confirm_edition'; readonly edition: string }
  | { readonly kind: 'prefer_claim'; readonly claimIndex: number }
  | { readonly kind: 'apply_errata'; readonly claimIndex: number }
  | { readonly kind: 'keep_original' }
  | { readonly kind: 'keep_unresolved' };

type FindingBase = {
  readonly status: typeof UNRESOLVED;
  readonly claims: readonly SourceClaim[];
  readonly suggestions: readonly SuggestedDecision[];
};

export type Finding =
  | (FindingBase & { readonly kind: 'unknown_edition'; readonly edition: string | null })
  | (FindingBase & { readonly kind: 'competing_definition'; readonly term: string })
  | (FindingBase & { readonly kind: 'errata_conflict'; readonly term: string });

export type ReviewInput = { readonly knownEditions: readonly string[]; readonly claims: readonly SourceClaim[] };
export type SourceReview = { readonly resolved: boolean; readonly findings: readonly Finding[] };

const KEEP_UNRESOLVED: SuggestedDecision = { kind: 'keep_unresolved' };

const collapse = (text: string) => text.trim().replace(WHITESPACE, ' ');
const normalizeTerm = (term: string) => collapse(term).toLowerCase();
const unique = <T>(values: readonly T[]) => [...new Set(values)];

function groupBy<K>(claims: readonly SourceClaim[], keyOf: (claim: SourceClaim) => K) {
  const groups = new Map<K, SourceClaim[]>();
  for (const claim of claims) {
    const key = keyOf(claim);
    const group = groups.get(key);
    if (group) group.push(claim);
    else groups.set(key, [claim]);
  }
  return groups;
}

const distinctDefinitionIndexes = (claims: readonly SourceClaim[]) =>
  [...groupBy(claims, (claim) => collapse(claim.definition)).values()].map((group) =>
    claims.indexOf(group[0] as SourceClaim),
  );

function unknownEditions({ knownEditions, claims }: ReviewInput): Finding[] {
  const unknown = claims.filter((claim) => claim.edition === null || !knownEditions.includes(claim.edition));
  const suggestions = [
    ...unique(knownEditions).map((edition) => ({ kind: 'confirm_edition' as const, edition })),
    KEEP_UNRESOLVED,
  ];
  return [...groupBy(unknown, (claim) => claim.edition)].map(([edition, grouped]) => ({
    kind: 'unknown_edition',
    status: UNRESOLVED,
    edition,
    claims: grouped,
    suggestions,
  }));
}

function termConflicts(term: string, claims: readonly SourceClaim[]): Finding[] {
  const cores = claims.filter((claim) => claim.kind === 'core');
  const coreDefinitions = new Set(cores.map((claim) => collapse(claim.definition)));
  const differingErrata = claims.filter(
    (claim) => claim.kind === 'errata' && cores.length > 0 && !coreDefinitions.has(collapse(claim.definition)),
  );
  const findings: Finding[] = [];
  if (coreDefinitions.size >= MIN_DISTINCT) {
    findings.push({
      kind: 'competing_definition',
      status: UNRESOLVED,
      term,
      claims: cores,
      suggestions: [
        ...distinctDefinitionIndexes(cores).map((claimIndex) => ({ kind: 'prefer_claim' as const, claimIndex })),
        KEEP_UNRESOLVED,
      ],
    });
  }
  if (differingErrata.length > 0) {
    findings.push({
      kind: 'errata_conflict',
      status: UNRESOLVED,
      term,
      claims: [...differingErrata, ...cores],
      suggestions: [
        ...distinctDefinitionIndexes(differingErrata).map((claimIndex) => ({
          kind: 'apply_errata' as const,
          claimIndex,
        })),
        { kind: 'keep_original' },
        KEEP_UNRESOLVED,
      ],
    });
  }
  return findings;
}

export function reviewSources(input: ReviewInput): SourceReview {
  const byTermAndEdition = groupBy(input.claims, (claim) => JSON.stringify([normalizeTerm(claim.term), claim.edition]));
  const findings = [
    ...unknownEditions(input),
    ...[...byTermAndEdition.values()].flatMap((claims) => termConflicts(normalizeTerm(claims[0]?.term ?? ''), claims)),
  ];
  return { resolved: findings.length === 0, findings };
}
