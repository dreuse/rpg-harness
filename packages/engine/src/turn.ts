import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ACTION_VALIDATED,
  CAMPAIGN_CONFIGURED,
  type CampaignEvent,
  type CampaignId,
  CampaignNotFoundError,
  type CampaignState,
  type CampaignStore,
  CHECK_RESOLVED,
  CHECK_SKIPPED,
  type Character,
  type CharacterId,
  type CommittedTurn,
  type EventId,
  type NoCheckReason,
  OPENING_ACTION_ID,
  PLAYER_ACTION_SUBMITTED,
  ROLL_REPORTED,
  SCENE_OPENED,
  type SceneId,
  StaleRevisionError,
  SYSTEM_TURN,
  type Turn,
  type TurnKind,
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
  readonly source?: typeof PLAYER_SOURCE;
  readonly reported?: readonly number[];
};
export const PLAYER_SOURCE = 'player';
export type Check = (actionId: string, rng: Rng) => CheckResolution;
export type NoCheck = { readonly noCheck: NoCheckReason };
export type ReportedRoll = { readonly reportedRoll: readonly number[] };
export type Step = readonly [type: string, payload: Record<string, unknown>, visibility?: TurnVisibility];

export { CHECK_RESOLVED, CHECK_SKIPPED };

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
  readonly locationKind?: string;
  readonly moodTags?: readonly string[];
  readonly narration: string;
  readonly config?: Readonly<Record<string, unknown>>;
};

const PENDING_NARRATION = '';
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

export const storedTurnOf = (store: CampaignStore, state: CampaignState, actionId: string): CommittedTurn | undefined =>
  storedTurn(state, actionId) ?? store.findTurn(state.campaign.id, actionId);

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

export const toCommittedTurn = (
  { campaignId, actionId, expectedRevision, sceneId, actorId, input, intent }: PlayerAction,
  kind?: TurnKind,
) => {
  const turn: Turn = {
    id: randomUUID(),
    campaignId,
    sceneId,
    actionId,
    actorId,
    input,
    narration: PENDING_NARRATION,
    ...(kind === undefined ? {} : { kind }),
  };
  const event = (causationId: string | null, type: string, payload: Record<string, unknown>): CampaignEvent =>
    turnEvent(turn, causationId, type, payload);
  const submitted = event(null, PLAYER_ACTION_SUBMITTED, { actorId, sceneId, input, intent });
  return { turn, events: [submitted, event(submitted.id, ACTION_VALIDATED, { revision: expectedRevision + 1 })] };
};

export const commit = (
  store: CampaignStore,
  action: PlayerAction,
  steps: readonly Step[],
  characters: readonly Character[] = [],
  kind?: TurnKind,
): CommittedTurn => {
  const { turn, events } = toCommittedTurn(action, kind);
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

export const commitSystem = (
  store: CampaignStore,
  action: PlayerAction,
  steps: readonly Step[],
  characters: readonly Character[] = [],
): CommittedTurn => commit(store, action, steps, characters, SYSTEM_TURN);

const sameAction = ({ turn, events }: CommittedTurn, action: PlayerAction) =>
  turn.sceneId === action.sceneId &&
  turn.actorId === action.actorId &&
  turn.input === action.input &&
  events.find(({ type }) => type === PLAYER_ACTION_SUBMITTED)?.payload.intent === action.intent;

export const recorded =
  (type: string, fields: Readonly<Record<string, unknown>>) =>
  ({ events }: CommittedTurn) =>
    events.some(
      (event) =>
        event.type === type &&
        Object.entries(fields).every(([key, value]) => isDeepStrictEqual(event.payload[key], value)),
    );

export const replayOf = (
  store: CampaignStore,
  state: CampaignState,
  action: PlayerAction,
  matches: (stored: CommittedTurn) => boolean = () => true,
): CommittedTurn | undefined => {
  const stored = storedTurnOf(store, state, action.actionId);
  if (stored !== undefined && !(sameAction(stored, action) && matches(stored)))
    throw new ActionIdConflictError(action.actionId);
  return stored;
};

export const performAction = (
  store: CampaignStore,
  action: PlayerAction,
  check?: Check | NoCheck | ReportedRoll,
  rng: Rng = Math.random,
): CommittedTurn => {
  const state = loadState(store, action.campaignId);
  const stored = replayOf(store, state, action);
  if (stored !== undefined) return stored;
  validate(state, action);
  if (typeof check === 'function') {
    const { reported, ...resolution } = check(action.actionId, rng);
    const report: Step[] =
      reported === undefined ? [] : [[ROLL_REPORTED, { values: reported, source: PLAYER_SOURCE }, PLAYER_VISIBLE]];
    return commit(store, action, [
      ...report,
      [CHECK_RESOLVED, { resolution: { ok: true, ...resolution } }, PLAYER_VISIBLE],
    ]);
  }
  if (check !== undefined && 'reportedRoll' in check)
    return commit(store, action, [
      [ROLL_REPORTED, { values: check.reportedRoll, source: PLAYER_SOURCE }, PLAYER_VISIBLE],
    ]);
  if (check !== undefined) return commit(store, action, [[CHECK_SKIPPED, { reason: check.noCheck }, PLAYER_VISIBLE]]);
  return store.commitTurn({
    expectedRevision: action.expectedRevision,
    characters: [],
    scenes: [],
    ...toCommittedTurn(action),
  });
};

export const openScene = (store: CampaignStore, opening: OpeningScene): CommittedTurn => {
  const { campaignId, actorName, sceneTitle, narration, locationKind, moodTags } = opening;
  const state = loadState(store, campaignId);
  requireValid(OPENING_ACTION_ID, state.currentScene === undefined, `campaign ${campaignId} already has a scene`);
  requireValid(OPENING_ACTION_ID, actorName.trim() !== '', 'actor name is blank');
  requireValid(OPENING_ACTION_ID, sceneTitle.trim() !== '', 'scene title is blank');
  requireValid(OPENING_ACTION_ID, narration.trim() !== '', 'narration is blank');
  const character = { id: randomUUID(), campaignId, name: actorName };
  const tags = {
    ...(locationKind === undefined ? {} : { locationKind }),
    ...(moodTags === undefined ? {} : { moodTags }),
  };
  const scene = { id: randomUUID(), campaignId, title: sceneTitle, ...tags };
  const turn: Turn = {
    id: randomUUID(),
    campaignId,
    sceneId: scene.id,
    actionId: OPENING_ACTION_ID,
    actorId: character.id,
    input: OPENING_INPUT,
    narration,
  };
  const opened = turnEvent(turn, null, SCENE_OPENED, {
    sceneId: scene.id,
    title: sceneTitle,
    ...tags,
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
