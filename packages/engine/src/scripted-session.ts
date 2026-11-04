import {
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
} from '../../domain/src/campaign.ts';
import { type PlayerAction, performAction } from './turn.ts';

export type ActionProposal = Omit<PlayerAction, 'campaignId' | 'expectedRevision'>;

export type GameMasterReply = { readonly proposal: ActionProposal; readonly narration: string };

export type GameMaster = { respond(state: CampaignState): GameMasterReply };

export const INTERRUPT = 'interrupt';

export type ScriptStep = GameMasterReply | typeof INTERRUPT;

export type ScriptOutcome =
  | { readonly committed: CommittedTurn; readonly narration: string }
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

const playTurn = (store: CampaignStore, gameMaster: GameMaster, campaignId: CampaignId): ScriptOutcome => {
  const state = store.load(campaignId);
  if (state === undefined) throw new CampaignNotFoundError(campaignId);
  try {
    const { proposal, narration } = gameMaster.respond(state);
    const action = { ...proposal, campaignId, expectedRevision: state.revision };
    return { committed: performAction(store, action), narration };
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
): ScriptOutcome[] => Array.from({ length: turns }, () => playTurn(store, gameMaster, campaignId));
