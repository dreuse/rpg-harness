import type { CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import { type ConsistencyInput, type ConsistencyReport, checkConsistency } from '../../narrative/src/consistency.ts';
import { GameMasterInterruptedError } from './scripted-session.ts';
import { loadState, type PlayerAction, storedTurn } from './turn.ts';

export type NarratedTurn = Pick<ConsistencyInput, 'narration' | 'claims'>;

export type NarrationContext = Omit<ConsistencyInput, 'narration' | 'claims' | 'events'>;

export type Narrator = { narrate(committed: CommittedTurn): NarratedTurn };

export type SceneResolver<A extends PlayerAction> = (store: CampaignStore, action: A) => CommittedTurn;

export type GameplayOutcome =
  | { readonly committed: CommittedTurn; readonly narration: string }
  | { readonly committed: CommittedTurn; readonly interrupted: GameMasterInterruptedError }
  | { readonly committed: CommittedTurn; readonly inconsistent: ConsistencyReport };

export class UncommittedTurnError extends Error {
  readonly actionId: string;
  constructor(actionId: string) {
    super(`action ${actionId} has no committed turn to narrate`);
    this.actionId = actionId;
  }
}

const PENDING_NARRATION = '';

const narrateCommitted = (
  store: CampaignStore,
  narrator: Narrator,
  committed: CommittedTurn,
  context: NarrationContext,
): GameplayOutcome => {
  const { narration, claims } = narrator.narrate(committed);
  const { events } = loadState(store, committed.turn.campaignId);
  const report = checkConsistency({ ...context, narration, claims, events });
  if (!report.ok) return { committed, inconsistent: report };
  store.recordNarration(committed.turn.campaignId, committed.turn.id, narration);
  return { committed, narration };
};

export const playGameplayTurn = <A extends PlayerAction>(
  store: CampaignStore,
  narrator: Narrator,
  resolve: SceneResolver<A>,
  action: A,
  context: NarrationContext,
): GameplayOutcome => {
  resolve(store, action);
  const committed = storedTurn(loadState(store, action.campaignId), action.actionId);
  if (committed === undefined) throw new UncommittedTurnError(action.actionId);
  if (committed.turn.narration !== PENDING_NARRATION) return { committed, narration: committed.turn.narration };
  try {
    return narrateCommitted(store, narrator, committed, context);
  } catch (error) {
    if (error instanceof GameMasterInterruptedError) return { committed, interrupted: error };
    throw error;
  }
};
