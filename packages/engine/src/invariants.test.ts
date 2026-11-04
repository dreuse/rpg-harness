import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadInvestigationKit, openBeats, scopedKnowledge } from '../../content/src/investigation.ts';
import { MYSTERY_PACK } from '../../content/src/packs.ts';
import {
  CampaignBoundaryError,
  type CampaignEvent,
  type CampaignStore,
  StaleRevisionError,
  type Turn,
} from '../../domain/src/campaign.ts';
import { GM_VIEWER, PLAYER_VIEWER, type Viewer, visibleTo } from '../../memory/src/knowledge.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { type EffectiveMechanic, RULE_DSL_VERSION, type RuleDsl } from '../../rules/src/dsl.ts';
import { activeModifiers, applyEffect, endEffect, equip, unequip } from '../../rules/src/inventory.ts';
import { resolveAction } from '../../rules/src/resolve.ts';
import { type TraitSheet, validateTraitSheet } from '../../rules/src/traits.ts';
import { createScriptedRng } from '../../testkit/src/fixtures.ts';
import { actInEncounter, currentEncounter, type EncounterMove, resolveEncounter, startEncounter } from './encounter.ts';
import { createFakeGameMaster, runScript } from './scripted-session.ts';
import { InvalidActionError, type PlayerAction, performAction } from './turn.ts';

const IN_MEMORY = ':memory:';
const SETUP_REVISION = 1;
const MID_DRAW = 0.5;
const SUPPLY_MAX = 5;
const SUPPLY_START = 3;
const OVERSIZED_GAIN = 100;
const OVERSPEND = SUPPLY_START + 1;
const MINTING_COST = -2;
const ZERO_STACKS = 0;
const LANTERN = 'lantern';
const LANTERN_BONUS = 1;
const SHIELD = 'shield';
const POISONED = 'poisoned';
const POISON_PENALTY = -2;
const CAMPAIGN = { id: 'campaign-1', name: 'Harbor Lights' };
const FOREIGN_CAMPAIGN_ID = 'campaign-2';
const MARA = { id: 'mara', campaignId: CAMPAIGN.id, name: 'Mara' };
const FERRYMAN = { id: 'ferryman', campaignId: CAMPAIGN.id, name: 'Ferryman' };
const STRANGER_ID = 'stranger';
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The Dock at Dusk' };
const OTHER_SCENE_ID = 'scene-2';
const CREATED_EVENT = {
  id: 'created-1',
  campaignId: CAMPAIGN.id,
  branchId: 'main',
  actionId: 'create',
  type: 'CampaignCreated',
  payload: { name: CAMPAIGN.name },
};
const SETUP_TURN: Turn = {
  id: 'turn-0',
  campaignId: CAMPAIGN.id,
  sceneId: SCENE.id,
  actionId: 'setup',
  actorId: MARA.id,
  input: 'Begin.',
  narration: 'A lantern sways at the end of the pier.',
};
const OUTCOME = 'The ferryman yields the oar.';
const ACTION_RESOLVED = 'EncounterActionResolved';
const SECRET_IDS = MYSTERY_PACK.investigation.secrets.map(({ id }) => id);
const FIRST_CLUE = 'wound-clock';
const ACCUSATION_CLUES = ['mud', 'will'];
const ACCUSATION = 'accusation';
const UNKNOWN_CLUE = 'forged-clue';

const RULE: RuleDsl = {
  dslVersion: RULE_DSL_VERSION,
  id: 'contest',
  effects: [{ kind: 'emitEvent', event: 'contest.made' }],
};
const RULE_PACK = { id: 'harbor-rules', edition: 'first', revision: '1' };
const CONTEST: EffectiveMechanic = {
  ruleId: RULE.id,
  rulePack: RULE_PACK,
  source: { kind: 'rulepack', sourceRef: RULE.id, revision: RULE_PACK.revision },
  kind: 'deterministic',
  rule: {
    rule: RULE,
    rulePack: RULE_PACK,
    sourceRefs: [RULE.id],
    primitives: [],
    adjudicated: [],
    deterministic: true,
  },
};
const RULES = { rulePack: RULE_PACK, mechanics: [CONTEST] };

const setup = (): { store: CampaignStore; close: () => void } => {
  const connection = openDatabase(IN_MEMORY);
  const store = createCampaignStore(connection.database);
  store.createCampaign(CAMPAIGN, CREATED_EVENT);
  store.commitTurn({
    expectedRevision: 0,
    turn: SETUP_TURN,
    characters: [MARA, FERRYMAN],
    scenes: [SCENE],
    events: [],
  });
  return { store, close: () => connection.close() };
};

const action = (actionId: string, expectedRevision: number, actorId = MARA.id): PlayerAction => ({
  campaignId: CAMPAIGN.id,
  actionId,
  expectedRevision,
  sceneId: SCENE.id,
  actorId,
  input: 'I reach for the oar.',
  intent: 'Take the oar from the ferryman.',
});

const sheetOf = (characterId: string, traits: TraitSheet['traits'] = []): TraitSheet => ({ characterId, traits });

const supplySheet = (): TraitSheet =>
  sheetOf(MARA.id, [{ id: 'supply', kind: 'resource', current: SUPPLY_START, max: SUPPLY_MAX }]);

const move = (actionId: string, expectedRevision: number, actorId: string, ruleId = RULE.id): EncounterMove => ({
  ...action(actionId, expectedRevision, actorId),
  ruleId,
  rng: createScriptedRng([MID_DRAW]),
});

const opening = (sheets: readonly TraitSheet[] = []) => ({
  ...action('start', SETUP_REVISION),
  participants: [MARA.id, FERRYMAN.id],
  rules: RULES,
  sheets,
});

const startedEncounter = () => {
  const harness = setup();
  startEncounter(harness.store, opening());
  return harness;
};

const assertRejectedWithoutWrite = (
  store: CampaignStore,
  attempt: () => unknown,
  error: new (...args: never[]) => Error,
) => {
  const before = store.load(CAMPAIGN.id);
  assert.throws(attempt, error);
  assert.deepEqual(store.load(CAMPAIGN.id), before);
};

const supplyRule = (overrides: Record<string, unknown>) => ({
  dslVersion: RULE_DSL_VERSION,
  id: 'supply-change',
  effects: [],
  ...overrides,
});

const resolveSupply = (rule: unknown) =>
  resolveAction({ actionId: 'supply', rule, sheet: supplySheet(), rng: createScriptedRng([MID_DRAW]) });

test('inventory bounds: gains clamp at max and spending past zero or minting through a negative cost is rejected', () => {
  const gain = resolveSupply(
    supplyRule({
      effects: [{ kind: 'adjustResource', resource: 'supply', amount: { kind: 'const', value: OVERSIZED_GAIN } }],
    }),
  );
  assert.equal(gain.ok, true);
  assert.deepEqual(gain.ok && gain.sheet.traits, [
    { id: 'supply', kind: 'resource', current: SUPPLY_MAX, max: SUPPLY_MAX },
  ]);

  const overspend = resolveSupply(
    supplyRule({ costs: [{ kind: 'cost', resource: 'supply', amount: { kind: 'const', value: OVERSPEND } }] }),
  );
  assert.equal(!overspend.ok && overspend.error.code, 'InsufficientResource');

  const minting = resolveSupply(
    supplyRule({ costs: [{ kind: 'cost', resource: 'supply', amount: { kind: 'const', value: MINTING_COST } }] }),
  );
  assert.equal(!minting.ok && minting.error.code, 'InvalidAmount');
});

test('inventory bounds: the engine rejects a stored sheet holding more than its max', () => {
  const { store, close } = setup();
  const overfull = sheetOf(MARA.id, [{ id: 'supply', kind: 'resource', current: SUPPLY_MAX + 1, max: SUPPLY_MAX }]);
  assertRejectedWithoutWrite(store, () => startEncounter(store, opening([overfull])), InvalidActionError);
  close();
});

test('inventory: items equip once, unequip only when equipped, and only equipped items grant modifiers', () => {
  const equipped = equip(sheetOf(MARA.id), LANTERN);
  assert.equal(equipped.ok, true);
  if (!equipped.ok) return;
  assert.equal(equip(equipped.sheet, LANTERN).ok, false);
  assert.equal(unequip(equipped.sheet, SHIELD).ok, false);
  assert.equal(equip(equipped.sheet, '').ok, false);
  const items = [
    { id: LANTERN, modifiers: { perception: LANTERN_BONUS } },
    { id: SHIELD, modifiers: { defense: LANTERN_BONUS } },
  ];
  assert.deepEqual(activeModifiers(equipped.sheet, items, []), { perception: LANTERN_BONUS });
});

test('conditions: duplicates, ending an inactive condition and invalid stacks are rejected', () => {
  const poisoned = applyEffect(sheetOf(MARA.id), POISONED);
  assert.equal(poisoned.ok, true);
  if (!poisoned.ok) return;
  assert.equal(applyEffect(poisoned.sheet, POISONED).ok, false);
  const effects = [{ id: POISONED, modifiers: { vigor: POISON_PENALTY } }];
  assert.deepEqual(activeModifiers(poisoned.sheet, [], effects), { vigor: POISON_PENALTY });

  const cured = endEffect(poisoned.sheet, POISONED);
  assert.equal(cured.ok, true);
  assert.equal(cured.ok && endEffect(cured.sheet, POISONED).ok, false);
  assert.deepEqual(cured.ok && activeModifiers(cured.sheet, [], effects), {});

  const lantern = equip(sheetOf(MARA.id), LANTERN);
  assert.equal(lantern.ok && endEffect(lantern.sheet, `equipped:${LANTERN}`).ok, false);
  assert.equal(
    validateTraitSheet(sheetOf(MARA.id, [{ id: POISONED, kind: 'condition', stacks: ZERO_STACKS }])).ok,
    false,
  );
});

test('secrets: player and actor projections never include GM secrets or undiscovered clues', () => {
  const loaded = loadInvestigationKit(MYSTERY_PACK.investigation);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const knowledge = scopedKnowledge(loaded.kit, [FIRST_CLUE, UNKNOWN_CLUE]);
  const ids = (viewer: Viewer) => visibleTo(knowledge, viewer).map(({ id }) => id);

  assert.deepEqual(ids(PLAYER_VIEWER), [FIRST_CLUE]);
  assert.deepEqual(ids({ scope: 'actor', actorId: MARA.id }), []);
  assert.deepEqual(ids({ scope: 'actor', actorId: '' }), []);
  assert.deepEqual(ids({ scope: 'admin' } as unknown as Viewer), []);
  assert.ok(SECRET_IDS.every((id) => ids(GM_VIEWER).includes(id)));
});

test('quest state: a beat opens only once every required clue is discovered, ignoring forged clue ids', () => {
  const loaded = loadInvestigationKit(MYSTERY_PACK.investigation);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const open = (clues: readonly string[]) => openBeats(loaded.kit, clues).map(({ id }) => id);

  assert.equal(open([UNKNOWN_CLUE, FIRST_CLUE]).includes(ACCUSATION), false);
  assert.equal(open([ACCUSATION_CLUES[0] as string, ACCUSATION_CLUES[0] as string]).includes(ACCUSATION), false);
  assert.equal(open(ACCUSATION_CLUES).includes(ACCUSATION), true);
  assert.deepEqual(open([FIRST_CLUE, ...ACCUSATION_CLUES]), open([...ACCUSATION_CLUES, FIRST_CLUE, FIRST_CLUE]));
});

test('idempotent mechanics: replaying an action or encounter move commits its effects once', () => {
  const { store, close } = startedEncounter();
  const revision = SETUP_REVISION + 1;
  const first = actInEncounter(store, move('strike', revision, MARA.id));
  const replay = actInEncounter(store, move('strike', revision, MARA.id));
  assert.deepEqual(replay, first);

  const state = store.load(CAMPAIGN.id);
  assert.equal(state?.revision, revision + 1);
  assert.equal(state?.events.filter(({ type }) => type === ACTION_RESOLVED).length, 1);
  assert.equal(currentEncounter(state?.events ?? [])?.actorId, FERRYMAN.id);

  const talk = performAction(store, action('talk', revision + 1, FERRYMAN.id));
  assert.deepEqual(performAction(store, action('talk', revision + 1, FERRYMAN.id)), talk);
  assert.equal(store.load(CAMPAIGN.id)?.turns.filter(({ actionId }) => actionId === 'talk').length, 1);
  close();
});

test('idempotent mechanics: a fake GM repeating an action id adds no second turn', () => {
  const { store, close } = setup();
  const reply = { proposal: { ...action('look', SETUP_REVISION) }, narration: 'Fog rolls in.' };
  const [first, second] = runScript(store, createFakeGameMaster([reply, reply]), CAMPAIGN.id, 2);
  assert.ok(first && 'committed' in first && second && 'committed' in second);
  assert.deepEqual(second.committed, first.committed);
  assert.equal(store.load(CAMPAIGN.id)?.revision, SETUP_REVISION + 1);
  close();
});

test('out-of-order: stale and future revisions are rejected without writing', () => {
  const { store, close } = setup();
  assertRejectedWithoutWrite(
    store,
    () => performAction(store, action('stale', SETUP_REVISION - 1)),
    StaleRevisionError,
  );
  assertRejectedWithoutWrite(
    store,
    () => performAction(store, action('future', SETUP_REVISION + 1)),
    StaleRevisionError,
  );
  close();
});

test('out-of-order: an event caused by a later or self event in the same commit is rejected and rolled back', () => {
  const { store, close } = setup();
  const turn: Turn = { ...SETUP_TURN, id: 'turn-1', actionId: 'reorder' };
  const event = (id: string, causationId: string | null): CampaignEvent => ({
    id,
    campaignId: CAMPAIGN.id,
    turnId: turn.id,
    causationId,
    type: 'PlayerActionSubmitted',
    payload: {},
  });
  const commit = (events: CampaignEvent[]) => () =>
    store.commitTurn({ expectedRevision: SETUP_REVISION, turn, characters: [], scenes: [], events });
  assertRejectedWithoutWrite(store, commit([event('effect', 'cause'), event('cause', null)]), CampaignBoundaryError);
  assertRejectedWithoutWrite(store, commit([event('loop', 'loop')]), CampaignBoundaryError);
  close();
});

test('malicious: a commit smuggling a foreign character or event is rejected atomically', () => {
  const { store, close } = setup();
  const turn: Turn = { ...SETUP_TURN, id: 'turn-1', actionId: 'smuggle' };
  const foreignCharacter = { id: STRANGER_ID, campaignId: FOREIGN_CAMPAIGN_ID, name: 'Stranger' };
  const foreignEvent: CampaignEvent = {
    id: 'foreign',
    campaignId: FOREIGN_CAMPAIGN_ID,
    turnId: turn.id,
    causationId: null,
    type: 'PlayerActionSubmitted',
    payload: {},
  };
  const commit = (characters: (typeof MARA)[], events: CampaignEvent[]) => () =>
    store.commitTurn({ expectedRevision: SETUP_REVISION, turn, characters, scenes: [], events });
  assertRejectedWithoutWrite(store, commit([foreignCharacter], []), CampaignBoundaryError);
  assertRejectedWithoutWrite(store, commit([], [foreignEvent]), CampaignBoundaryError);
  close();
});

test('malicious: encounter moves out of turn, with an unpinned rule, or after resolution are rejected', () => {
  const { store, close } = startedEncounter();
  const revision = SETUP_REVISION + 1;
  assertRejectedWithoutWrite(
    store,
    () => actInEncounter(store, move('jump', revision, FERRYMAN.id)),
    InvalidActionError,
  );
  assertRejectedWithoutWrite(
    store,
    () => actInEncounter(store, move('unpinned', revision, MARA.id, 'forged-rule')),
    InvalidActionError,
  );
  resolveEncounter(store, { ...action('end', revision), outcome: OUTCOME });
  assertRejectedWithoutWrite(
    store,
    () => actInEncounter(store, move('late', revision + 1, MARA.id)),
    InvalidActionError,
  );
  close();
});

test('malicious: fake GM proposals for an unknown actor or another scene are rejected', () => {
  const { store, close } = setup();
  const propose = (overrides: Partial<PlayerAction>) => () =>
    runScript(
      store,
      createFakeGameMaster([{ proposal: { ...action('forged', SETUP_REVISION), ...overrides }, narration: 'x' }]),
      CAMPAIGN.id,
      1,
    );
  assertRejectedWithoutWrite(store, propose({ actorId: STRANGER_ID }), InvalidActionError);
  assertRejectedWithoutWrite(store, propose({ sceneId: OTHER_SCENE_ID }), InvalidActionError);
  close();
});
