import { randomUUID } from 'node:crypto';
import {
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
} from '../../domain/src/campaign.ts';
import type { EntityStore } from '../../domain/src/entity.ts';
import { buildLedger } from '../../memory/src/ledger.ts';
import { type ContinuityLogRecord, type ContinuityOutcome, enforceContinuity } from '../../narrative/src/continuity.ts';
import { type ClaimDraft, directoryOf, proposeClaims, recordContinuityConflict } from './story-memory.ts';
import { type PlayerAction, performAction } from './turn.ts';

export type ActionProposal = Omit<PlayerAction, 'campaignId' | 'expectedRevision'>;

export type GameMasterReply = {
  readonly proposal: ActionProposal;
  readonly narration: string;
  readonly claims?: readonly ClaimDraft[];
};

export type GameMaster = {
  respond(state: CampaignState, conflictingFacts?: readonly string[]): GameMasterReply;
};

export const INTERRUPT = 'interrupt';

export type ScriptStep = GameMasterReply | typeof INTERRUPT;

export type ScriptOutcome =
  | { readonly committed: CommittedTurn; readonly narration: string; readonly continuity?: ContinuityOutcome }
  | { readonly interrupted: GameMasterInterruptedError };

export class GameMasterInterruptedError extends Error {
  constructor(step: number) {
    super(`fake game master interrupted at step ${step}`);
  }
}

export const createFakeGameMaster = (steps: readonly ScriptStep[]): GameMaster => {
  let next = 0;
  return {
    respond: () => {
      const index = next++;
      const step = steps[index];
      if (step === undefined) throw new RangeError(`fake game master script ended after ${steps.length} steps`);
      if (step === INTERRUPT) throw new GameMasterInterruptedError(index);
      return step;
    },
  };
};

const MISSING_ENTITIES = 'a game master that proposes claims needs an entity store';

const commitReply = (
  store: CampaignStore,
  entities: EntityStore | undefined,
  campaignId: CampaignId,
  state: CampaignState,
  { proposal, claims }: GameMasterReply,
): CommittedTurn => {
  const action = { ...proposal, campaignId, expectedRevision: state.revision };
  if (claims === undefined || claims.length === 0) return performAction(store, action);
  if (entities === undefined) throw new RangeError(MISSING_ENTITIES);
  return proposeClaims(store, entities, { ...action, claims });
};

const loaded = (store: CampaignStore, campaignId: CampaignId) => {
  const state = store.load(campaignId);
  if (state === undefined) throw new CampaignNotFoundError(campaignId);
  return state;
};

const playTurn = (
  store: CampaignStore,
  gameMaster: GameMaster,
  campaignId: CampaignId,
  entities?: EntityStore,
): ScriptOutcome => {
  const state = loaded(store, campaignId);
  try {
    const reply = gameMaster.respond(state);
    return { committed: commitReply(store, entities, campaignId, state, reply), narration: reply.narration };
  } catch (error) {
    if (error instanceof GameMasterInterruptedError) return { interrupted: error };
    throw error;
  }
};

export const runScript = (
  store: CampaignStore,
  gameMaster: GameMaster,
  campaignId: CampaignId,
  turns: number,
  entities?: EntityStore,
): ScriptOutcome[] => Array.from({ length: turns }, () => playTurn(store, gameMaster, campaignId, entities));

const playGuardedTurn = async (
  store: CampaignStore,
  entities: EntityStore,
  gameMaster: GameMaster,
  campaignId: CampaignId,
): Promise<ScriptOutcome> => {
  const state = loaded(store, campaignId);
  const logs: ContinuityLogRecord[] = [];
  try {
    let reply: GameMasterReply | undefined;
    const continuity = await enforceContinuity({
      ledger: buildLedger(state.events),
      directory: directoryOf(state, entities),
      generate: (conflicts) => {
        reply = gameMaster.respond(
          state,
          conflicts.map(({ fact }) => fact),
        );
        return reply.narration;
      },
      log: (record) => logs.push(record),
    });
    if (reply === undefined) throw new RangeError('game master produced no reply');
    const committed = commitReply(store, entities, campaignId, state, reply);
    for (const record of logs)
      recordContinuityConflict(store, {
        campaignId,
        actionId: randomUUID(),
        expectedRevision: loaded(store, campaignId).revision,
        record,
      });
    return { committed, narration: continuity.narration, continuity };
  } catch (error) {
    if (error instanceof GameMasterInterruptedError) return { interrupted: error };
    throw error;
  }
};

export const runGuardedScript = async (
  store: CampaignStore,
  entities: EntityStore,
  gameMaster: GameMaster,
  campaignId: CampaignId,
  turns: number,
): Promise<ScriptOutcome[]> => {
  const outcomes: ScriptOutcome[] = [];
  for (const _turn of Array.from({ length: turns }))
    outcomes.push(await playGuardedTurn(store, entities, gameMaster, campaignId));
  return outcomes;
};
