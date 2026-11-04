import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Registry } from './registry.ts';
import { resolveRuleset } from './resolver.ts';

const DND = 'dnd';
const PATHFINDER = 'pathfinder';

const REGISTRY: Registry = {
  rulepacks: [
    {
      id: DND,
      edition: '5e',
      revision: '5.1.0',
      capabilities: { dice: true },
      sourceRefs: ['srd:5.1'],
      aliases: ['D&D', 'Dungeons and Dragons'],
    },
    { id: DND, edition: '3.5', revision: '3.5.0', capabilities: {}, sourceRefs: ['srd:3.5'], aliases: ['D&D'] },
    { id: PATHFINDER, edition: '2e', revision: '2.0.0', capabilities: {}, sourceRefs: ['orc:pf2'] },
    { id: 'lancer', edition: '1e', revision: '1.0.0', capabilities: {}, sourceRefs: [] },
    { id: 'dancer', edition: '1e', revision: '0.1.0', capabilities: {}, sourceRefs: [] },
  ],
  genres: [],
};

const DND_OPTIONS = [
  { id: DND, edition: '5e' },
  { id: DND, edition: '3.5' },
];

test('N04 resolve exact, aliased, misspelled and ambiguous rpg version requests', () => {
  const exact = resolveRuleset(REGISTRY, { id: DND, edition: '5e' }, ['dice']);
  assert.equal(exact.status, 'resolved');
  assert.ok(exact.status === 'resolved');
  assert.equal(exact.match, 'exact');
  assert.equal(exact.rulepack.revision, '5.1.0');
  assert.deepEqual(exact.rulepack.sourceRefs, ['srd:5.1']);
  assert.deepEqual(exact.capabilities.supported, ['dice']);

  for (const [id, edition] of [
    ['D&D', 'fifth edition'],
    ['dnd', '5th'],
    ['Dungeons & Dragons', '5th Edition'],
  ] as const) {
    const aliased = resolveRuleset(REGISTRY, { id, edition });
    assert.ok(aliased.status === 'resolved', `${id} ${edition}`);
    assert.equal(aliased.match, 'alias');
    assert.equal(aliased.rulepack.edition, '5e');
  }

  const second = resolveRuleset(REGISTRY, { id: 'Pathfinder', edition: '2nd' });
  assert.ok(second.status === 'resolved');
  assert.equal(second.match, 'alias');
  assert.equal(second.rulepack.revision, '2.0.0');

  const typo = resolveRuleset(REGISTRY, { id: 'pathfidner', edition: '2e' });
  assert.ok(typo.status === 'resolved');
  assert.equal(typo.match, 'fuzzy');
  assert.equal(typo.rulepack.id, PATHFINDER);

  assert.deepEqual(resolveRuleset(REGISTRY, { id: 'rancer', edition: '1e' }), {
    status: 'ambiguous',
    requested: { id: 'rancer', edition: '1e' },
    candidates: [
      { id: 'lancer', edition: '1e' },
      { id: 'dancer', edition: '1e' },
    ],
  });
  assert.deepEqual(resolveRuleset(REGISTRY, { id: 'D&D', edition: null }), {
    status: 'ambiguous',
    requested: { id: 'D&D', edition: null },
    candidates: DND_OPTIONS,
  });
});

test("N04 unknown 'd&d 1.9' requests clarification rather than guessing official mechanics", () => {
  const requested = { id: 'd&d', edition: '1.9' };
  assert.deepEqual(resolveRuleset(REGISTRY, requested), {
    status: 'clarification_needed',
    reason: 'unknown_edition',
    requested,
    available: DND_OPTIONS,
  });
  assert.deepEqual(resolveRuleset(REGISTRY, { id: 'dnd', edition: 'fith edition' }), {
    status: 'clarification_needed',
    reason: 'unknown_edition',
    requested: { id: 'dnd', edition: 'fith edition' },
    available: DND_OPTIONS,
  });
  const unknown = resolveRuleset(REGISTRY, { id: 'Mothership', edition: '1e' });
  assert.equal(unknown.status, 'clarification_needed');
  assert.ok(unknown.status === 'clarification_needed');
  assert.equal(unknown.reason, 'unknown_system');
  assert.equal(unknown.available.length, REGISTRY.rulepacks.length);
  assert.equal(resolveRuleset(REGISTRY, { id: 'dd', edition: '5e' }).status, 'clarification_needed');
});
