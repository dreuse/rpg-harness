import {
  type CampaignEvent,
  type CampaignState,
  type CampaignStore,
  CHECK_OFFERED,
  CHECK_RESOLVED,
  type CommittedTurn,
  PLAYER_ACTION_SUBMITTED,
} from '../../domain/src/campaign.ts';
import { type AppliedModifier, type ModifierRequest, resolveModifiers } from '../../rules/src/modifiers.ts';
import { isRecord } from '../../rules/src/rulepack.ts';
import type { ModifierPolicy } from './conditions.ts';
import {
  commitSystem,
  GM_PROPOSAL_INPUT,
  loadState,
  type PlayerAction,
  replayOf,
  requireValid,
  validate,
} from './turn.ts';

export type CheckOffer = {
  readonly offerId: string;
  readonly ruleId: string;
  readonly target: string;
  readonly attacker?: string;
  readonly label: string;
  readonly difficulty?: string;
  readonly modifiers?: readonly AppliedModifier[];
};

export type CheckOffering = PlayerAction & {
  readonly offer: CheckOffer;
  readonly requested?: readonly ModifierRequest[];
  readonly policy?: ModifierPolicy;
};

const OFFER_FIELDS = ['offerId', 'ruleId', 'target', 'label'] as const;
const NOT_FOUND = -1;

export { GM_PROPOSAL_INPUT };

const PROPOSAL_ACTION_INFIX = ':proposal:';

export const proposalEventsOf = (
  { events, turns }: Pick<CampaignState, 'events' | 'turns'>,
  actionId: string,
): readonly CampaignEvent[] => {
  const proposalPrefix = `${actionId}${PROPOSAL_ACTION_INFIX}`;
  const proposalTurns = new Set(turns.filter((turn) => turn.actionId.startsWith(proposalPrefix)).map(({ id }) => id));
  return events.filter(({ turnId }) => proposalTurns.has(turnId));
};

export const offerOf = (payload: CampaignEvent['payload']): CheckOffer | undefined => {
  const { offer } = payload;
  return isRecord(offer) && OFFER_FIELDS.every((field) => typeof offer[field] === 'string')
    ? (offer as CheckOffer)
    : undefined;
};

const withModifiers = ({ actionId, offer, requested = [], policy }: CheckOffering): CheckOffer => {
  const { difficulty } = offer;
  const known =
    difficulty === undefined || (policy !== undefined && Object.hasOwn(policy.vocabulary.difficulties, difficulty));
  requireValid(actionId, known, `difficulty ${difficulty} is not in the rulepack`);
  if (requested.length === 0) return offer;
  requireValid(actionId, policy !== undefined, 'modifiers need a rulepack');
  const resolved = resolveModifiers(
    (policy as ModifierPolicy).vocabulary,
    requested,
    (policy as ModifierPolicy).strictness,
    undefined,
    (policy as ModifierPolicy).cites,
  );
  requireValid(actionId, resolved.ok, resolved.ok ? '' : resolved.issues.map(({ message }) => message).join('; '));
  return { ...offer, modifiers: resolved.ok ? resolved.applied : [] };
};

export const offerCheck = (store: CampaignStore, input: CheckOffering): CommittedTurn => {
  const state = loadState(store, input.campaignId);
  const { offerId, ruleId } = input.offer;
  const stored = replayOf(store, state, input, ({ events }) =>
    events.some(
      ({ type, payload }) =>
        type === CHECK_OFFERED &&
        isRecord(payload.offer) &&
        payload.offer.offerId === offerId &&
        payload.offer.ruleId === ruleId,
    ),
  );
  if (stored !== undefined) return stored;
  validate(state, input);
  const offer = withModifiers(input);
  return commitSystem(store, input, [[CHECK_OFFERED, { offer }, 'player']]);
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
