import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modelContinuityCheckOf } from './gm-continuity.ts';
import { claimDraftOf, proposalsOf } from './gm-proposals.ts';

const NARRATION = 'Mara hands you the lantern.';
const FACT = 'Mara is dead';
const FACTS = [FACT];

describe('rpg-42a.62 model continuity check', () => {
  it('asks the model with the narration and facts and maps its conflicts', async () => {
    const asked: unknown[] = [];
    const check = modelContinuityCheckOf(async (system, content) => {
      asked.push(system, content);
      return `\`\`\`json\n[{"fact":"${FACT}","excerpt":"${NARRATION}"}]\n\`\`\``;
    });
    const found = await check({ narration: NARRATION, facts: FACTS });
    assert.deepEqual(found, [{ kind: 'model', entityId: null, fact: FACT, excerpt: NARRATION }]);
    assert.ok(String(asked[1]).includes(NARRATION));
    assert.ok(String(asked[1]).includes(FACT));
  });

  it('finds nothing in a malformed or partial reply', async () => {
    for (const reply of ['', 'no conflicts', '[1, "x", {"fact": 3}]', '{"fact":"a"}']) {
      const check = modelContinuityCheckOf(async () => reply);
      assert.deepEqual(await check({ narration: NARRATION, facts: FACTS }), [], reply);
    }
  });

  it('skips the model call when there are no facts', async () => {
    const check = modelContinuityCheckOf(async () => assert.fail('no call expected'));
    assert.deepEqual(await check({ narration: NARRATION, facts: [] }), []);
  });
});

describe('rpg-42a.62 claim proposals', () => {
  const CLAIM = { kind: 'claim', id: 'mara-dead', entityId: 'mara', claimKind: 'alive', value: 'dead' };

  it('parses a claim proposal and turns it into a claim draft', () => {
    const [proposal] = proposalsOf({ proposals: [{ ...CLAIM, visibility: 'gm' }] }) ?? [];
    assert.deepEqual(proposal, { ...CLAIM, visibility: 'gm' });
    assert.deepEqual(claimDraftOf(proposal as never), {
      entityId: 'mara',
      kind: 'alive',
      value: 'dead',
      visibility: 'gm',
    });
  });

  it('leaves visibility to the engine default when the GM gives none', () => {
    const [proposal] = proposalsOf({ proposals: [CLAIM] }) ?? [];
    assert.equal((proposal as { visibility?: string }).visibility, undefined);
  });

  it('rejects unknown kinds, blank values and stray keys', () => {
    for (const bad of [
      { ...CLAIM, claimKind: 'mood' },
      { ...CLAIM, value: ' ' },
      { ...CLAIM, extra: 1 },
      { ...CLAIM, visibility: 'public' },
    ])
      assert.equal(proposalsOf({ proposals: [bad] }), undefined, JSON.stringify(bad));
  });
});
