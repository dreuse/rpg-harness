import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CampaignState, CampaignStore } from '../../domain/src/campaign.ts';
import { GM_VIEWER, PLAYER_VIEWER, type Viewer } from '../../memory/src/knowledge.ts';
import { buildLedger, ledgerAllowance, ledgerLines } from '../../memory/src/ledger.ts';
import { buildContextPacket, CONTEXT_BUDGETS, type PacketInput } from '../../memory/src/packet.ts';
import { createCampaignStore } from '../../persistence/src/campaign-store.ts';
import { openDatabase } from '../../persistence/src/database.ts';
import { createEntityStore } from '../../persistence/src/entity-store.ts';
import { createEngine } from './engine.ts';
import { type GameMaster, type GameMasterReply, runGuardedScript } from './scripted-session.ts';
import {
  type ClaimDraft,
  CONTINUITY_CONFLICT_LOGGED,
  correctStoryFact,
  directoryOf,
  readStoryMemory,
} from './story-memory.ts';

const CAMPAIGN = { id: 'campaign-1', name: 'Long Road' };
const HERO = { id: 'hero', campaignId: CAMPAIGN.id, name: 'Ilse' };
const SCENE = { id: 'scene-1', campaignId: CAMPAIGN.id, title: 'The North Road' };
const WARDEN = 'warden';
const PIER = 'pier';
const TURNS = 1000;
const FIRST_TURN = 1;
const DEATH_TURN = 400;
const RECOVERED_TURN = 500;
const UNRECOVERED_TURN = 600;
const CORRECTION_TURN = 700;
const LEAK_TURN = 800;
const PUBLIC = { visibility: 'public' as const };
const SECRET_TEXT = 'serves the cult';
const BRASS_KEY = 'brass key';
const CONTRADICTION = 'The Warden smiles and says hello.';
const CLEAN_REPLY = 'The road is quiet.';

const WARDEN_DEFINITION = {
  id: WARDEN,
  campaignId: CAMPAIGN.id,
  kind: 'npc' as const,
  name: 'Warden',
  data: {},
  visibility: 'public' as const,
  actorId: null,
};

const claimsAt = (turn: number): readonly ClaimDraft[] | undefined => {
  if (turn === FIRST_TURN)
    return [
      { entityId: WARDEN, kind: 'alive', value: 'alive', ...PUBLIC },
      { entityId: WARDEN, kind: 'description', value: 'one-eyed and grey', ...PUBLIC },
      { entityId: WARDEN, kind: 'item', key: BRASS_KEY, value: 'held', ...PUBLIC },
      { entityId: WARDEN, kind: 'promise', key: 'open the vault', value: 'open', ...PUBLIC },
      { entityId: WARDEN, kind: 'secret', key: 'loyalty', value: SECRET_TEXT, visibility: 'gm' },
      { entityId: PIER, kind: 'description', value: 'rotting planks', ...PUBLIC },
    ];
  if (turn === DEATH_TURN) return [{ entityId: WARDEN, kind: 'alive', value: 'dead', ...PUBLIC }];
  return undefined;
};

const narrationAt = (turn: number, regenerating: boolean): string => {
  if (turn === RECOVERED_TURN) return regenerating ? CLEAN_REPLY : CONTRADICTION;
  if (turn === UNRECOVERED_TURN) return CONTRADICTION;
  if (turn === LEAK_TURN) return `Rumor says the Warden ${SECRET_TEXT}.`;
  return CLEAN_REPLY;
};

const createGameMaster = (): GameMaster => {
  let turn = 0;
  return {
    respond: (_state: CampaignState, conflictingFacts = []): GameMasterReply => {
      if (conflictingFacts.length === 0) turn += 1;
      const claims = claimsAt(turn);
      return {
        proposal: {
          actionId: `action-${turn}`,
          sceneId: SCENE.id,
          actorId: HERO.id,
          input: `I walk to milestone ${turn}.`,
          intent: `travel-${turn}`,
        },
        narration: narrationAt(turn, conflictingFacts.length > 0),
        ...(claims === undefined ? {} : { claims }),
      };
    },
  };
};

const startCampaign = () => {
  const connection = openDatabase(':memory:');
  const store = createCampaignStore(connection.database);
  const engine = createEngine(store);
  const campaign = engine.createCampaign(CAMPAIGN.name);
  store.commitTurn({
    expectedRevision: store.load(campaign.id)?.revision ?? 0,
    turn: {
      id: 'turn-0',
      campaignId: campaign.id,
      sceneId: SCENE.id,
      actionId: 'setup',
      actorId: HERO.id,
      input: 'Begin.',
      narration: 'The road bends north.',
    },
    characters: [{ ...HERO, campaignId: campaign.id }],
    scenes: [{ ...SCENE, campaignId: campaign.id }],
    events: [],
  });
  const entities = createEntityStore(connection.database);
  entities.saveEntity({ ...WARDEN_DEFINITION, campaignId: campaign.id });
  entities.saveEntity({
    ...WARDEN_DEFINITION,
    id: PIER,
    kind: 'location',
    name: 'Pier',
    campaignId: campaign.id,
  });
  return { connection, store, entities, campaignId: campaign.id };
};

const packetFor = (
  campaignId: string,
  store: CampaignStore,
  entities: ReturnType<typeof createEntityStore>,
  ids: readonly string[],
  viewer: Viewer,
) => {
  const state = store.load(campaignId) as CampaignState;
  const budget = CONTEXT_BUDGETS.compact;
  const input: PacketInput = {
    instructions: ['Narrate.'],
    ruleset: [],
    setting: ['road'],
    campaignSummary: [],
    chapterSummaries: [],
    sceneSummaries: [],
    context: [],
    ledger: ledgerLines({
      ledger: buildLedger(state.events),
      entityIds: ids,
      directory: directoryOf(state, entities),
      viewer,
      allowance: ledgerAllowance(budget),
    }),
    threads: [],
    entities: [],
    recentTurns: Array.from({ length: 6 }, (_, index) => `turn ${index}: ${'the hero walks '.repeat(8)}`),
    results: [],
    playerInput: ['I greet the Warden'],
  };
  return buildContextPacket(input, budget);
};

const ledgerSection = (packet: ReturnType<typeof buildContextPacket>) =>
  (packet.sections.find(({ name }) => name === 'ledger')?.items ?? []).join('\n');

test('rpg-42a.42 a fake GM plays 1000 turns: old facts return, contradictions are caught, corrections stick', async () => {
  const { connection, store, entities, campaignId } = startCampaign();
  const outcomes = await runGuardedScript(store, entities, createGameMaster(), campaignId, TURNS);
  assert.equal(outcomes.length, TURNS);
  const turnOutcome = (turn: number) => {
    const outcome = outcomes[turn - FIRST_TURN];
    assert.ok(outcome !== undefined && 'committed' in outcome, `turn ${turn} committed`);
    return outcome;
  };

  const recovered = turnOutcome(RECOVERED_TURN).continuity;
  assert.equal(recovered?.regenerations, 1);
  assert.equal(recovered?.resolved, true);
  assert.equal(turnOutcome(RECOVERED_TURN).narration, CLEAN_REPLY);

  const stubborn = turnOutcome(UNRECOVERED_TURN);
  assert.equal(stubborn.continuity?.resolved, false);
  assert.equal(stubborn.narration.includes(CONTRADICTION), false);
  assert.ok(stubborn.narration.includes('Warden alive: dead'));

  assert.equal(turnOutcome(FIRST_TURN).continuity?.regenerations, 0);
  const logged = (store.load(campaignId)?.changes ?? []).filter(({ type }) => type === CONTINUITY_CONFLICT_LOGGED);
  assert.ok(logged.length >= 1);
  assert.ok(logged.some(({ payload }) => payload.resolved === false));

  const leak = turnOutcome(LEAK_TURN);
  assert.equal(leak.narration.includes(SECRET_TEXT), false);

  const atTurn1000 = packetFor(campaignId, store, entities, [WARDEN], PLAYER_VIEWER);
  const text = ledgerSection(atTurn1000);
  assert.ok(text.includes('Warden alive: dead'), 'death set at turn 400 survives');
  assert.ok(text.includes('one-eyed and grey'), 'description set at turn 1 is in the packet at turn 1000');
  assert.ok(text.includes(BRASS_KEY));
  assert.ok(text.includes('open the vault'));
  assert.equal(text.includes(SECRET_TEXT), false, 'player packet hides the secret');
  assert.equal(atTurn1000.requiredExceedsBudget, false);
  assert.ok(ledgerSection(packetFor(campaignId, store, entities, [WARDEN], GM_VIEWER)).includes(SECRET_TEXT));
  assert.equal(
    ledgerSection(packetFor(campaignId, store, entities, [HERO.id], PLAYER_VIEWER)).includes('one-eyed'),
    false,
  );

  const memory = readStoryMemory(store, entities, campaignId);
  assert.equal(JSON.stringify(memory).includes('cult'), false);
  assert.ok(memory.person.some(({ kind, value }) => kind === 'alive' && value === 'dead'));

  correctStoryFact(store, entities, {
    campaignId,
    actionId: 'player-correction',
    expectedRevision: store.load(campaignId)?.revision ?? 0,
    actorId: HERO.id,
    entityId: WARDEN,
    kind: 'alive',
    value: 'alive',
  });
  const corrected = ledgerSection(packetFor(campaignId, store, entities, [WARDEN], PLAYER_VIEWER));
  assert.ok(corrected.includes('Warden alive: alive'));
  assert.equal(corrected.includes('Warden alive: dead'), false);
  assert.equal(
    readStoryMemory(store, entities, campaignId).person.find(({ kind }) => kind === 'alive')?.corrected,
    true,
  );
  connection.close();
});

test('rpg-42a.42 after a correction the same narration is no longer a contradiction', async () => {
  const { connection, store, entities, campaignId } = startCampaign();
  const gameMaster = createGameMaster();
  await runGuardedScript(store, entities, gameMaster, campaignId, CORRECTION_TURN);
  const stubborn: GameMaster = {
    respond: (state, facts) => ({ ...gameMaster.respond(state, facts), narration: CONTRADICTION }),
  };
  const before = await runGuardedScript(store, entities, stubborn, campaignId, 1);
  const first = before[0];
  assert.ok(first !== undefined && 'continuity' in first);
  assert.equal(first.continuity?.resolved, false);
  correctStoryFact(store, entities, {
    campaignId,
    actionId: 'player-correction',
    expectedRevision: store.load(campaignId)?.revision ?? 0,
    actorId: HERO.id,
    entityId: WARDEN,
    kind: 'alive',
    value: 'alive',
  });
  const after = await runGuardedScript(store, entities, stubborn, campaignId, 1);
  const second = after[0];
  assert.ok(second !== undefined && 'continuity' in second);
  assert.equal(second.continuity?.resolved, true);
  assert.equal(second.narration, CONTRADICTION);
  connection.close();
});
