import { randomUUID } from 'node:crypto';
import {
  type CampaignEvent,
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type CharacterId,
  type SceneId,
  StaleRevisionError,
  type Turn,
} from '../../domain/src/campaign.ts';

export type PlayerAction = {
  readonly campaignId: CampaignId;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly sceneId: SceneId;
  readonly actorId: CharacterId;
  readonly input: string;
  readonly intent: string;
};

export type CommittedTurn = { readonly turn: Turn; readonly events: readonly CampaignEvent[] };

export class InvalidActionError extends Error {
  readonly actionId: string;
  constructor(actionId: string, reason: string) {
    super(`action ${actionId} is invalid: ${reason}`);
    this.actionId = actionId;
  }
}

const PENDING_NARRATION = '';
const SUBMITTED = 'PlayerActionSubmitted';
const VALIDATED = 'ActionValidated';

const storedTurn = (state: CampaignState, actionId: string): CommittedTurn | undefined => {
  const turn = state.turns.find((candidate) => candidate.actionId === actionId);
  if (turn === undefined) return undefined;
  return { turn, events: state.events.filter((event) => event.turnId === turn.id) };
};

const requireValid = (actionId: string, valid: boolean, reason: string) => {
  if (!valid) throw new InvalidActionError(actionId, reason);
};

const validate = (state: CampaignState, action: PlayerAction) => {
  const { actionId } = action;
  if (state.revision !== action.expectedRevision) throw new StaleRevisionError(action.expectedRevision, state.revision);
  requireValid(actionId, state.currentScene?.id === action.sceneId, `scene ${action.sceneId} is not the current scene`);
  requireValid(
    actionId,
    state.characters.some(({ id }) => id === action.actorId),
    `actor ${action.actorId} is not in the campaign`,
  );
  requireValid(actionId, action.input.trim() !== '', 'input is blank');
  requireValid(actionId, action.intent.trim() !== '', 'intent is blank');
};

const toCommittedTurn = ({ campaignId, actionId, expectedRevision, sceneId, actorId, input, intent }: PlayerAction) => {
  const turn: Turn = { id: randomUUID(), campaignId, sceneId, actionId, actorId, input, narration: PENDING_NARRATION };
  const event = (causationId: string | null, type: string, payload: Record<string, unknown>): CampaignEvent => ({
    id: randomUUID(),
    campaignId,
    turnId: turn.id,
    causationId,
    type,
    payload,
  });
  const submitted = event(null, SUBMITTED, { actorId, sceneId, input, intent });
  return { turn, events: [submitted, event(submitted.id, VALIDATED, { revision: expectedRevision + 1 })] };
};

export const performAction = (store: CampaignStore, action: PlayerAction): CommittedTurn => {
  const state = store.load(action.campaignId);
  if (state === undefined) throw new CampaignNotFoundError(action.campaignId);
  const stored = storedTurn(state, action.actionId);
  if (stored !== undefined) return stored;
  validate(state, action);
  const committed = toCommittedTurn(action);
  store.commitTurn({ expectedRevision: action.expectedRevision, characters: [], scenes: [], ...committed });
  return committed;
};
