import type { CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import {
  type ConsistencyInput,
  type ConsistencyReport,
  checkConsistency,
  type Violation,
} from '../../narrative/src/consistency.ts';
import { GameMasterInterruptedError } from './scripted-session.ts';
import { CHECK_RESOLVED, loadState, type PlayerAction, storedTurnOf } from './turn.ts';

export type NarratedTurn = Pick<ConsistencyInput, 'narration' | 'claims'>;

export type NarrationContext = Omit<ConsistencyInput, 'narration' | 'claims' | 'events' | 'checkResolved'>;

export type Narrator = { narrate(committed: CommittedTurn): NarratedTurn };

export type AsyncNarrator = {
  narrate(committed: CommittedTurn, retry?: readonly Violation[]): Promise<NarratedTurn>;
};

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

const isUnresolvedOutcome = ({ kind }: Violation) => kind === 'unresolved-outcome';

const recordChecked = (
  store: CampaignStore,
  committed: CommittedTurn,
  context: NarrationContext,
  { narration, claims }: NarratedTurn,
): GameplayOutcome => {
  const { events } = loadState(store, committed.turn.campaignId);
  const checkResolved = committed.events.some(({ type }) => type === CHECK_RESOLVED);
  const report = checkConsistency({ ...context, narration, claims, events, checkResolved });
  if (!report.ok) return { committed, inconsistent: report };
  store.recordNarration(committed.turn.campaignId, committed.turn.id, narration);
  return { committed, narration };
};

const interruptedOr = (committed: CommittedTurn, error: unknown): GameplayOutcome => {
  if (error instanceof GameMasterInterruptedError) return { committed, interrupted: error };
  throw error;
};

export const playGameplayTurn = <A extends PlayerAction>(
  store: CampaignStore,
  narrator: Narrator,
  resolve: SceneResolver<A>,
  action: A,
  context: NarrationContext,
): GameplayOutcome => {
  resolve(store, action);
  const committed = storedTurnOf(store, loadState(store, action.campaignId), action.actionId);
  if (committed === undefined) throw new UncommittedTurnError(action.actionId);
  if (committed.turn.narration !== PENDING_NARRATION) return { committed, narration: committed.turn.narration };
  try {
    return recordChecked(store, committed, context, narrator.narrate(committed));
  } catch (error) {
    return interruptedOr(committed, error);
  }
};

export const narrateTurn = async (
  store: CampaignStore,
  narrator: AsyncNarrator,
  committed: CommittedTurn,
  context: NarrationContext,
): Promise<GameplayOutcome> => {
  if (committed.turn.narration !== PENDING_NARRATION) return { committed, narration: committed.turn.narration };
  try {
    const first = recordChecked(store, committed, context, await narrator.narrate(committed));
    if (!('inconsistent' in first) || !first.inconsistent.violations.some(isUnresolvedOutcome)) return first;
    return recordChecked(
      store,
      committed,
      context,
      await narrator.narrate(committed, first.inconsistent.violations.filter(isUnresolvedOutcome)),
    );
  } catch (error) {
    return interruptedOr(committed, error);
  }
};
