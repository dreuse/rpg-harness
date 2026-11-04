import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FANTASY_PACK as FANTASY } from '../../../packages/content/src/packs.ts';
import { type EffectiveMechanic, GM_ADJUDICATED as RULE_GM_ADJUDICATED } from '../../../packages/rules/src/dsl.ts';
import { createWorldActor } from '../../../packages/world/src/actor.ts';
import type { ActionProposal } from '../../../packages/world/src/planner.ts';
import {
  DETERMINISTIC,
  evaluatePolicy,
  GM_ADJUDICATED,
  SIMULATION_DISABLED,
  UNSUPPORTED_MECHANIC,
} from '../../../packages/world/src/policy.ts';
import { INVALID_SIMULATION_POLICY, toSimulationPolicy } from './simulation-policy.ts';

const FANTASY_PACK = FANTASY.genre;
const TICK = 4;
const UNTIL_TICK = 9;
const FRACTIONAL_TICK = 1.5;
const RULE_PACK = { id: 'd20-lite', edition: '1', revision: 'r1' };
const SOURCE = { kind: 'rulepack', sourceRef: 'core.trade', revision: 'r1' };
const TRADE = 'trade';
const SMUGGLE = 'smuggle';
const SUGGESTED = FANTASY_PACK.suggestedCapabilities[0] as string;

const deterministic = { ruleId: TRADE, rulePack: RULE_PACK, source: SOURCE, kind: DETERMINISTIC };
const adjudicated = {
  ruleId: SMUGGLE,
  rulePack: RULE_PACK,
  source: SOURCE,
  kind: RULE_GM_ADJUDICATED,
  reason: 'AdjudicatedCapability',
  issues: [],
};
const mechanics = [deterministic, adjudicated] as unknown as EffectiveMechanic[];
const genre = { ...FANTASY_PACK, suggestedCapabilities: [...FANTASY_PACK.suggestedCapabilities, TRADE] };
const base = { mechanics, genre, preferences: { simulation: 'balanced' }, adjudicator: true };

const guild = createWorldActor({ id: 'guild', kind: 'faction', name: 'Guild' });
const proposalOf = (kind: string): ActionProposal => ({
  actionId: `guild:${kind}@${TICK}`,
  actorId: 'guild',
  kind,
  knowledgeRefs: [],
  resourceRefs: [],
  tick: TICK,
});

const policyOf = (input: unknown) => {
  const result = toSimulationPolicy(input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).policy;
};

const issuesOf = (input: unknown) => {
  const result = toSimulationPolicy(input);
  assert.equal(result.ok, false);
  const { error } = result as Extract<typeof result, { ok: false }>;
  assert.equal(error.code, INVALID_SIMULATION_POLICY);
  return error.issues.map(({ path }) => path);
};

test('maps rule mechanics and genre suggestions to simulation policy', () => {
  const policy = policyOf(base);
  assert.equal(policy.mode, 'balanced');
  assert.equal(policy.adjudicator, true);
  assert.deepEqual(
    { ...policy.mechanics },
    {
      ...Object.fromEntries(FANTASY_PACK.suggestedCapabilities.map((kind) => [kind, GM_ADJUDICATED])),
      [TRADE]: DETERMINISTIC,
      [SMUGGLE]: GM_ADJUDICATED,
    },
  );
  assert.equal(policy.time, undefined);
  assert.equal(policy.factionKinds, undefined);
  assert.equal(policy.forbiddenKinds, undefined);

  const decide = (kind: string, active = policy) => evaluatePolicy(active, guild, proposalOf(kind));
  assert.deepEqual(decide(TRADE), { status: 'allowed' });
  assert.deepEqual(decide(SMUGGLE), { status: 'adjudicated', reason: GM_ADJUDICATED });
  assert.deepEqual(decide(SUGGESTED), { status: 'adjudicated', reason: GM_ADJUDICATED });
  assert.deepEqual(decide('assassinate'), { status: 'adjudicated', reason: UNSUPPORTED_MECHANIC });

  const solo = policyOf({ ...base, adjudicator: false });
  assert.deepEqual(decide(SMUGGLE, solo), { status: 'disabled', reason: UNSUPPORTED_MECHANIC });
  const off = policyOf({ ...base, preferences: { simulation: 'off' } });
  assert.deepEqual(decide(TRADE, off), { status: 'disabled', reason: SIMULATION_DISABLED });
});

test('passes validated time, faction and house-rule constraints through', () => {
  const policy = policyOf({
    ...base,
    time: { fromTick: TICK, untilTick: UNTIL_TICK },
    factionKinds: JSON.parse('{"guild":["trade"],"__proto__":["smuggle"]}'),
    forbiddenKinds: [SMUGGLE],
  });
  assert.deepEqual(policy.time, { fromTick: TICK, untilTick: UNTIL_TICK });
  assert.deepEqual(policy.forbiddenKinds, [SMUGGLE]);
  assert.equal(Object.getPrototypeOf(policy.factionKinds), null);
  assert.deepEqual(Object.entries(policy.factionKinds ?? {}), [
    ['guild', [TRADE]],
    ['__proto__', [SMUGGLE]],
  ]);
  assert.equal(Object.hasOwn(Object.prototype, SMUGGLE), false);
  assert.deepEqual(policyOf({ ...base, time: { fromTick: TICK, untilTick: TICK } }).time, {
    fromTick: TICK,
    untilTick: TICK,
  });
});

test('rejects malformed untrusted input with a typed error', () => {
  assert.deepEqual(issuesOf(null), ['']);
  assert.deepEqual(issuesOf(Object.create(base)), ['']);
  assert.deepEqual(issuesOf({ ...base, time: { fromTick: UNTIL_TICK, untilTick: TICK } }), ['time']);
  assert.deepEqual(issuesOf({ ...base, time: { fromTick: FRACTIONAL_TICK, untilTick: TICK } }), ['time.fromTick']);
  assert.deepEqual(issuesOf({ ...base, time: { fromTick: 0, untilTick: '9' } }), ['time.untilTick']);
  assert.deepEqual(issuesOf({ ...base, time: [] }), ['time']);
  assert.deepEqual(issuesOf({ ...base, factionKinds: { guild: 'trade' } }), ['factionKinds.guild']);
  assert.deepEqual(issuesOf({ ...base, factionKinds: Object.create({ guild: [TRADE] }) }), ['factionKinds']);
  assert.deepEqual(issuesOf({ ...base, forbiddenKinds: [TRADE, 1] }), ['forbiddenKinds.1']);
  assert.deepEqual(issuesOf({ ...base, mechanics: {} }), ['mechanics']);
  assert.deepEqual(issuesOf({ ...base, mechanics: [{ ...deterministic, kind: 'magic' }] }), ['mechanics.0.kind']);
  assert.deepEqual(issuesOf({ ...base, mechanics: [{ ...deterministic, ruleId: 1 }] }), ['mechanics.0.ruleId']);
  assert.deepEqual(issuesOf({ ...base, mechanics: [null] }), ['mechanics.0']);
  assert.deepEqual(issuesOf({ ...base, genre: { suggestedCapabilities: 'social' } }), ['genre.suggestedCapabilities']);
  assert.deepEqual(issuesOf({ ...base, preferences: { simulation: 'chaos' } }), ['preferences.simulation']);
  assert.deepEqual(issuesOf({ ...base, adjudicator: 'yes' }), ['adjudicator']);
});
