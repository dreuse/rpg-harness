import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BLOCKING_QUESTIONS, planClarification } from './clarification.ts';
import { detectConflicts } from './conflicts.ts';
import { createCampaignIntent, INTENT_FIELDS } from './intent.ts';
import type { CapabilityReport } from './registry.ts';
import type { RulesetResolution } from './resolver.ts';

const NO_MECHANICS: CapabilityReport = { advertised: [], supported: [], unsupported: [] };
const REQUESTED = { id: 'dnd', edition: '1.9' };
const CANDIDATES = [
  { id: 'dnd', edition: '5e' },
  { id: 'dnd', edition: '3.5' },
];

const explicit = <T>(value: T) => ({ value, provenance: 'explicit' as const });
const derived = <T>(value: T) => ({ value, provenance: 'derived' as const });

test('N06 ask only blocking questions and propose reversible default settings', () => {
  const intent = createCampaignIntent({
    ruleset: explicit(REQUESTED),
    genre: derived('noir'),
    voiceOutput: explicit(true),
    combat: derived('on'),
  });
  const unknown: RulesetResolution = {
    status: 'clarification_needed',
    reason: 'unknown_edition',
    requested: REQUESTED,
    available: CANDIDATES,
  };
  const conflicts = detectConflicts(intent, NO_MECHANICS);
  const plan = planClarification(intent, conflicts, unknown);

  assert.deepEqual(
    plan.questions.map((question) => question.code),
    ['ruleset_unknown', 'conflict'],
  );
  const [ruleset, conflict] = plan.questions;
  assert.deepEqual(ruleset?.fields, ['ruleset']);
  assert.deepEqual(ruleset?.options, CANDIDATES);
  assert.deepEqual(conflict?.fields, ['voiceOutput', 'client']);
  assert.equal(conflict?.conflict?.code, 'client_unsupported');

  const proposed = plan.defaults.map((proposal) => proposal.field);
  assert.ok(!proposed.includes('ruleset'));
  assert.ok(!proposed.includes('voiceOutput'));
  assert.ok(!proposed.includes('client'));
  assert.ok(!proposed.includes('genre'));
  assert.ok(!proposed.includes('combat'));
  assert.ok(proposed.includes('pacing'));
  for (const proposal of plan.defaults) {
    assert.equal(proposal.provenance, 'default');
    assert.deepEqual(proposal.revert, intent[proposal.field]);
  }
  assert.deepEqual(
    plan.defaults.find((proposal) => proposal.field === 'pacing'),
    { field: 'pacing', value: 'balanced', provenance: 'default', revert: { value: 'balanced', provenance: 'default' } },
  );

  const ambiguous: RulesetResolution = { status: 'ambiguous', requested: REQUESTED, candidates: CANDIDATES };
  assert.equal(planClarification(intent, [], ambiguous).questions[0]?.code, 'ruleset_ambiguous');

  const resolvedIntent = createCampaignIntent({ combat: derived('on') });
  const infoOnly = detectConflicts(resolvedIntent, NO_MECHANICS);
  assert.equal(infoOnly[0]?.severity, 'info');
  assert.deepEqual(planClarification(resolvedIntent, infoOnly).questions, []);
});

test('N06 long questionnaires are never required just to start a narrative campaign', () => {
  const empty = planClarification(createCampaignIntent({}));
  assert.deepEqual(empty.questions, []);
  assert.deepEqual(empty.deferred, []);
  assert.deepEqual(
    empty.defaults.map((proposal) => proposal.field),
    INTENT_FIELDS,
  );
  assert.equal(empty.defaults.find((proposal) => proposal.field === 'ruleset')?.value, null);

  const noisy = createCampaignIntent({
    dice: explicit('on'),
    attributes: explicit('on'),
    combat: explicit('on'),
    diceVisualization: explicit(true),
    voiceInput: explicit(true),
    voiceOutput: explicit(true),
    ambience: explicit(true),
  });
  const conflicts = detectConflicts(noisy, NO_MECHANICS);
  assert.ok(conflicts.length > MAX_BLOCKING_QUESTIONS);
  const plan = planClarification(noisy, conflicts);
  assert.equal(plan.questions.length, MAX_BLOCKING_QUESTIONS);
  assert.equal(plan.questions.length + plan.deferred.length, conflicts.length);
  assert.ok(plan.defaults.every((proposal) => noisy[proposal.field].provenance === 'default'));
});
