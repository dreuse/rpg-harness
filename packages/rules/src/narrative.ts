import {
  isNonEmptyString,
  type ManifestIssue,
  NON_EMPTY_STRING,
  RULEPACK_CONTRACT_VERSION,
  type RulePackManifest,
} from './rulepack.ts';

export const ADJUDICATED_MODE = 'adjudicated';

export const NARRATIVE_MANIFEST: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'narrative',
  edition: 'original',
  revision: '1',
  capabilities: { checks: ADJUDICATED_MODE, combat: ADJUDICATED_MODE, resources: false, progression: false },
  sourceRefs: [],
};

export type NarrativeAction = { actionId: string; intent: string; outcome: string };
export type Adjudication = NarrativeAction & { mode: typeof ADJUDICATED_MODE };
export type AdjudicationResult = { ok: true; adjudication: Adjudication } | { ok: false; issues: ManifestIssue[] };

const FIELDS = ['actionId', 'intent', 'outcome'] as const;

export const adjudicate = (action: NarrativeAction): AdjudicationResult => {
  const issues = FIELDS.filter((key) => !isNonEmptyString(action[key])).map((path) => ({
    path,
    message: NON_EMPTY_STRING,
  }));
  if (issues.length > 0) return { ok: false, issues };
  const { actionId, intent, outcome } = action;
  return { ok: true, adjudication: { mode: ADJUDICATED_MODE, actionId, intent, outcome } };
};
