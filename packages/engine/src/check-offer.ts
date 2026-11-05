import {
  type CampaignEvent,
  type CampaignStore,
  CHECK_OFFERED,
  CHECK_RESOLVED,
  type CommittedTurn,
  PLAYER_ACTION_SUBMITTED,
} from '../../domain/src/campaign.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import { commit, loadState, type PlayerAction, recorded, replayOf, validate } from './turn.ts';

export type CheckOffer = {
  readonly offerId: string;
  readonly ruleId: string;
  readonly target: string;
  readonly label: string;
};

export type CheckOffering = PlayerAction & { readonly offer: CheckOffer };

const OFFER_FIELDS = ['offerId', 'ruleId', 'target', 'label'] as const;
const NOT_FOUND = -1;
export const GM_PROPOSAL_INPUT = 'GM proposal ';

const offerOf = (payload: CampaignEvent['payload']): CheckOffer | undefined => {
  const { offer } = payload;
  return isRecord(offer) && OFFER_FIELDS.every((field) => typeof offer[field] === 'string')
    ? (offer as CheckOffer)
    : undefined;
};

export const offerCheck = (store: CampaignStore, input: CheckOffering): CommittedTurn => {
  const state = loadState(store, input.campaignId);
  const stored = replayOf(store, state, input, recorded(CHECK_OFFERED, { offer: input.offer }));
  if (stored !== undefined) return stored;
  validate(state, input);
  return commit(store, input, [[CHECK_OFFERED, { offer: input.offer }, 'player']]);
};

export const pendingCheckOffer = (events: readonly CampaignEvent[]): CheckOffer | undefined => {
  const offered = events.findLastIndex(({ type }) => type === CHECK_OFFERED);
  if (offered === NOT_FOUND || events.slice(offered).some(({ type }) => type === CHECK_RESOLVED)) return undefined;
  return offerOf(events[offered]?.payload ?? {});
};

export const offerFollowsPlayerAction = (events: readonly CampaignEvent[]): boolean => {
  const offered = events.findLastIndex(({ type }) => type === CHECK_OFFERED);
  return events
    .slice(offered + 1)
    .some(
      ({ type, payload }) => type === PLAYER_ACTION_SUBMITTED && !String(payload.input).startsWith(GM_PROPOSAL_INPUT),
    );
};
