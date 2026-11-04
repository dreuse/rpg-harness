import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Fact } from '../../memory/src/knowledge.ts';
import { canActOn, dialogueContext, knownFacts, learnFact, type NpcState, stanceToward } from './npc.ts';

const CAMPAIGN_ID = 'campaign-1';
const WARDEN_ID = 'npc-warden';
const SMUGGLER_ID = 'npc-smuggler';
const HERO_ID = 'character-hero';
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString'];
const STRANGER_ID = 'character-stranger';
const GOAL = 'protect the vault';
const LEARN_EVENT = 'event-overheard';

const fact = (id: string, overrides: Partial<Fact> = {}): Fact => ({
  id,
  campaignId: CAMPAIGN_ID,
  subjectId: null,
  statement: `statement ${id}`,
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: null,
  ...overrides,
});

const PUBLIC_FACT = fact('fact-gate', { sourceEventId: 'event-gate' });
const RUMOR_FACT = fact('fact-tunnel', { layer: 'rumor' });
const GM_SECRET = fact('fact-secret', { visibility: 'gm', statement: 'warden is the thief' });
const OWN_BELIEF = fact('fact-own', { layer: 'belief', visibility: 'actor-scoped', actorId: WARDEN_ID });
const OTHER_BELIEF = fact('fact-other', { layer: 'belief', visibility: 'actor-scoped', actorId: SMUGGLER_ID });
const FACTS = [PUBLIC_FACT, RUMOR_FACT, GM_SECRET, OWN_BELIEF, OTHER_BELIEF];

const WARDEN: NpcState = {
  id: WARDEN_ID,
  goals: [GOAL],
  disposition: 'calm',
  relationships: { [HERO_ID]: 'friendly' },
  learned: [],
};

test('npc state, memory, relationships and information channels influence dialogue', () => {
  const witnessed = learnFact(WARDEN, PUBLIC_FACT, { channel: 'witnessed', sourceId: null, eventId: LEARN_EVENT });
  const before = dialogueContext(witnessed, FACTS, HERO_ID);

  assert.deepEqual(before.goals, [GOAL]);
  assert.equal(before.disposition, 'calm');
  assert.equal(before.stance, 'friendly');
  assert.deepEqual(before.knownFacts, [
    {
      factId: PUBLIC_FACT.id,
      statement: PUBLIC_FACT.statement,
      channel: 'witnessed',
      sourceId: null,
      reliable: true,
      sourceEventIds: [LEARN_EVENT],
    },
  ]);

  const changed = learnFact(
    { ...witnessed, disposition: 'angry', goals: ['expose the thief'], relationships: { [HERO_ID]: 'hostile' } },
    OWN_BELIEF,
    { channel: 'told', sourceId: SMUGGLER_ID, eventId: null },
  );
  const after = dialogueContext(changed, FACTS, HERO_ID);

  assert.notDeepEqual(after, before);
  assert.equal(after.disposition, 'angry');
  assert.deepEqual(after.goals, ['expose the thief']);
  assert.equal(after.stance, 'hostile');
  assert.deepEqual(
    after.knownFacts.map(({ factId, channel, sourceId }) => [factId, channel, sourceId]),
    [
      [PUBLIC_FACT.id, 'witnessed', null],
      [OWN_BELIEF.id, 'told', SMUGGLER_ID],
    ],
  );
});

test('npcs cannot act on facts they have not learned', () => {
  const tried = [GM_SECRET, OTHER_BELIEF].reduce(
    (npc, hidden) => learnFact(npc, hidden, { channel: 'witnessed', sourceId: null, eventId: null }),
    WARDEN,
  );

  assert.deepEqual(tried.learned, []);
  assert.deepEqual(knownFacts(tried, FACTS), []);
  for (const unlearned of FACTS) {
    assert.equal(canActOn(tried, FACTS, unlearned.id), false);
  }
  const serialized = JSON.stringify(dialogueContext(tried, FACTS, HERO_ID));
  assert.ok(!serialized.includes(GM_SECRET.id));
  assert.ok(!serialized.includes(GM_SECRET.statement));
  assert.ok(!serialized.includes(OTHER_BELIEF.id));

  const learned = learnFact(tried, PUBLIC_FACT, { channel: 'told', sourceId: HERO_ID, eventId: null });
  assert.equal(canActOn(learned, FACTS, PUBLIC_FACT.id), true);
  assert.equal(canActOn(learned, FACTS, GM_SECRET.id), false);

  const hiddenLater = FACTS.map((entry) =>
    entry.id === PUBLIC_FACT.id ? { ...entry, visibility: 'gm' as const } : entry,
  );
  assert.equal(canActOn(learned, hiddenLater, PUBLIC_FACT.id), false);
  assert.equal(canActOn(learned, [], PUBLIC_FACT.id), false);
});

test('unknown relationship defaults to neutral', () => {
  assert.equal(stanceToward(WARDEN, STRANGER_ID), 'neutral');
  assert.equal(dialogueContext(WARDEN, FACTS, STRANGER_ID).stance, 'neutral');
  for (const key of PROTOTYPE_KEYS) assert.equal(stanceToward(WARDEN, key), 'neutral');
  const hostile = { ...WARDEN, relationships: JSON.parse('{"__proto__":"bogus"}') };
  assert.equal(stanceToward(hostile, '__proto__'), 'neutral');
});

test('rumor channel and rumor-layer facts are marked unreliable', () => {
  const rumored = learnFact(WARDEN, PUBLIC_FACT, { channel: 'rumor', sourceId: SMUGGLER_ID, eventId: null });
  const heard = learnFact(rumored, RUMOR_FACT, { channel: 'told', sourceId: HERO_ID, eventId: null });

  assert.deepEqual(
    knownFacts(heard, FACTS).map(({ factId, reliable }) => [factId, reliable]),
    [
      [PUBLIC_FACT.id, false],
      [RUMOR_FACT.id, false],
    ],
  );
});

test('relearning a fact keeps the first channel', () => {
  const first = learnFact(WARDEN, PUBLIC_FACT, { channel: 'witnessed', sourceId: null, eventId: null });
  const again = learnFact(first, PUBLIC_FACT, { channel: 'rumor', sourceId: SMUGGLER_ID, eventId: null });

  assert.equal(again, first);
});

test('invalidated facts are no longer actionable', () => {
  const learned = learnFact(WARDEN, PUBLIC_FACT, { channel: 'witnessed', sourceId: null, eventId: null });
  const invalidated = [{ ...PUBLIC_FACT, layer: 'invalidated' as const }];

  assert.deepEqual(knownFacts(learned, invalidated), []);
  assert.equal(canActOn(learned, invalidated, PUBLIC_FACT.id), false);
});
