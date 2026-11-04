import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Visibility } from '../../domain/src/entity.ts';
import { loadGenrePack } from './genrepack.ts';
import { loadInvestigationKit, openBeats, scopedKnowledge, tensionCue } from './investigation.ts';
import { HORROR_PACK, MYSTERY_PACK } from './packs.ts';

const PLAYER_READABLE: readonly Visibility[] = ['public', 'player'];

const loadKit = (input: unknown) => {
  const result = loadInvestigationKit(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('kit failed to load');
  return result.kit;
};

const issuePaths = (input: unknown) => {
  const result = loadInvestigationKit(input);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

test('provide tension, clue tracking, information concealment and investigation pacing', () => {
  for (const pack of [HORROR_PACK, MYSTERY_PACK]) {
    assert.equal(loadGenrePack(pack.genre).ok, true);
    const kit = loadKit(pack.investigation);
    assert.equal(tensionCue(kit, kit.tension.start - 1), null);
    assert.equal(typeof tensionCue(kit, kit.tension.max), 'string');
    const [firstClue] = kit.clues;
    assert.ok(firstClue);
    const before = scopedKnowledge(kit, []).find((item) => item.id === firstClue.id);
    const after = scopedKnowledge(kit, [firstClue.id]).find((item) => item.id === firstClue.id);
    assert.equal(before?.visibility, 'gm');
    assert.equal(after?.visibility, 'player');
    const allClues = kit.clues.map((clue) => clue.id);
    assert.ok(openBeats(kit, []).length < openBeats(kit, allClues).length);
    assert.equal(openBeats(kit, allClues).length, kit.pacing.length);
  }
});

test('secret solutions cannot leak through generic memory retrieval', () => {
  for (const pack of [HORROR_PACK, MYSTERY_PACK]) {
    const kit = loadKit(pack.investigation);
    const allClues = kit.clues.map((clue) => clue.id);
    const knowledge = scopedKnowledge(kit, allClues);
    const playerVisible = knowledge.filter((item) => PLAYER_READABLE.includes(item.visibility));
    for (const secret of kit.secrets) {
      assert.equal(secret.visibility, 'gm');
      assert.equal(secret.actorId, null);
      assert.equal(
        playerVisible.some((item) => item.statement === secret.statement),
        false,
      );
    }
  }
  const leaky = structuredClone(MYSTERY_PACK.investigation);
  Object.assign(leaky.secrets[0] as object, { visibility: 'public' });
  assert.deepEqual(issuePaths(leaky), ['secrets.0.visibility']);
});

test('rejects dangling references and unknown fields', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  Object.assign(kit.clues[0] as object, { pointsTo: 'nowhere' });
  Object.assign(kit.pacing[0] as object, { requiresClues: ['ghost'] });
  assert.deepEqual(issuePaths({ ...kit, script: 'x' }), ['script', 'clues.0.pointsTo', 'pacing.0.requiresClues.0']);
});

test('rejects an invalid tension track', () => {
  const kit = structuredClone(HORROR_PACK.investigation);
  assert.deepEqual(issuePaths({ ...kit, tension: { ...kit.tension, start: kit.tension.max + 1 } }), ['tension.start']);
  assert.deepEqual(issuePaths({ ...kit, tension: { ...kit.tension, min: 0.5 } }), ['tension.min']);
});

test('rejects a secret no clue points to', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  kit.secrets.push({ id: 'orphan', statement: 'Unreachable truth' });
  assert.deepEqual(issuePaths(kit), ['secrets.2']);
});

test('rejects duplicate clue ids', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  Object.assign(kit.clues[3] as object, { id: kit.clues[2]?.id });
  assert.deepEqual(issuePaths(kit), ['clues.3.id']);
});

test('rejects duplicate secret ids', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  kit.secrets.push({ id: 'culprit', statement: 'A second culprit' });
  assert.deepEqual(issuePaths(kit), ['secrets.2.id']);
});

test('rejects duplicate beat ids', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  Object.assign(kit.pacing[1] as object, { id: kit.pacing[0]?.id });
  assert.deepEqual(issuePaths(kit), ['pacing.1.id']);
});

test('rejects a clue id that equals a secret id', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  kit.clues.push({ id: 'motive', text: 'Shares a secret id', pointsTo: 'motive' });
  assert.deepEqual(issuePaths(kit), ['clues.4.id']);
});

test('rejects array holes in record lists', () => {
  const kit = structuredClone(MYSTERY_PACK.investigation);
  const clues: unknown[] = [...kit.clues];
  clues.length = clues.length + 1;
  assert.deepEqual(issuePaths({ ...kit, clues }), ['clues.4']);
});

test('returns a frozen kit', () => {
  const kit = loadKit(HORROR_PACK.investigation);
  assert.equal(Object.isFrozen(kit), true);
  assert.equal(Object.isFrozen(kit.secrets[0]), true);
  assert.equal(Object.isFrozen(kit.pacing[0]?.requiresClues), true);
});
