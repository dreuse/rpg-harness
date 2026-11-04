import type { IntentConflict } from './conflicts.ts';
import { type CampaignIntent, INTENT_FIELDS, type IntentField, type Sourced } from './intent.ts';
import type { RulesetCandidate, RulesetResolution } from './resolver.ts';

export const MAX_BLOCKING_QUESTIONS = 3;
export const QUESTION_CODES = ['ruleset_unknown', 'ruleset_ambiguous', 'conflict'] as const;

export type QuestionCode = (typeof QUESTION_CODES)[number];
export type BlockingQuestion = {
  code: QuestionCode;
  fields: IntentField[];
  options: RulesetCandidate[];
  conflict?: IntentConflict;
};
export type DefaultProposal = {
  field: IntentField;
  value: unknown;
  provenance: 'default';
  revert: Sourced<unknown>;
};
export type ClarificationPlan = {
  questions: BlockingQuestion[];
  deferred: BlockingQuestion[];
  defaults: DefaultProposal[];
};

const rulesetQuestions = (resolution?: RulesetResolution): BlockingQuestion[] => {
  if (resolution?.status === 'ambiguous')
    return [{ code: 'ruleset_ambiguous', fields: ['ruleset'], options: resolution.candidates }];
  if (resolution?.status === 'clarification_needed')
    return [{ code: 'ruleset_unknown', fields: ['ruleset'], options: resolution.available }];
  return [];
};

const conflictQuestion = (conflict: IntentConflict): BlockingQuestion => ({
  code: 'conflict',
  fields: conflict.entries.map((entry) => entry.field),
  options: [],
  conflict,
});

export const planClarification = (
  intent: CampaignIntent,
  conflicts: readonly IntentConflict[] = [],
  resolution?: RulesetResolution,
): ClarificationPlan => {
  const blocking = [
    ...rulesetQuestions(resolution),
    ...conflicts.filter((conflict) => conflict.severity === 'conflict').map(conflictQuestion),
  ];
  const asked = new Set(blocking.flatMap((question) => question.fields));
  const defaults = INTENT_FIELDS.filter((field) => intent[field].provenance === 'default' && !asked.has(field)).map(
    (field): DefaultProposal => ({
      field,
      value: structuredClone(intent[field].value),
      provenance: 'default',
      revert: structuredClone(intent[field]),
    }),
  );
  return {
    questions: blocking.slice(0, MAX_BLOCKING_QUESTIONS),
    deferred: blocking.slice(MAX_BLOCKING_QUESTIONS),
    defaults,
  };
};
