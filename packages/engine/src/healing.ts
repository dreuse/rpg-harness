import { type CampaignStore, type CommittedTurn, HEALING_APPLIED } from '../../domain/src/campaign.ts';
import type { Combatant } from './damage.ts';
import { commitSystem, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export type Healing = PlayerAction & { readonly target: Combatant; readonly amount: number };

const MIN_HEALING = 1;
const PLAYER_VISIBLE = 'player';

export const healCombatant = (store: CampaignStore, input: Healing): CommittedTurn => {
  const { actionId, target, amount } = input;
  const state = loadState(store, input.campaignId);
  const stored = replayOf(store, state, input, recorded(HEALING_APPLIED, { targetId: target.id, amount }));
  if (stored !== undefined) return stored;
  validate(state, input);
  const missing = target.max - target.current;
  requireValid(
    actionId,
    Number.isInteger(amount) && amount >= MIN_HEALING && amount <= missing,
    `healing must be a whole number from ${MIN_HEALING} to ${missing}`,
  );
  return commitSystem(store, input, [[HEALING_APPLIED, { targetId: target.id, amount }, PLAYER_VISIBLE]]);
};
