import type { CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import { GameMasterInterruptedError } from './scripted-session.ts';
import { loadState, type PlayerAction, storedTurn } from './turn.ts';

export type Narrator = { narrate(committed: CommittedTurn): string };

export type SceneResolver<A extends PlayerAction> = (store: CampaignStore, action: A) => CommittedTurn;

export type GameplayOutcome =
  | { readonly committed: CommittedTurn; readonly narration: string }
  | { readonly committed: CommittedTurn; readonly interrupted: GameMasterInterruptedError };

export const playGameplayTurn = <A extends PlayerAction>(
  store: CampaignStore,
  narrator: Narrator,
  resolve: SceneResolver<A>,
  action: A,
): GameplayOutcome => {
  const resolved = resolve(store, action);
  const committed = storedTurn(loadState(store, action.campaignId), action.actionId) ?? resolved;
  try {
    return { committed, narration: narrator.narrate(committed) };
  } catch (error) {
    if (error instanceof GameMasterInterruptedError) return { committed, interrupted: error };
    throw error;
  }
};
