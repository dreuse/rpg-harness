import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWorldActor, learn, type WorldActor } from './actor.ts';
import { createFactionPlanner, decideStrategy, type FactionTargets } from './faction.ts';
import type { PlanRequest } from './scheduler.ts';
import { applyProposal, type CanonView, type WorldCommit } from './validation.ts';

const TICK = 4;
const targets: FactionTargets = { harbor: 10, grain: 6 };
const witnessed = (factId: string) =>
  ({ factId, channel: 'witnessed', sourceId: null, eventId: 'e1', tick: 0 }) as const;
const faction = (id: string, resources: Record<string, number>, goals = ['harbor']): WorldActor =>
  createWorldActor({ id, kind: 'faction', name: id, goals, resources, knowledge: [witnessed(`${id}-intel`)] });
const request = (actorId: string): PlanRequest => ({ actorId, clock: { tick: TICK, events: [] }, triggers: [] });
const plan = (actors: readonly WorldActor[], actorId: string) =>
  createFactionPlanner(actors, targets)(request(actorId));

describe('W09 factions negotiate, compete, expand or retreat consistently from resources and goals', () => {
  it('expands when goals are met or uncontested', () => {
    assert.equal(decideStrategy(faction('a', { harbor: 10 }), [faction('b', { harbor: 9 })], targets), 'expand');
    assert.equal(
      decideStrategy(faction('a', { harbor: 2 }), [faction('b', { grain: 9 }, ['grain'])], targets),
      'expand',
    );
  });

  it('competes when stronger than every rival on shared goals', () => {
    assert.equal(decideStrategy(faction('a', { harbor: 6 }), [faction('b', { harbor: 5 })], targets), 'compete');
  });

  it('negotiates when matched or outmatched but holding ground', () => {
    assert.equal(decideStrategy(faction('a', { harbor: 5 }), [faction('b', { harbor: 5 })], targets), 'negotiate');
    assert.equal(decideStrategy(faction('a', { harbor: 4 }), [faction('b', { harbor: 8 })], targets), 'negotiate');
  });

  it('retreats when outmatched with little of its goals secured', () => {
    assert.equal(decideStrategy(faction('a', { harbor: 1 }), [faction('b', { harbor: 8 })], targets), 'retreat');
  });

  it('ignores goals without a target and non-faction rivals', () => {
    const npc = createWorldActor({ id: 'n', kind: 'npc', name: 'n', goals: ['harbor'], resources: { harbor: 99 } });
    assert.equal(decideStrategy(faction('a', { harbor: 3 }), [npc], targets), 'expand');
    assert.equal(decideStrategy(faction('a', { coin: 3 }, ['coin']), [], targets), undefined);
  });

  it('emits one stable, scoped proposal for the same state every time', () => {
    const actors = [faction('a', { harbor: 6, coin: 1 }), faction('b', { harbor: 5 })];
    const first = plan(actors, 'a');
    assert.deepEqual(first, [
      {
        actionId: `a:compete@${TICK}`,
        actorId: 'a',
        kind: 'compete',
        knowledgeRefs: ['a-intel'],
        resourceRefs: ['harbor'],
        tick: TICK,
      },
    ]);
    assert.deepEqual(plan(actors, 'a'), first);
    assert.deepEqual(plan([...actors].reverse(), 'a'), first);
  });

  it('proposes nothing for unknown actors, npcs or factions without knowledge', () => {
    const blind = createWorldActor({
      id: 'z',
      kind: 'faction',
      name: 'z',
      goals: ['harbor'],
      resources: { harbor: 1 },
    });
    const npc = createWorldActor({ id: 'n', kind: 'npc', name: 'n', goals: ['harbor'], knowledge: [witnessed('x')] });
    assert.deepEqual(plan([blind, npc], 'z'), []);
    assert.deepEqual(plan([blind, npc], 'n'), []);
    assert.deepEqual(plan([blind, npc], 'missing'), []);
  });
});

describe('W09 player intervention changes faction plans instead of forcing predetermined outcomes', () => {
  const canon: CanonView = { campaignId: 'c1', branchId: 'main', revision: 1, tick: TICK, committed: [] };

  it('replans from the committed state after the player shifts resources', () => {
    const rival = faction('b', { harbor: 5 });
    const before = faction('a', { harbor: 6 });
    assert.equal(plan([before, rival], 'a')[0]?.kind, 'compete');
    const sabotaged = { ...before, resources: { harbor: 1 } };
    assert.equal(plan([sabotaged, rival], 'a')[0]?.kind, 'retreat');
    const aided = { ...before, resources: { harbor: 10 } };
    assert.equal(plan([aided, rival], 'a')[0]?.kind, 'expand');
  });

  it('cites player-caused knowledge the faction learned', () => {
    const informed = learn(
      faction('a', { harbor: 6 }),
      { id: 'player-alliance', visibility: 'public', actorId: null },
      { channel: 'witnessed', sourceId: null, eventId: 'player-event', tick: TICK },
    );
    assert.deepEqual(plan([informed, faction('b', { harbor: 5 })], 'a')[0]?.knowledgeRefs, [
      'a-intel',
      'player-alliance',
    ]);
  });

  it('leaves the outcome to the engine commit path', () => {
    const actor = faction('a', { harbor: 6 });
    const [proposal] = plan([actor, faction('b', { harbor: 5 })], 'a');
    assert.ok(proposal);
    const commits: WorldCommit[] = [];
    const base = {
      canon,
      actor,
      proposal,
      expectedRevision: canon.revision,
      commit: (c: WorldCommit) => commits.push(c) > 0,
    };
    const blocked = applyProposal({ ...base, check: () => ({ ok: false, reason: 'player held the harbor' }) });
    assert.deepEqual(blocked, { ok: false, reason: 'player held the harbor' });
    assert.equal(commits.length, 0);
    const won = applyProposal({
      ...base,
      check: () => ({ ok: true, costs: { harbor: 2 }, outcome: { gained: 'pier' } }),
    });
    assert.equal(won.ok, true);
    assert.equal(commits[0]?.actor.resources.harbor, 4);
  });
});
