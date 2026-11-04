import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Visibility } from '../../domain/src/entity.ts';
import {
  beliefsOf,
  canonicalFacts,
  type Fact,
  GM_VIEWER,
  gmSecrets,
  PLAYER_VIEWER,
  type Viewer,
  visibleTo,
} from './knowledge.ts';

const CAMPAIGN_ID = 'campaign-1';
const INNKEEPER = 'npc-innkeeper';
const SMITH = 'npc-smith';
const RUMOR_STATEMENT = 'The mayor is a vampire';
const UNKNOWN_VISIBILITY = 'everyone' as Visibility;
const UNKNOWN_SCOPE = { scope: 'spectator' } as unknown as Viewer;
const EMPTY_ACTOR = '';

const CANON: Fact = {
  id: 'fact-canon',
  campaignId: CAMPAIGN_ID,
  subjectId: null,
  statement: 'The bridge collapsed at dawn',
  layer: 'canon',
  visibility: 'public',
  actorId: null,
  sourceEventId: 'event-1',
};
const PLAYER_CLUE: Fact = {
  ...CANON,
  id: 'fact-clue',
  statement: 'The ledger is missing a page',
  visibility: 'player',
};
const SECRET: Fact = { ...CANON, id: 'fact-secret', statement: 'The mayor hired the cult', visibility: 'gm' };
const INNKEEPER_BELIEF: Fact = {
  ...CANON,
  id: 'fact-belief',
  statement: 'The smith is honest',
  layer: 'belief',
  visibility: 'actor-scoped',
  actorId: INNKEEPER,
};
const INNKEEPER_RUMOR: Fact = {
  ...INNKEEPER_BELIEF,
  id: 'fact-rumor-1',
  statement: RUMOR_STATEMENT,
  layer: 'rumor',
};
const SMITH_RUMOR: Fact = { ...INNKEEPER_RUMOR, id: 'fact-rumor-2', actorId: SMITH };
const HEARD_RUMOR: Fact = { ...INNKEEPER_RUMOR, id: 'fact-rumor-3', visibility: 'player', actorId: null };
const FACTS = [CANON, PLAYER_CLUE, SECRET, INNKEEPER_BELIEF, INNKEEPER_RUMOR, SMITH_RUMOR, HEARD_RUMOR];
const ids = (facts: readonly Fact[]) => facts.map((fact) => fact.id);

test('separate canonical facts, character beliefs, player-known facts and gm secrets', () => {
  assert.deepEqual(ids(canonicalFacts(FACTS, GM_VIEWER)), [CANON.id, PLAYER_CLUE.id, SECRET.id]);
  assert.deepEqual(ids(beliefsOf(FACTS, INNKEEPER, GM_VIEWER)), [INNKEEPER_BELIEF.id, INNKEEPER_RUMOR.id]);
  assert.deepEqual(ids(visibleTo(FACTS, PLAYER_VIEWER)), [CANON.id, PLAYER_CLUE.id, HEARD_RUMOR.id]);
  assert.deepEqual(ids(gmSecrets(FACTS, GM_VIEWER)), [SECRET.id]);
  assert.deepEqual(ids(visibleTo(FACTS, GM_VIEWER)), ids(FACTS));
  assert.deepEqual(ids(visibleTo(FACTS, { scope: 'actor', actorId: SMITH })), [CANON.id, SMITH_RUMOR.id]);
});

test('an npc rumor is not promoted to truth; player tools cannot retrieve secret facts', () => {
  const canon = canonicalFacts(FACTS, GM_VIEWER);
  assert.equal(
    canon.some((fact) => fact.statement === RUMOR_STATEMENT),
    false,
  );
  const tampered: Fact = { ...SECRET, id: 'fact-tampered', visibility: UNKNOWN_VISIBILITY };
  const playerView = visibleTo([...FACTS, tampered], PLAYER_VIEWER);
  assert.equal(
    playerView.some((fact) => fact.visibility === 'gm' || fact.visibility === 'actor-scoped'),
    false,
  );
  assert.equal(playerView.includes(tampered), false);
  assert.equal(visibleTo([...FACTS, tampered], GM_VIEWER).includes(tampered), false);
  assert.deepEqual(visibleTo(FACTS, UNKNOWN_SCOPE), []);
});

test('scope queries apply the viewer visibility filter', () => {
  assert.deepEqual(ids(canonicalFacts(FACTS, PLAYER_VIEWER)), [CANON.id, PLAYER_CLUE.id]);
  assert.deepEqual(beliefsOf(FACTS, INNKEEPER, PLAYER_VIEWER), []);
  assert.deepEqual(gmSecrets(FACTS, PLAYER_VIEWER), []);
  assert.deepEqual(gmSecrets(FACTS, { scope: 'actor', actorId: INNKEEPER }), []);
  assert.deepEqual(visibleTo(FACTS, { scope: 'actor', actorId: EMPTY_ACTOR }), []);
});
