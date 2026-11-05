import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLedger, CLAIM_RECORDED, type Directory } from '../../memory/src/ledger.ts';
import {
  type ContinuityConflict,
  type ContinuityLogRecord,
  checkContinuity,
  enforceContinuity,
  MAX_CONTINUITY_RETRIES,
} from './continuity.ts';

const MAREN = 'maren';
const ASH = 'ash';
const DIRECTORY: Directory = new Map([
  [MAREN, { name: 'Maren', kind: 'npc' }],
  [ASH, { name: 'Ash', kind: 'character' }],
]);

const claim = (id: string, entityId: string, kind: string, value: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: CLAIM_RECORDED,
  payload: { entityId, kind, key: kind, value, visibility: 'public', actorId: null, ...extra },
});

const LEDGER = buildLedger([
  claim('e1', MAREN, 'alive', 'dead'),
  claim('e2', ASH, 'item', 'not-held', { key: 'silver dagger' }),
  claim('e3', MAREN, 'name', 'Maren'),
  claim('e4', ASH, 'place', 'Harbor'),
  claim('e5', MAREN, 'secret', 'Maren served the cult', { key: 'loyalty', visibility: 'gm' }),
]);

const kinds = (narration: string, ledger = LEDGER) =>
  checkContinuity({ narration, ledger, directory: DIRECTORY }).map(({ kind }) => kind);

test('rpg-42a.42 a dead entity that speaks or acts is a conflict, a mention of the body is not', () => {
  assert.deepEqual(kinds('Maren smiles and says the harbor is safe.'), ['dead-acts']);
  assert.deepEqual(kinds('Ash kneels beside the body of Maren.'), []);
  assert.deepEqual(kinds('Ash remembers the grave where Maren was buried.'), []);
});

test('rpg-42a.42 an item the holder no longer has cannot be used by them', () => {
  assert.deepEqual(kinds('Ash draws the silver dagger and lunges.'), ['item-not-held']);
  assert.deepEqual(kinds('Ash looks for the silver dagger in vain.'), []);
});

test('rpg-42a.42 a superseded name and a superseded place are caught', () => {
  const renamed = buildLedger([
    claim('e1', MAREN, 'name', 'Mara'),
    claim('e2', MAREN, 'name', 'Maren'),
    claim('e3', ASH, 'place', 'Mill'),
    claim('e4', ASH, 'place', 'Harbor'),
  ]);
  assert.deepEqual(kinds('Mara waves from the dock.', renamed), ['stale-name']);
  assert.deepEqual(kinds('Maren waves from the dock.', renamed), []);
  assert.deepEqual(kinds('Ash is at the Mill, counting sacks.', renamed), ['wrong-place']);
  assert.deepEqual(kinds('Ash is at the Harbor, counting sacks.', renamed), []);
});

test('rpg-42a.42 a gm-only secret restated in narration is a leak', () => {
  assert.deepEqual(kinds('Whispers say Maren served the cult.'), ['secret-leak']);
});

test('rpg-42a.42 conflicts carry the canonical fact and the offending sentence', () => {
  const [conflict] = checkContinuity({
    narration: 'The rain falls. Maren smiles and says hello. Night comes.',
    ledger: LEDGER,
    directory: DIRECTORY,
  });
  assert.equal(conflict?.fact, 'Maren alive: dead');
  assert.equal(conflict?.excerpt, 'Maren smiles and says hello.');
});

const CONTRADICTION = 'Maren smiles and says hello.';
const CLEAN = 'Ash stands alone beside the grave of Maren.';

const run = (replies: readonly string[], extra: Partial<Parameters<typeof enforceContinuity>[0]> = {}) => {
  const seen: (readonly ContinuityConflict[])[] = [];
  const logs: ContinuityLogRecord[] = [];
  let next = 0;
  const outcome = enforceContinuity({
    generate: (conflicts) => {
      seen.push(conflicts);
      return replies[Math.min(next++, replies.length - 1)] ?? '';
    },
    ledger: LEDGER,
    directory: DIRECTORY,
    log: (record) => logs.push(record),
    ...extra,
  });
  return { outcome, seen, logs };
};

test('rpg-42a.42 clean narration is generated once and nothing is logged', async () => {
  const { outcome, seen, logs } = run([CLEAN]);
  assert.deepEqual(await outcome, { narration: CLEAN, conflicts: [], regenerations: 0, resolved: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(logs, []);
});

test('rpg-42a.42 a conflict regenerates once with the conflicting facts listed', async () => {
  const { outcome, seen, logs } = run([CONTRADICTION, CLEAN]);
  const result = await outcome;
  assert.equal(result.narration, CLEAN);
  assert.equal(result.regenerations, 1);
  assert.equal(result.resolved, true);
  assert.deepEqual(seen[0], []);
  assert.deepEqual(
    seen[1]?.map(({ fact }) => fact),
    ['Maren alive: dead'],
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.resolved, true);
});

test('rpg-42a.42 a conflict that survives gets canonical facts over the narration and is logged', async () => {
  const { outcome, seen, logs } = run([CONTRADICTION]);
  const result = await outcome;
  assert.equal(seen.length, 1 + MAX_CONTINUITY_RETRIES);
  assert.equal(result.resolved, false);
  assert.equal(result.narration.includes(CONTRADICTION), false);
  assert.ok(result.narration.includes('Maren alive: dead'));
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.resolved, false);
  assert.equal(logs[0]?.conflicts[0]?.kind, 'dead-acts');
});

test('rpg-42a.42 a surviving secret leak is cut, not annotated with the secret', async () => {
  const { outcome } = run(['The rain falls. Whispers say Maren served the cult. Night comes.']);
  const result = await outcome;
  assert.equal(result.narration.includes('cult'), false);
  assert.ok(result.narration.includes('The rain falls.'));
});

test('rpg-42a.42 a cheap model check adds conflicts and its failure never blocks narration', async () => {
  const model = (): readonly ContinuityConflict[] => [
    { kind: 'model', entityId: MAREN, fact: 'Maren alive: dead', excerpt: '' },
  ];
  const flagged = await run([CLEAN, CLEAN], { modelCheck: model }).outcome;
  assert.equal(flagged.resolved, false);
  assert.equal(flagged.regenerations, MAX_CONTINUITY_RETRIES);
  const broken = await run([CLEAN], {
    modelCheck: () => {
      throw new Error('offline');
    },
  }).outcome;
  assert.equal(broken.resolved, true);
  assert.equal(broken.narration, CLEAN);
});

const HIDDEN_DEATH = buildLedger([claim('h1', MAREN, 'alive', 'dead', { visibility: 'gm' })]);

test('rpg-42a.42 a surviving conflict about a GM-only fact is cut, never quoted or appended', async () => {
  const { outcome, seen } = run([CONTRADICTION], { ledger: HIDDEN_DEATH });
  const result = await outcome;
  assert.equal(result.resolved, false);
  assert.equal(result.narration.includes('dead'), false);
  assert.equal(result.narration.includes('alive'), false);
  assert.equal(result.narration.includes(CONTRADICTION), false);
  assert.equal(result.conflicts[0]?.hidden, true);
  assert.equal(seen[1]?.[0]?.fact, 'Maren alive: dead');
});

test('rpg-42a.42 a model conflict with no sentence to cut adds nothing hidden to the narration', async () => {
  const model = (): readonly ContinuityConflict[] => [
    { kind: 'model', entityId: MAREN, fact: 'Maren alive: dead', excerpt: '', hidden: true },
  ];
  const result = await run([CLEAN, CLEAN], { ledger: HIDDEN_DEATH, modelCheck: model }).outcome;
  assert.equal(result.narration, CLEAN);
});

test('rpg-42a.42 only secret claims count as leaks and only as whole words', () => {
  const ledger = buildLedger([
    claim('s1', MAREN, 'secret', 'cult', { key: 'loyalty', visibility: 'gm' }),
    claim('s2', ASH, 'item', 'held', { key: 'ring', visibility: 'gm' }),
  ]);
  const found = (narration: string) =>
    checkContinuity({ narration, ledger, directory: DIRECTORY }).map(({ kind }) => kind);
  assert.deepEqual(found('They cultivate wheat and she stood beheld by all.'), []);
  assert.deepEqual(found('Whispers of the cult grow.'), ['secret-leak']);
});

test('rpg-42a.42 a hidden conflict is marked, a visible one is not', () => {
  const [visible] = checkContinuity({ narration: CONTRADICTION, ledger: LEDGER, directory: DIRECTORY });
  assert.equal(visible?.hidden, false);
});

const GM_NAME = 'Malgrith the Lich';
const NAMED_LEDGER = buildLedger([
  claim('n1', MAREN, 'alive', 'dead'),
  claim('n2', MAREN, 'name', GM_NAME, { visibility: 'gm' }),
  claim('n3', MAREN, 'secret', 'sworn to the cult', { key: 'loyalty', visibility: 'gm' }),
]);

const flagging =
  (excerpt: string, fact: (facts: readonly string[]) => string) =>
  ({ facts }: { readonly facts: readonly string[] }): readonly ContinuityConflict[] => [
    { kind: 'model', entityId: MAREN, fact: fact(facts), excerpt, hidden: false },
  ];

test('rpg-42a.42 the model sees player-visible facts under the visible name and its echo is quoted safely', async () => {
  const given: (readonly string[])[] = [];
  const result = await run(['Maren waves at Ash.'], {
    ledger: NAMED_LEDGER,
    modelCheck: ({ facts }) => {
      given.push(facts);
      return [{ kind: 'model', entityId: MAREN, fact: facts[0] ?? '', excerpt: 'Maren waves at Ash.' }];
    },
  }).outcome;
  assert.ok(given[0]?.includes('Maren alive: dead'));
  assert.equal(result.narration.includes('Malgrith'), false);
  assert.ok(result.narration.includes('Maren alive: dead'));
});

test('rpg-42a.42 a model echo of a GM-only name or a paraphrased secret is cut, not quoted', async () => {
  const echo = await run(['Maren waves at Ash.'], {
    ledger: NAMED_LEDGER,
    modelCheck: flagging('Maren waves at Ash.', () => `${GM_NAME} alive: dead`),
  }).outcome;
  assert.equal(echo.narration.includes('Malgrith'), false);
  assert.equal(echo.narration.includes('Maren waves'), false);
  const paraphrase = await run(['Rumor says Maren is a cultist. Night comes.'], {
    ledger: NAMED_LEDGER,
    modelCheck: flagging('Maren is a cultist', () => 'Maren secretly serves the cult'),
  }).outcome;
  assert.equal(paraphrase.narration.includes('cult'), false);
  assert.ok(paraphrase.narration.includes('Night comes.'));
});

test('rpg-42a.42 a hidden model conflict removes the whole sentence even when the excerpt is a fragment', async () => {
  const text = `Whispers say ${GM_NAME} serves the cult in secret. Night comes.`;
  const result = await run([text], {
    ledger: NAMED_LEDGER,
    modelCheck: flagging('serves the cult', () => 'Maren secretly serves the cult'),
  }).outcome;
  assert.equal(result.narration.includes('Malgrith'), false);
  assert.equal(result.narration.includes('cult'), false);
  assert.ok(result.narration.includes('Night comes.'));
});

test('rpg-42a.42 a hidden model conflict whose excerpt is not in the text drops the sentences that share its words', async () => {
  const text = `The wind rises. Whispers say ${GM_NAME} is in the cult. Night comes.`;
  const result = await run([text], {
    ledger: NAMED_LEDGER,
    modelCheck: flagging('Malgrith joins the cult', () => 'Maren secretly serves the cult'),
  }).outcome;
  assert.equal(result.narration.includes('Malgrith'), false);
  assert.ok(result.narration.includes('The wind rises.'));
  assert.ok(result.narration.includes('Night comes.'));
});
