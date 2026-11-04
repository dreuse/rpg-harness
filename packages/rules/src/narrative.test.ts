import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCharacter } from './character-builder.ts';
import { createSeededRng } from './dice.ts';
import { RULE_DSL_VERSION } from './dsl.ts';
import { ADJUDICATED_MODE, adjudicate, NARRATIVE_CREATION, NARRATIVE_MANIFEST } from './narrative.ts';
import { resolveAction } from './resolve.ts';
import { CapabilityDisabledError, requireCapability, validateManifest } from './rulepack.ts';
import type { TraitSheet } from './traits.ts';

const SEED = 7;
const MECHANICAL_CAPABILITIES = ['checks', 'combat', 'resources', 'progression'] as const;
const ADVENTURE = [
  { actionId: 'scene-1', intent: 'talk the guard into opening the gate', outcome: 'the guard relents' },
  { actionId: 'scene-2', intent: 'sneak past the sleeping beast', outcome: 'the beast stirs but stays asleep' },
  { actionId: 'scene-3', intent: 'confront the usurper', outcome: 'the usurper flees the city' },
];

test('R05: run full adventures without mandatory dice, hp, levels, classes or combat', () => {
  assert.deepEqual(validateManifest(NARRATIVE_MANIFEST), { ok: true, manifest: NARRATIVE_MANIFEST });
  for (const capability of MECHANICAL_CAPABILITIES) {
    try {
      assert.equal(requireCapability(NARRATIVE_MANIFEST, capability), ADJUDICATED_MODE);
    } catch (error) {
      assert.ok(error instanceof CapabilityDisabledError);
    }
  }
  const results = ADVENTURE.map(adjudicate);
  assert.deepEqual(
    results,
    ADVENTURE.map((step) => ({ ok: true, adjudication: { mode: ADJUDICATED_MODE, ...step } })),
  );
  assert.deepEqual(adjudicate({ actionId: '', intent: 'x', outcome: '' }), {
    ok: false,
    issues: [
      { path: 'actionId', message: 'must be a non-empty string' },
      { path: 'outcome', message: 'must be a non-empty string' },
    ],
  });
});

test('R05: narrative adjudication is clearly marked rather than masquerading as strict mechanics', () => {
  const [step] = ADVENTURE;
  const narrative = adjudicate(step as (typeof ADVENTURE)[number]);
  assert.ok(narrative.ok);
  assert.equal(narrative.adjudication.mode, ADJUDICATED_MODE);
  for (const key of ['rolls', 'changes', 'sheet', 'events'])
    assert.equal(Object.hasOwn(narrative.adjudication, key), false);
  const strict = resolveAction({
    actionId: 'scene-1',
    rule: { dslVersion: RULE_DSL_VERSION, id: 'noop', effects: [{ kind: 'emitEvent', event: 'done' }] },
    sheet: { characterId: 'hero' as TraitSheet['characterId'], traits: [] },
    rng: createSeededRng(SEED),
  });
  assert.ok(strict.ok);
  assert.equal(Object.hasOwn(strict, 'mode'), false);
  assert.notDeepEqual(Object.keys(narrative).sort(), Object.keys(strict).sort());
});

test('narrative supplies creation rules for a named character with a backstory', () => {
  const result = buildCharacter({
    rules: NARRATIVE_CREATION,
    backstory: 'A drifter.',
    proposal: { name: 'Ash', values: {}, equipment: [] },
  });
  assert.equal(result.status, 'created', JSON.stringify(result));
  const { id, edition, revision } = NARRATIVE_MANIFEST;
  assert.deepEqual(result.status === 'created' ? result.character.profile.rulepack : undefined, {
    id,
    edition,
    revision,
  });
});
