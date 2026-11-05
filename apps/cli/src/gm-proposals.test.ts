import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { pendingOf } from '../../../packages/memory/src/graph.ts';
import { openDatabase } from '../../../packages/persistence/src/database.ts';
import { createEntityStore, createFactStore } from '../../../packages/persistence/src/entity-store.ts';
import {
  createEngineGateway,
  FAKE_GAME_MASTER,
  type GameMaster,
  openClientSession,
  readCampaignState,
} from './engine-gateway.ts';
import {
  MAX_FACT_LENGTH,
  MAX_FACTS,
  MAX_NAME_LENGTH,
  MAX_PROPOSALS,
  PROPOSALS_SCHEMA,
  proposalsOf,
} from './gm-proposals.ts';
import { SEGMENTS_SCHEMA } from './gm-segments.ts';

const CAMPAIGN = 'proposals';
const NARRATION = 'A stranger by the fire nods at you.';
const ACTION = 'I sit by the fire';
const NO_CHARACTER = async () => undefined;
const STRANGER = {
  kind: 'entity',
  id: 'stranger',
  entityKind: 'npc',
  name: 'Old Stranger',
  facts: ['Wears a grey cloak.'],
};
const DEBT = {
  kind: 'pending',
  id: 'debt',
  pendingKind: 'promise',
  text: 'Repay the stranger.',
  entityIds: ['stranger'],
};

const ATTACK_CHECK = {
  kind: 'check',
  id: 'tam-attack',
  ruleId: 'attack.melee',
  target: 'Old Tam',
  label: 'Attack Old Tam with your sword',
};
const HIT_OUTCOME = { kind: 'outcome', id: 'tam-hit', text: 'a hit on Old Tam' };

const tempDataDir = (t: TestContext) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'rpg-proposals-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

const narratedWith = async (t: TestContext, proposals: unknown) => {
  const dataDir = tempDataDir(t);
  for await (const _ of createEngineGateway(dataDir).create(CAMPAIGN, undefined, NO_CHARACTER));
  const gm: GameMaster = {
    request: async () => ({
      narration: NARRATION,
      segments: [{ text: NARRATION }],
      proposals: proposalsOf({ proposals }) ?? [],
    }),
    summarizer: FAKE_GAME_MASTER.summarizer,
  };
  const { session, campaignId, close, narrate } = openClientSession(dataDir, CAMPAIGN, gm);
  t.after(close);
  const envelope = { version: PROTOCOL_VERSION, campaignId } as const;
  const before = session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' });
  assert.ok(before.ok);
  const submitted = session.submitPlayerAction({
    ...envelope,
    type: 'SubmitPlayerAction',
    actionId: randomUUID(),
    expectedRevision: before.value.revision,
    sceneId: before.value.currentScene?.id ?? '',
    actorId: before.value.characters[0]?.id ?? '',
    input: ACTION,
  });
  assert.ok(submitted.ok);
  await narrate();
  const connection = openDatabase(join(dataDir, `${CAMPAIGN}.sqlite`));
  t.after(() => connection.close());
  const state = readCampaignState(dataDir, CAMPAIGN);
  const { database } = connection;
  return {
    state,
    entities: createEntityStore(database).listEntities(state.campaign.id),
    facts: createFactStore(database).listFacts(state.campaign.id),
    pending: pendingOf(state.events),
    snapshot: session.getSnapshot({ ...envelope, type: 'GetCampaignSnapshot' }),
  };
};

describe('rpg-42a.43 GM proposals', () => {
  it('parses valid entity and pending proposals', () => {
    assert.deepEqual(proposalsOf({ proposals: [STRANGER, DEBT] }), [
      { ...STRANGER, visibility: 'player' },
      { ...DEBT, visibility: 'player' },
    ]);
  });

  it('ignores an absent or empty proposal list', () => {
    assert.equal(proposalsOf({}), undefined);
    assert.equal(proposalsOf({ proposals: [] }), undefined);
    assert.equal(proposalsOf('proposals'), undefined);
  });

  it('parses a check proposal and a declared outcome', () => {
    assert.deepEqual(proposalsOf({ proposals: [ATTACK_CHECK, HIT_OUTCOME] }), [ATTACK_CHECK, HIT_OUTCOME]);
  });

  const invalid: readonly [string, unknown][] = [
    ['check without a rule', [{ ...ATTACK_CHECK, ruleId: undefined }]],
    ['check with a spaced rule', [{ ...ATTACK_CHECK, ruleId: 'attack melee' }]],
    ['check without a target', [{ ...ATTACK_CHECK, target: ' ' }]],
    ['check with an unknown key', [{ ...ATTACK_CHECK, dc: 1 }]],
    ['outcome without text', [{ ...HIT_OUTCOME, text: '' }]],
    ['outcome with an unknown key', [{ ...HIT_OUTCOME, damage: 5 }]],
    ['not a list', 'oops'],
    ['unknown kind', [{ ...STRANGER, kind: 'tool_call' }]],
    ['unknown key', [{ ...STRANGER, run: 'rm -rf /' }]],
    ['character entity', [{ ...STRANGER, entityKind: 'character' }]],
    ['bad id', [{ ...STRANGER, id: 'Has Spaces' }]],
    ['blank name', [{ ...STRANGER, name: '  ' }]],
    ['long name', [{ ...STRANGER, name: 'x'.repeat(MAX_NAME_LENGTH + 1) }]],
    ['long fact', [{ ...STRANGER, facts: ['x'.repeat(MAX_FACT_LENGTH + 1)] }]],
    ['too many facts', [{ ...STRANGER, facts: Array.from({ length: MAX_FACTS + 1 }, () => 'fact') }]],
    ['public visibility', [{ ...STRANGER, visibility: 'public' }]],
    ['unknown pending kind', [{ ...DEBT, pendingKind: 'curse' }]],
    ['pending without entities', [{ ...DEBT, entityIds: [] }]],
    ['too many proposals', Array.from({ length: MAX_PROPOSALS + 1 }, (_, index) => ({ ...STRANGER, id: `n${index}` }))],
    ['one bad proposal among good ones', [STRANGER, { ...DEBT, text: '' }]],
  ];
  for (const [name, proposals] of invalid)
    it(`rejects the whole batch: ${name}`, () => assert.equal(proposalsOf({ proposals }), undefined));

  it('adds the proposal format to the GM output schema without requiring it', () => {
    assert.equal(SEGMENTS_SCHEMA.properties.proposals, PROPOSALS_SCHEMA);
    assert.deepEqual(SEGMENTS_SCHEMA.required, ['segments']);
  });

  it('commits entities, facts and pending items through the engine and hides the turns', async (t) => {
    const { state, entities, facts, pending, snapshot } = await narratedWith(t, [STRANGER, DEBT]);
    assert.deepEqual(
      entities.map(({ id, kind, name, visibility }) => ({ id, kind, name, visibility })),
      [{ id: 'stranger', kind: 'npc', name: 'Old Stranger', visibility: 'player' }],
    );
    assert.deepEqual(
      facts.map(({ statement, subjectId, layer }) => ({ statement, subjectId, layer })),
      [{ statement: 'Wears a grey cloak.', subjectId: 'stranger', layer: 'canon' }],
    );
    assert.deepEqual(
      pending.map(({ id, kind, entityIds }) => ({ id, kind, entityIds })),
      [{ id: 'debt', kind: 'promise', entityIds: ['stranger'] }],
    );
    assert.ok(snapshot.ok);
    assert.equal(snapshot.value.turns.at(-1)?.narration, NARRATION);
    assert.equal(state.turns.length, snapshot.value.turns.length + 2);
  });

  it('skips a pending item that links an unknown entity and keeps the narration', async (t) => {
    const { entities, pending, snapshot } = await narratedWith(t, [{ ...DEBT, entityIds: ['ghost'] }]);
    assert.deepEqual(entities, []);
    assert.deepEqual(pending, []);
    assert.ok(snapshot.ok);
    assert.equal(snapshot.value.turns.at(-1)?.narration, NARRATION);
  });

  it('skips an entity whose id already exists without a partial commit', async (t) => {
    const { entities, facts } = await narratedWith(t, [STRANGER, { ...STRANGER, name: 'Impostor', facts: ['Lies.'] }]);
    assert.deepEqual(
      entities.map(({ name }) => name),
      ['Old Stranger'],
    );
    assert.deepEqual(
      facts.map(({ statement }) => statement),
      ['Wears a grey cloak.'],
    );
  });

  it('commits nothing when the batch is invalid', async (t) => {
    const { entities, pending } = await narratedWith(t, [STRANGER, { ...DEBT, pendingKind: 'curse' }]);
    assert.deepEqual(entities, []);
    assert.deepEqual(pending, []);
  });
});
