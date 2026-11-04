import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CAMPAIGN_CONFIGURED,
  type CampaignEvent,
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  type Character,
  type CharacterId,
  type CommittedTurn,
  type EventId,
  SCENE_OPENED,
  type SceneId,
  StaleRevisionError,
  type Turn,
  type TurnVisibility,
} from '../../domain/src/campaign.ts';
import type { Rng, RollEvent } from '../../rules/src/dice.ts';

export type PlayerAction = {
  readonly campaignId: CampaignId;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly sceneId: SceneId;
  readonly actorId: CharacterId;
  readonly input: string;
  readonly intent: string;
};

export type CheckResolution = {
  readonly rolls: readonly RollEvent[];
  readonly events: readonly { readonly event: string }[];
  readonly bonus?: number;
};
export type Check = (actionId: string, rng: Rng) => CheckResolution;
export type Step = readonly [type: string, payload: Record<string, unknown>, visibility?: TurnVisibility];

export const CHECK_RESOLVED = 'CheckResolved';

export class InvalidActionError extends Error {
  readonly actionId: string;
  constructor(actionId: string, reason: string) {
    super(`action ${actionId} is invalid: ${reason}`);
    this.actionId = actionId;
  }
}

export class ActionIdConflictError extends InvalidActionError {
  constructor(actionId: string) {
    super(actionId, 'action id was already used for a different action');
  }
}

export type OpeningScene = {
  readonly campaignId: CampaignId;
  readonly actorName: string;
  readonly sceneTitle: string;
  readonly narration: string;
  readonly config?: Readonly<Record<string, unknown>>;
};

const PENDING_NARRATION = '';
const SUBMITTED = 'PlayerActionSubmitted';
const VALIDATED = 'ActionValidated';
const OPENING_ACTION = 'opening';
const OPENING_INPUT = 'Begin.';
const PLAYER_VISIBLE: TurnVisibility = 'player';

export const turnEvent = (turn: Turn, causationId: string | null, type: string, payload: Record<string, unknown>) => ({
  id: randomUUID(),
  campaignId: turn.campaignId,
  turnId: turn.id,
  causationId,
  type,
  payload,
});

export const loadState = (store: CampaignStore, campaignId: CampaignId) => {
  const state = store.load(campaignId);
  if (state === undefined) throw new CampaignNotFoundError(campaignId);
  return state;
};

export const storedTurn = (state: CampaignState, actionId: string): CommittedTurn | undefined => {
  const turn = state.turns.find((candidate) => candidate.actionId === actionId);
  if (turn === undefined) return undefined;
  return { turn, events: state.events.filter((event) => event.turnId === turn.id) };
};

export const requireValid = (actionId: string, valid: boolean, reason: string) => {
  if (!valid) throw new InvalidActionError(actionId, reason);
};

export const validate = (state: CampaignState, action: PlayerAction) => {
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

export const toCommittedTurn = ({
  campaignId,
  actionId,
  expectedRevision,
  sceneId,
  actorId,
  input,
  intent,
}: PlayerAction) => {
  const turn: Turn = { id: randomUUID(), campaignId, sceneId, actionId, actorId, input, narration: PENDING_NARRATION };
  const event = (causationId: string | null, type: string, payload: Record<string, unknown>): CampaignEvent =>
    turnEvent(turn, causationId, type, payload);
  const submitted = event(null, SUBMITTED, { actorId, sceneId, input, intent });
  return { turn, events: [submitted, event(submitted.id, VALIDATED, { revision: expectedRevision + 1 })] };
};

export const commit = (
  store: CampaignStore,
  action: PlayerAction,
  steps: readonly Step[],
  characters: readonly Character[] = [],
): CommittedTurn => {
  const { turn, events } = toCommittedTurn(action);
  const chained: CampaignEvent[] = [...events];
  const visibility: Record<EventId, TurnVisibility> = {};
  for (const [type, payload, shown] of steps) {
    const event = turnEvent(turn, chained.at(-1)?.id ?? null, type, payload);
    chained.push(event);
    if (shown !== undefined) visibility[event.id] = shown;
  }
  return store.commitTurn({
    expectedRevision: action.expectedRevision,
    turn,
    characters,
    scenes: [],
    events: chained,
    visibility,
  });
};

const sameAction = ({ turn, events }: CommittedTurn, action: PlayerAction) =>
  turn.sceneId === action.sceneId &&
  turn.actorId === action.actorId &&
  turn.input === action.input &&
  events.find(({ type }) => type === SUBMITTED)?.payload.intent === action.intent;

export const recorded =
  (type: string, fields: Readonly<Record<string, unknown>>) =>
  ({ events }: CommittedTurn) =>
    events.some(
      (event) =>
        event.type === type &&
        Object.entries(fields).every(([key, value]) => isDeepStrictEqual(event.payload[key], value)),
    );

export const replayOf = (
  state: CampaignState,
  action: PlayerAction,
  matches: (stored: CommittedTurn) => boolean = () => true,
): CommittedTurn | undefined => {
  const stored = storedTurn(state, action.actionId);
  if (stored !== undefined && !(sameAction(stored, action) && matches(stored)))
    throw new ActionIdConflictError(action.actionId);
  return stored;
};

export const performAction = (
  store: CampaignStore,
  action: PlayerAction,
  check?: Check,
  rng: Rng = Math.random,
): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = replayOf(state, action);
  if (stored !== undefined) return stored;
  validate(state, action);
  if (check !== undefined)
    return commit(store, action, [
      [CHECK_RESOLVED, { resolution: { ok: true, ...check(action.actionId, rng) } }, PLAYER_VISIBLE],
    ]);
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
  const opened = turnEvent(turn, null, SCENE_OPENED, {
    sceneId: scene.id,
    title: sceneTitle,
    actorId: character.id,
    actorName,
  });
  const events =
    opening.config === undefined
      ? [opened]
      : [opened, turnEvent(turn, opened.id, CAMPAIGN_CONFIGURED, { config: opening.config })];
  return store.commitTurn({ expectedRevision: state.revision, turn, characters: [character], scenes: [scene], events });
};

export const campaignConfigOf = (events: readonly CampaignEvent[]): unknown =>
  events.findLast(({ type }) => type === CAMPAIGN_CONFIGURED)?.payload.config;
