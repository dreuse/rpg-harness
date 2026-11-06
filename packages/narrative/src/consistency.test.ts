import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignEvent } from '../../domain/src/campaign.ts';
import { type Fact, GM_VIEWER, PLAYER_VIEWER, type Viewer } from '../../memory/src/knowledge.ts';
import { type ConsistencyInput, checkConsistency, type NarrationClaim } from './consistency.ts';

const CAMPAIGN = 'campaign-1';
const HERO = 'actor-hero';
const RIVAL = 'actor-rival';
const SWORD = 'item-sword';
const LANTERN = 'item-lantern';
const HIT_EVENT = 'event-hit';
const MISSING_EVENT = 'event-missing';
const PUBLIC_FACT = 'fact-gate';
const GM_FACT = 'fact-traitor';
const RIVAL_FACT = 'fact-rival-secret';
const UNKNOWN_FACT = 'fact-unknown';
const GM_STATEMENT = 'The captain is the traitor';
const RIVAL_STATEMENT = 'Rival hid the key under the altar';
const HERO_VIEWER: Viewer = { scope: 'actor', actorId: HERO };

const event = (id: string): CampaignEvent => ({
  id,
  campaignId: CAMPAIGN,
  turnId: 'turn-1',
  causationId: null,
  type: 'EffectApplied',
  payload: {},
});

const fact = (id: string, overrides: Partial<Fact> = {}): Fact => ({
  id,
  campaignId: CAMPAIGN,
  subjectId: null,
  statement: `statement of ${id}`,
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
  ...overrides,
});

const FACTS: readonly Fact[] = [
  fact(PUBLIC_FACT),
  fact(GM_FACT, { visibility: 'gm', statement: GM_STATEMENT }),
  fact(RIVAL_FACT, { visibility: 'actor-scoped', actorId: RIVAL, statement: RIVAL_STATEMENT }),
];

const input = (claims: readonly NarrationClaim[], overrides: Partial<ConsistencyInput> = {}): ConsistencyInput => ({
  narration: 'The hero swings.',
  claims,
  events: [event(HIT_EVENT)],
  facts: FACTS,
  equipment: { [HERO]: [SWORD] },
  viewer: PLAYER_VIEWER,
  ...overrides,
});

test('validates narration claims against committed events and known facts', () => {
  const report = checkConsistency(
    input([
      { kind: 'effect', ref: 'c1', eventId: HIT_EVENT },
      { kind: 'equipment', ref: 'c2', actorId: HERO, itemId: SWORD },
      { kind: 'fact', ref: 'c3', factId: PUBLIC_FACT },
    ]),
  );
  assert.deepEqual(report, { ok: true, violations: [] });
});

test('passes cleanly when narration makes no claims', () => {
  assert.deepEqual(checkConsistency(input([])), { ok: true, violations: [] });
});

test('flags uncommitted damage with no matching committed event', () => {
  const report = checkConsistency(
    input([
      { kind: 'effect', ref: 'c1', eventId: MISSING_EVENT },
      { kind: 'effect', ref: 'c2', eventId: null },
    ]),
  );
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.violations.map(({ kind, ref, sourceId }) => ({ kind, ref, sourceId })),
    [
      { kind: 'uncommitted-effect', ref: 'c1', sourceId: MISSING_EVENT },
      { kind: 'uncommitted-effect', ref: 'c2', sourceId: null },
    ],
  );
});

test('flags impossible equipment the actor does not hold', () => {
  const report = checkConsistency(
    input([
      { kind: 'equipment', ref: 'c1', actorId: HERO, itemId: LANTERN },
      { kind: 'equipment', ref: 'c2', actorId: RIVAL, itemId: SWORD },
    ]),
  );
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.violations.map(({ kind, ref, sourceId }) => ({ kind, ref, sourceId })),
    [
      { kind: 'impossible-equipment', ref: 'c1', sourceId: LANTERN },
      { kind: 'impossible-equipment', ref: 'c2', sourceId: SWORD },
    ],
  );
});

test('flags a secret leak of a gm-only fact to the player', () => {
  const report = checkConsistency(input([{ kind: 'fact', ref: 'c1', factId: GM_FACT }]));
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.violations.map(({ kind, ref, sourceId }) => ({ kind, ref, sourceId })),
    [{ kind: 'secret-leak', ref: 'c1', sourceId: GM_FACT }],
  );
});

test('flags a secret leak of another actor-scoped fact', () => {
  const report = checkConsistency(input([{ kind: 'fact', ref: 'c1', factId: RIVAL_FACT }], { viewer: HERO_VIEWER }));
  assert.deepEqual(
    report.violations.map(({ kind, sourceId }) => ({ kind, sourceId })),
    [{ kind: 'secret-leak', sourceId: RIVAL_FACT }],
  );
});

test('flags a secret restated in narration text without a claim', () => {
  const report = checkConsistency(
    input([], { narration: `Whispers say ${RIVAL_STATEMENT.toLowerCase()}.`, viewer: HERO_VIEWER }),
  );
  assert.deepEqual(
    report.violations.map(({ kind, ref, sourceId }) => ({ kind, ref, sourceId })),
    [{ kind: 'secret-leak', ref: null, sourceId: RIVAL_FACT }],
  );
});

test('catches a secret split by line breaks or extra spaces, and padded statements', () => {
  const padded = [fact(GM_FACT, { visibility: 'gm', statement: `  ${GM_STATEMENT}  ` })];
  const report = checkConsistency(input([], { narration: 'The captain\n  is   the TRAITOR.', facts: padded }));
  assert.deepEqual(
    report.violations.map(({ kind, sourceId }) => ({ kind, sourceId })),
    [{ kind: 'secret-leak', sourceId: GM_FACT }],
  );
});

test('ignores empty and blank secret statements', () => {
  const blank = [
    fact(GM_FACT, { visibility: 'gm', statement: '' }),
    fact(RIVAL_FACT, { visibility: 'gm', statement: '   ' }),
  ];
  assert.deepEqual(checkConsistency(input([], { facts: blank })), { ok: true, violations: [] });
});

test('allows gm viewer to see gm-only facts', () => {
  const report = checkConsistency(
    input([{ kind: 'fact', ref: 'c1', factId: GM_FACT }], { narration: GM_STATEMENT, viewer: GM_VIEWER }),
  );
  assert.deepEqual(report, { ok: true, violations: [] });
});

test('flags a fact claim that matches no known fact', () => {
  const report = checkConsistency(input([{ kind: 'fact', ref: 'c1', factId: UNKNOWN_FACT }]));
  assert.deepEqual(
    report.violations.map(({ kind, sourceId }) => ({ kind, sourceId })),
    [{ kind: 'unknown-fact', sourceId: UNKNOWN_FACT }],
  );
});

test('never echoes secret statement text in violations', () => {
  const report = checkConsistency(input([{ kind: 'fact', ref: 'c1', factId: GM_FACT }], { narration: GM_STATEMENT }));
  const output = JSON.stringify(report);
  assert.equal(report.ok, false);
  assert.equal(output.includes(GM_STATEMENT), false);
  assert.equal(output.includes(RIVAL_STATEMENT), false);
});

const OUTCOME_CLAIM: NarrationClaim = { kind: 'outcome', ref: 'hit on the goblin', declared: 'hit' };
const MISS_CLAIM: NarrationClaim = { kind: 'outcome', ref: 'miss on the goblin', declared: 'miss' };
const AS_WRITTEN_UNRESOLVED = { rulesStrictness: 'as-written', resolvedOutcome: null } as const;

test('rpg-42a.74: as-written rejects a declared outcome with no resolved check', () => {
  const report = checkConsistency(input([OUTCOME_CLAIM], AS_WRITTEN_UNRESOLVED));
  assert.deepEqual(
    report.violations.map(({ kind, ref }) => [kind, ref]),
    [['unresolved-outcome', OUTCOME_CLAIM.ref]],
  );
});

test('rpg-42a.74: as-written accepts a declared outcome that matches the resolved result', () => {
  assert.equal(
    checkConsistency(input([OUTCOME_CLAIM], { rulesStrictness: 'as-written', resolvedOutcome: 'hit' })).ok,
    true,
  );
  assert.equal(
    checkConsistency(input([MISS_CLAIM], { rulesStrictness: 'as-written', resolvedOutcome: 'miss' })).ok,
    true,
  );
});

test('rpg-42a.86: as-written rejects a declared outcome that differs from the resolved result', () => {
  const cases = [
    [OUTCOME_CLAIM, 'miss'],
    [MISS_CLAIM, 'hit'],
  ] as const;
  for (const [claim, resolvedOutcome] of cases) {
    const report = checkConsistency(input([claim], { rulesStrictness: 'as-written', resolvedOutcome }));
    assert.deepEqual(
      report.violations.map(({ kind, ref }) => [kind, ref]),
      [['outcome-mismatch', claim.ref]],
    );
    assert.equal(report.ok, false);
  }
});

test('rpg-42a.86: a resolved check with no hit or miss result accepts any declared outcome', () => {
  const resolved = { rulesStrictness: 'as-written', checkResolved: true, resolvedOutcome: null } as const;
  assert.equal(checkConsistency(input([OUTCOME_CLAIM, MISS_CLAIM], resolved)).ok, true);
});

test('rpg-42a.86: relaxed and off skip the outcome comparison', () => {
  for (const rulesStrictness of ['relaxed', 'off'] as const)
    assert.equal(checkConsistency(input([OUTCOME_CLAIM], { rulesStrictness, resolvedOutcome: 'miss' })).ok, true);
});

test('rpg-42a.74: relaxed, off and an unset strictness skip the outcome check', () => {
  for (const rulesStrictness of ['relaxed', 'off'] as const)
    assert.equal(checkConsistency(input([OUTCOME_CLAIM], { rulesStrictness })).ok, true);
  assert.equal(checkConsistency(input([OUTCOME_CLAIM])).ok, true);
});

test('rpg-42a.74: narration text alone never counts as an outcome, whatever the verbs', () => {
  for (const narration of [
    'You slash the goblin and it falls.',
    'Your shot misses the ogre.',
    'The club hits the wolf.',
    'O guarda acerta você.',
    'Rain hits the roof.',
    'You missed the last boat.',
  ])
    assert.equal(checkConsistency(input([], { narration, ...AS_WRITTEN_UNRESOLVED })).ok, true, narration);
});
