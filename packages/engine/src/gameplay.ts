import {
  type CampaignState,
  type CampaignStore,
  type CommittedTurn,
  GM_ROLLED,
  type TurnSegment,
} from '../../domain/src/campaign.ts';
import {
  type ConsistencyInput,
  type ConsistencyReport,
  checkConsistency,
  type OutcomeResult,
  type Violation,
} from '../../narrative/src/consistency.ts';
import { gmRollIdOf } from './gm-roll.ts';
import { GameMasterInterruptedError } from './scripted-session.ts';
import { CHECK_RESOLVED, CHECK_SKIPPED, loadState, type PlayerAction, storedTurnOf } from './turn.ts';

export type NarratedTurn = Pick<ConsistencyInput, 'narration' | 'claims'> & {
  readonly segments?: readonly TurnSegment[];
};

export type NarrationContext = Omit<
  ConsistencyInput,
  'narration' | 'claims' | 'events' | 'checkResolved' | 'resolvedOutcome'
>;

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
const PROPOSAL_INFIX = ':proposal:';

const OUTCOME_VIOLATIONS: readonly string[] = ['unresolved-outcome', 'outcome-mismatch'];

const isOutcomeViolation = ({ kind }: Violation) => OUTCOME_VIOLATIONS.includes(kind);

const HIT_EVENTS: readonly string[] = ['check.success', 'attack.hit'];
const MISS_EVENTS: readonly string[] = ['check.failure', 'attack.miss'];

const resolvedEventNames = ({ payload }: CommittedTurn['events'][number]): readonly string[] => {
  const { resolution } = payload as { resolution?: { events?: readonly { event?: unknown }[] } };
  return (resolution?.events ?? []).flatMap(({ event }) => (typeof event === 'string' ? [event] : []));
};

const outcomeOfEvent = (event: CommittedTurn['events'][number]): OutcomeResult | null => {
  const names = resolvedEventNames(event);
  if (names.some((name) => HIT_EVENTS.includes(name))) return 'hit';
  return names.some((name) => MISS_EVENTS.includes(name)) ? 'miss' : null;
};

const resolvedOutcomeOf = ({ events }: CommittedTurn): OutcomeResult | null => {
  const outcomes = events.filter(({ type }) => type === CHECK_RESOLVED).map(outcomeOfEvent);
  const [first = null] = outcomes;
  return outcomes.every((outcome) => outcome === first) ? first : null;
};

const gmRollIdsOf = (
  { events, turns }: Pick<CampaignState, 'events' | 'turns'>,
  { turn }: CommittedTurn,
): ReadonlySet<string> => {
  const proposalPrefix = `${turn.actionId}${PROPOSAL_INFIX}`;
  const actionOf = new Map(turns.map(({ id, actionId }) => [id, actionId]));
  const rolled = events
    .filter(({ type }) => type === GM_ROLLED)
    .map(({ turnId }) => actionOf.get(turnId) ?? '')
    .filter((actionId) => actionId.startsWith(proposalPrefix))
    .map(gmRollIdOf);
  return new Set(rolled.filter((id) => id !== undefined));
};

const recordChecked = (
  store: CampaignStore,
  committed: CommittedTurn,
  context: NarrationContext,
  { narration, claims, segments }: NarratedTurn,
): GameplayOutcome => {
  const state = loadState(store, committed.turn.campaignId);
  const { events } = state;
  const checkResolved = committed.events.some(({ type }) => type === CHECK_RESOLVED || type === CHECK_SKIPPED);
  const resolvedOutcome = resolvedOutcomeOf(committed);
  const rolledIds = gmRollIdsOf(state, committed);
  const unrolled = claims.filter(({ kind, ref }) => kind !== 'outcome' || !rolledIds.has(ref));
  const report = checkConsistency({ ...context, narration, claims: unrolled, events, checkResolved, resolvedOutcome });
  if (!report.ok) return { committed, inconsistent: report };
  store.recordNarration(committed.turn.campaignId, committed.turn.id, narration, segments);
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
    if (!('inconsistent' in first) || !first.inconsistent.violations.some(isOutcomeViolation)) return first;
    return recordChecked(
      store,
      committed,
      context,
      await narrator.narrate(committed, first.inconsistent.violations.filter(isOutcomeViolation)),
    );
  } catch (error) {
    return interruptedOr(committed, error);
  }
};
