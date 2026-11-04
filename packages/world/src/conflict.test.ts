import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ActionClaim,
  type ClaimPort,
  CONTESTED_CLAIM,
  DUPLICATE_ACTION_ID,
  MALFORMED_CLAIM,
  resolveConflicts,
} from './conflict.ts';
import type { ActionProposal } from './planner.ts';
import { MALFORMED_ACTION } from './world.ts';

const TICK = 4;
const HIGH = 2;
const LOW = 1;

const action = (actorId: string, kind: string, tick = TICK): ActionProposal => ({
  actionId: `${actorId}:${kind}@${tick}`,
  actorId,
  kind,
  knowledgeRefs: ['fact'],
  resourceRefs: [],
  tick,
});

const table =
  (claims: Record<string, ActionClaim>): ClaimPort =>
  (proposal) =>
    claims[proposal.actionId] ?? { exclusive: [], priority: LOW };

const ids = (proposals: readonly { actionId: string }[]) => proposals.map((p) => p.actionId);

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [item, ...p]));

describe('W06 conflict resolution', () => {
  it('handle contested resources, races and incompatible actions with documented deterministic rules', () => {
    const early = action('thieves', 'seize-artifact', TICK - 1);
    const late = action('paladins', 'seize-artifact');
    const strong = action('crown', 'tax-market');
    const weak = action('guild', 'tax-market');
    const ally = action('elves', 'ally-dwarves');
    const war = action('elves', 'attack-dwarves');
    const free = action('farmers', 'harvest');
    const claims = table({
      [early.actionId]: { exclusive: ['item:artifact'], priority: LOW },
      [late.actionId]: { exclusive: ['item:artifact'], priority: HIGH },
      [strong.actionId]: { exclusive: ['market:coin'], priority: HIGH },
      [weak.actionId]: { exclusive: ['market:coin'], priority: LOW },
      [ally.actionId]: { exclusive: ['stance:elves-dwarves'], priority: LOW },
      [war.actionId]: { exclusive: ['stance:elves-dwarves'], priority: LOW },
    });
    const result = resolveConflicts([late, weak, war, free, ally, strong, early], claims);
    assert.deepEqual(ids(result.accepted), [early.actionId, strong.actionId, ally.actionId, free.actionId]);
    assert.deepEqual(result.rejected, [
      { action: late, reason: CONTESTED_CLAIM, claim: 'item:artifact', winnerId: early.actionId },
      { action: war, reason: CONTESTED_CLAIM, claim: 'stance:elves-dwarves', winnerId: ally.actionId },
      { action: weak, reason: CONTESTED_CLAIM, claim: 'market:coin', winnerId: strong.actionId },
    ]);
  });

  it('two actors cannot spend the same unique item or own exclusive territory simultaneously', () => {
    const spendA = action('a', 'spend-relic');
    const spendB = action('b', 'spend-relic');
    const holdA = action('a', 'claim-valley');
    const holdB = action('b', 'claim-valley');
    const claims = table({
      [spendA.actionId]: { exclusive: ['item:relic'], priority: LOW },
      [spendB.actionId]: { exclusive: ['item:relic'], priority: LOW },
      [holdA.actionId]: { exclusive: ['territory:valley'], priority: LOW },
      [holdB.actionId]: { exclusive: ['territory:valley', 'item:relic'], priority: HIGH },
    });
    const result = resolveConflicts([spendA, spendB, holdA, holdB], claims);
    assert.deepEqual(ids(result.accepted), [holdB.actionId]);
    assert.deepEqual(
      result.rejected.map((r) => [r.action.actionId, r.claim, r.winnerId]),
      [
        [holdA.actionId, 'territory:valley', holdB.actionId],
        [spendA.actionId, 'item:relic', holdB.actionId],
        [spendB.actionId, 'item:relic', holdB.actionId],
      ],
    );
  });

  it('produces the same resolution for every input order', () => {
    const [a, b, c, d] = [action('a', 'take'), action('b', 'take'), action('c', 'take', TICK - 1), action('d', 'rest')];
    const proposals = [a, b, c, d];
    const claims = table({
      [a.actionId]: { exclusive: ['item:key'], priority: HIGH },
      [b.actionId]: { exclusive: ['item:key'], priority: HIGH },
      [c.actionId]: { exclusive: ['item:key', 'door'], priority: LOW },
      [d.actionId]: { exclusive: ['door'], priority: HIGH },
    });
    const expected = resolveConflicts(proposals, claims);
    assert.deepEqual(ids(expected.accepted), [c.actionId]);
    for (const order of permutations(proposals)) assert.deepEqual(resolveConflicts(order, claims), expected);
  });

  it('breaks full ties by stable action id', () => {
    const b = action('b', 'take');
    const a = action('a', 'take');
    const claims: ClaimPort = () => ({ exclusive: ['item:key'], priority: LOW });
    assert.deepEqual(ids(resolveConflicts([b, a], claims).accepted), [a.actionId]);
  });

  it('rejects every proposal sharing a duplicate action id', () => {
    const one = action('a', 'take');
    const other = { ...one, kind: 'burn' };
    const result = resolveConflicts([one, other, action('b', 'rest')], table({}));
    assert.deepEqual(ids(result.accepted), ['b:rest@4']);
    assert.deepEqual(
      result.rejected.map((r) => [r.action.kind, r.reason, r.winnerId]),
      [
        ['take', DUPLICATE_ACTION_ID, null],
        ['burn', DUPLICATE_ACTION_ID, null],
      ].sort(),
    );
  });

  it('rejects proposals whose claim port throws or returns malformed claims', () => {
    const bad = [action('a', 'throw'), action('b', 'junk'), action('c', 'nan'), action('d', 'empty')];
    const ok = action('e', 'take');
    const port: ClaimPort = (p) => {
      if (p.kind === 'throw') throw new Error('boom');
      if (p.kind === 'junk') return { exclusive: 'item:key', priority: LOW } as unknown as ActionClaim;
      if (p.kind === 'nan') return { exclusive: ['item:key'], priority: Number.NaN };
      if (p.kind === 'empty') return { exclusive: [''], priority: LOW };
      return { exclusive: ['item:key'], priority: LOW };
    };
    const result = resolveConflicts([...bad, ok], port);
    assert.deepEqual(ids(result.accepted), [ok.actionId]);
    assert.deepEqual(ids(result.rejected.map((r) => r.action)), ids(bad));
    assert.ok(result.rejected.every((r) => r.reason === MALFORMED_CLAIM && r.winnerId === null));
  });

  it('does not let the claim port mutate proposals', () => {
    const proposal = action('a', 'take');
    const port: ClaimPort = (p) => {
      (p as { kind: string }).kind = 'changed';
      return { exclusive: [], priority: LOW };
    };
    const before = structuredClone(proposal);
    resolveConflicts([proposal], port);
    assert.deepEqual(proposal, before);
  });

  it('rejects malformed proposals and still resolves the good ones', () => {
    const good = action('a', 'take');
    const rival = action('b', 'take');
    const circular: Record<string, unknown> = { ...action('c', 'take') };
    circular.self = circular;
    const big = { ...action('d', 'rest'), weight: BigInt(1) };
    const nanTick = { ...action('e', 'take'), tick: Number.NaN };
    const numericId = { ...action('f', 'take'), actionId: 1 };
    const malformed = [null, nanTick, numericId] as unknown as ActionProposal[];
    const claims: ClaimPort = (p) => ({ exclusive: p.kind === 'take' ? ['item:key'] : [], priority: LOW });
    const result = resolveConflicts(
      [rival, ...malformed, circular as ActionProposal, big as ActionProposal, good],
      claims,
    );
    assert.deepEqual(ids(result.accepted), [good.actionId, big.actionId]);
    const reasons = result.rejected.map((r) => r.reason);
    assert.equal(reasons.filter((r) => r === MALFORMED_ACTION).length, malformed.length);
    assert.deepEqual(
      result.rejected.filter((r) => r.reason === CONTESTED_CLAIM).map((r) => r.action.actionId),
      [rival.actionId, 'c:take@4'],
    );
  });
});
