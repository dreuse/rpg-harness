import { randomUUID } from 'node:crypto';
import {
  type CampaignEvent,
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type CharacterId,
  type CommittedTurn,
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

export class InvalidActionError extends Error {
  readonly actionId: string;
  constructor(actionId: string, reason: string) {
    super(`action ${actionId} is invalid: ${reason}`);
    this.actionId = actionId;
  }
}

export type OpeningScene = {
  readonly campaignId: CampaignId;
  readonly actorName: string;
  readonly sceneTitle: string;
  readonly narration: string;
};

const PENDING_NARRATION = '';
const SUBMITTED = 'PlayerActionSubmitted';
const VALIDATED = 'ActionValidated';
const SCENE_OPENED = 'SceneOpened';
const OPENING_ACTION = 'opening';
const OPENING_INPUT = 'Begin.';

const turnEvent = (turn: Turn, causationId: string | null, type: string, payload: Record<string, unknown>) => ({
  id: randomUUID(),
  campaignId: turn.campaignId,
  turnId: turn.id,
  causationId,
  type,
  payload,
});

const loadState = (store: CampaignStore, campaignId: CampaignId) => {
  const state = store.load(campaignId);
  if (state === undefined) throw new CampaignNotFoundError(campaignId);
  return state;
};

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
  const event = (causationId: string | null, type: string, payload: Record<string, unknown>): CampaignEvent =>
    turnEvent(turn, causationId, type, payload);
  const submitted = event(null, SUBMITTED, { actorId, sceneId, input, intent });
  return { turn, events: [submitted, event(submitted.id, VALIDATED, { revision: expectedRevision + 1 })] };
};

export const performAction = (store: CampaignStore, action: PlayerAction): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = storedTurn(state, action.actionId);
  if (stored !== undefined) return stored;
  validate(state, action);
  return store.commitTurn({
    expectedRevision: action.expectedRevision,
    characters: [],
    scenes: [],
    ...toCommittedTurn(action),
  });
};

export const openScene = (store: CampaignStore, opening: OpeningScene): CommittedTurn => {
  const { campaignId, actorName, sceneTitle, narration } = opening;
  const state = loadState(store, campaignId);
  requireValid(OPENING_ACTION, state.currentScene === undefined, `campaign ${campaignId} already has a scene`);
  requireValid(OPENING_ACTION, actorName.trim() !== '', 'actor name is blank');
  requireValid(OPENING_ACTION, sceneTitle.trim() !== '', 'scene title is blank');
  requireValid(OPENING_ACTION, narration.trim() !== '', 'narration is blank');
  const character = { id: randomUUID(), campaignId, name: actorName };
  const scene = { id: randomUUID(), campaignId, title: sceneTitle };
  const turn: Turn = {
    id: randomUUID(),
    campaignId,
    sceneId: scene.id,
    actionId: OPENING_ACTION,
    actorId: character.id,
    input: OPENING_INPUT,
    narration,
  };
  const events = [
    turnEvent(turn, null, SCENE_OPENED, { sceneId: scene.id, title: sceneTitle, actorId: character.id, actorName }),
  ];
  return store.commitTurn({ expectedRevision: state.revision, turn, characters: [character], scenes: [scene], events });
};
