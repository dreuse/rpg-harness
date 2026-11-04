import {
  CAMPAIGN_CREATED,
  CAMPAIGN_RENAMED,
  type Campaign,
  type Character,
  type DomainEvent,
  type EventId,
  SCENE_OPENED,
  type Scene,
  type TurnId,
} from '../../domain/src/campaign.ts';
import { ROLL_EVENT_TYPE, type RollEvent, replayRoll } from '../../rules/src/dice.ts';
import { isRecord, type ManifestIssue } from '../../rules/src/rulepack.ts';
import type { Projection } from './replay.ts';

export const CAMPAIGN_PROJECTION_VERSION = 1;

export type CampaignTimelineState = {
  readonly campaign: Campaign | undefined;
  readonly revision: number;
  readonly characters: readonly Character[];
  readonly currentScene: Scene | undefined;
  readonly turnIds: readonly TurnId[];
  readonly rolls: readonly RollEvent[];
};

export class RecordedRollError extends Error {
  readonly eventId: EventId;
  readonly issues: readonly ManifestIssue[];
  constructor(eventId: EventId, issues: readonly ManifestIssue[]) {
    super(`event ${eventId} holds an invalid recorded roll: ${issues.map(({ message }) => message).join('; ')}`);
    this.eventId = eventId;
    this.issues = issues;
  }
}

const INITIAL_REVISION = 0;

const recordedRolls = (eventId: EventId, value: unknown): RollEvent[] => {
  if (Array.isArray(value)) return value.flatMap((item) => recordedRolls(eventId, item));
  if (!isRecord(value)) return [];
  if (value.type !== ROLL_EVENT_TYPE) return Object.values(value).flatMap((item) => recordedRolls(eventId, item));
  const replayed = replayRoll(value);
  if (!replayed.ok) throw new RecordedRollError(eventId, replayed.issues);
  return [replayed.event];
};

const withTurn = (turnIds: readonly TurnId[], turnId: TurnId | null) =>
  turnId === null || turnIds.at(-1) === turnId ? turnIds : [...turnIds, turnId];

const applyType = (state: CampaignTimelineState, { campaignId, type, payload }: DomainEvent): CampaignTimelineState => {
  if (type === CAMPAIGN_CREATED || type === CAMPAIGN_RENAMED) {
    return { ...state, campaign: { id: campaignId, name: String(payload.name) } };
  }
  if (type !== SCENE_OPENED) return state;
  const actor = { id: String(payload.actorId), campaignId, name: String(payload.actorName) };
  return {
    ...state,
    characters: [...state.characters, actor],
    currentScene: { id: String(payload.sceneId), campaignId, title: String(payload.title) },
  };
};

export const campaignProjection: Projection<CampaignTimelineState> = {
  version: CAMPAIGN_PROJECTION_VERSION,
  initial: {
    campaign: undefined,
    revision: INITIAL_REVISION,
    characters: [],
    currentScene: undefined,
    turnIds: [],
    rolls: [],
  },
  apply: (state, event) =>
    applyType(
      {
        ...state,
        revision: event.revision,
        turnIds: withTurn(state.turnIds, event.turnId),
        rolls: [...state.rolls, ...recordedRolls(event.id, event.payload)],
      },
      event,
    ),
};
