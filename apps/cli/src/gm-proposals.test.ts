import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import { MAX_ROLL_EXPRESSION_LENGTH } from '../../../packages/engine/src/gm-roll.ts';
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
  MAX_MOOD_TAGS,
  MAX_NAME_LENGTH,
  MAX_PROPOSALS,
  MAX_TAG_LENGTH,
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
const TAM_ATTACK_ROLL = {
  kind: 'gm-roll',
  id: 'tam-swing',
  roller: 'old-tam',
  reason: 'Tam swings his cudgel',
  visibility: 'shown',
  ruleId: 'attack.melee',
};
const SECRET_LISTEN = {
  kind: 'gm-roll',
  id: 'hidden-listen',
  roller: 'gm',
  reason: 'Does Tam hear the lock click',
  visibility: 'secret',
  expression: '1d20+2',
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

  it('rpg-cm63.41 parses the location kind and mood tags of a place', () => {
    const place = { ...STRANGER, entityKind: 'location', locationKind: 'tavern', mood: ['tense', 'rain'] };
    assert.deepEqual(proposalsOf({ proposals: [place] }), [{ ...place, visibility: 'player' }]);
  });

  it('rpg-cm63.44 parses voice traits on an npc proposal and a traits proposal for an existing npc', () => {
    const voiceTraits = { gender: 'female', age: 'old', manner: 'warm' };
    const traited = { ...STRANGER, voiceTraits };
    const later = { kind: 'voice-traits', id: 'stranger-voice', entityId: 'stranger', voiceTraits };
    assert.deepEqual(proposalsOf({ proposals: [traited, later] }), [{ ...traited, visibility: 'player' }, later]);
  });

  it('rpg-cm63.44 drops unknown trait values and junk instead of rejecting the proposal', () => {
    const mixed = { ...STRANGER, voiceTraits: { gender: 'robot', age: 'old', manner: 'sleepy', volume: 11 } };
    assert.deepEqual(proposalsOf({ proposals: [mixed] }), [
      { ...STRANGER, voiceTraits: { age: 'old' }, visibility: 'player' },
    ]);
    for (const junk of ['female', 7, [], { gender: 'robot' }])
      assert.deepEqual(proposalsOf({ proposals: [{ ...STRANGER, voiceTraits: junk }] }), [
        { ...STRANGER, visibility: 'player' },
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

  it('rpg-42a.89 parses a GM roll by rule or by dice expression', () => {
    assert.deepEqual(proposalsOf({ proposals: [TAM_ATTACK_ROLL, SECRET_LISTEN] }), [TAM_ATTACK_ROLL, SECRET_LISTEN]);
  });

  const invalid: readonly [string, unknown][] = [
    ['gm roll with neither rule nor expression', [{ ...TAM_ATTACK_ROLL, ruleId: undefined }]],
    ['gm roll with both rule and expression', [{ ...TAM_ATTACK_ROLL, expression: '1d20' }]],
    ['gm roll with an unknown visibility', [{ ...TAM_ATTACK_ROLL, visibility: 'player' }]],
    ['gm roll without a visibility', [{ ...TAM_ATTACK_ROLL, visibility: undefined }]],
    ['gm roll without a reason', [{ ...TAM_ATTACK_ROLL, reason: ' ' }]],
    ['gm roll with a bad roller id', [{ ...TAM_ATTACK_ROLL, roller: 'Old Tam' }]],
    [
      'gm roll with a long expression',
      [{ ...SECRET_LISTEN, expression: `1d20${'+1'.repeat(MAX_ROLL_EXPRESSION_LENGTH)}` }],
    ],
    ['gm roll with an unknown key', [{ ...TAM_ATTACK_ROLL, damage: 5 }]],
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
    ['blank location kind', [{ ...STRANGER, locationKind: ' ' }]],
    ['long location kind', [{ ...STRANGER, locationKind: 'x'.repeat(MAX_TAG_LENGTH + 1) }]],
    ['long mood tag', [{ ...STRANGER, mood: ['x'.repeat(MAX_TAG_LENGTH + 1)] }]],
    ['too many mood tags', [{ ...STRANGER, mood: Array.from({ length: MAX_MOOD_TAGS + 1 }, () => 'tense') }]],
    ['public visibility', [{ ...STRANGER, visibility: 'public' }]],
    ['unknown pending kind', [{ ...DEBT, pendingKind: 'curse' }]],
    ['pending without entities', [{ ...DEBT, entityIds: [] }]],
    ['too many proposals', Array.from({ length: MAX_PROPOSALS + 1 }, (_, index) => ({ ...STRANGER, id: `n${index}` }))],
    [
      'traits proposal without usable traits',
      [{ kind: 'voice-traits', id: 'v', entityId: 'stranger', voiceTraits: {} }],
    ],
    [
      'traits proposal with a bad entity id',
      [{ kind: 'voice-traits', id: 'v', entityId: 'Bad Id', voiceTraits: { gender: 'male' } }],
    ],
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

  it('rpg-cm63.44 stores voice traits in the npc entity data, for new and existing npcs', async (t) => {
    const voiceTraits = { gender: 'female', age: 'old', manner: 'warm' };
    const { entities } = await narratedWith(t, [
      { ...STRANGER, voiceTraits },
      { ...STRANGER, id: 'innkeeper', name: 'Marta', facts: ['Keeps the inn.'] },
      { kind: 'voice-traits', id: 'marta-voice', entityId: 'innkeeper', voiceTraits: { gender: 'male' } },
      { kind: 'voice-traits', id: 'ghost-voice', entityId: 'ghost', voiceTraits: { gender: 'male' } },
    ]);
    assert.deepEqual(
      entities.map(({ id, data }) => [id, data]),
      [
        ['stranger', { voiceTraits }],
        ['innkeeper', { voiceTraits: { gender: 'male' } }],
      ],
    );
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

describe('rpg-42a.90 modifier and condition proposals', () => {
  const check = { kind: 'check', id: 'read-map', ruleId: 'check.wits', target: 'the map', label: 'Read the map' };
  const darkness = { id: 'darkness', reason: 'the lantern went out', sourceRule: 'darkness' };
  const parse = (...proposals: unknown[]) => proposalsOf({ proposals });

  it('parses modifiers, a difficulty, a condition and its end', () => {
    const parsed = parse(
      { ...check, difficulty: 'hard', modifiers: [darkness, { id: 'moonlit', reason: 'bright moon', value: 1 }] },
      {
        kind: 'condition',
        id: 'lantern-out',
        conditionId: 'darkened',
        reason: 'it gutters',
        duration: { unit: 'scenes', count: 1 },
      },
      { kind: 'condition-end', id: 'lit', conditionId: 'darkened' },
    );
    assert.equal(parsed?.length, 3);
  });

  it('refuses a modifier with a blank reason, an out-of-bounds value or an unknown field', () => {
    for (const modifier of [
      { ...darkness, reason: ' ' },
      { id: 'big', reason: 'x', value: 11 },
      { id: 'frac', reason: 'x', value: 1.5 },
      { ...darkness, effect: { kind: 'flat', value: 99 } },
    ])
      assert.equal(parse({ ...check, modifiers: [modifier] }), undefined);
  });

  it('accepts a boolean needsCheck on a check and refuses anything else', () => {
    assert.equal(parse({ ...check, needsCheck: true })?.length, 1);
    for (const needsCheck of ['yes', 1, null, {}]) assert.equal(parse({ ...check, needsCheck }), undefined);
    assert.ok(JSON.stringify(PROPOSALS_SCHEMA).includes('needsCheck'));
  });

  it('refuses a bad condition duration', () => {
    for (const duration of [
      { unit: 'years', count: 1 },
      { unit: 'turns', count: 0 },
      { unit: 'turns', count: 1000 },
    ])
      assert.equal(parse({ kind: 'condition', id: 'x', conditionId: 'darkened', reason: 'r', duration }), undefined);
  });

  it('declares the modifier and condition shapes in the tool schema', () => {
    const text = JSON.stringify(PROPOSALS_SCHEMA);
    for (const needle of ['"condition"', '"condition-end"', 'modifiers', 'difficulty', 'sourceRule'])
      assert.ok(text.includes(needle), needle);
  });
});
