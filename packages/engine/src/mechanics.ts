import { isDeepStrictEqual } from 'node:util';
import type { CampaignStore, CommittedTurn } from '../../domain/src/campaign.ts';
import type { RuleCitation, RulePackLink } from '../../domain/src/character.ts';
import type { Rng } from '../../rules/src/dice.ts';
import { type EffectiveMechanic, GM_ADJUDICATED } from '../../rules/src/dsl.ts';
import { resolveAction } from '../../rules/src/resolve.ts';
import type { TraitSheet } from '../../rules/src/traits.ts';
import {
  commitSystem,
  InvalidActionError,
  loadState,
  type PlayerAction,
  requireValid,
  storedTurnOf,
  validate,
} from './turn.ts';

export type CitedRuleMove = PlayerAction & {
  readonly citation: RuleCitation;
  readonly rulePack: RulePackLink;
  readonly mechanics: readonly EffectiveMechanic[];
  readonly sheet: TraitSheet;
  readonly rng: Rng;
  readonly modifiers?: Readonly<Record<string, number>>;
};

export type RuleCitationErrorCode = 'UnknownRule' | 'RulePackMismatch' | 'SourceMismatch';

export class RuleCitationError extends InvalidActionError {
  readonly code: RuleCitationErrorCode;
  constructor(actionId: string, code: RuleCitationErrorCode, reason: string) {
    super(actionId, reason);
    this.code = code;
  }
}

const RESOLVED = 'RuleResolved';
const ADJUDICATED = 'RuleAdjudicated';
const INVALID_ACTION = 'InvalidAction';

const citedMechanic = ({ actionId, citation, rulePack, mechanics }: CitedRuleMove): EffectiveMechanic => {
  const reject = (code: RuleCitationErrorCode, reason: string): never => {
    throw new RuleCitationError(actionId, code, reason);
  };
  if (!isDeepStrictEqual({ ...citation.rulepack }, { ...rulePack })) {
    reject('RulePackMismatch', `citation pins ${citation.rulepack.id}@${citation.rulepack.revision}`);
  }
  const mechanic =
    mechanics.find(({ ruleId }) => ruleId === citation.ruleId) ??
    reject('UnknownRule', `rule ${citation.ruleId} is not in the effective ruleset`);
  if (!isDeepStrictEqual({ ...mechanic.rulePack }, { ...rulePack })) {
    reject(
      'RulePackMismatch',
      `rule ${citation.ruleId} belongs to ${mechanic.rulePack.id}@${mechanic.rulePack.revision}`,
    );
  }
  if (mechanic.source.sourceRef !== citation.section) {
    reject('SourceMismatch', `rule ${citation.ruleId} comes from ${mechanic.source.sourceRef}`);
  }
  return mechanic;
};

export const resolveCitedRule = (store: CampaignStore, move: CitedRuleMove): CommittedTurn => {
  const state = loadState(store, move.campaignId);
  const stored = storedTurnOf(store, state, move.actionId);
  if (stored !== undefined) return stored;
  validate(state, move);
  const { actionId, actorId, citation, sheet, rng, modifiers = {} } = move;
  requireValid(actionId, sheet.characterId === actorId, `sheet does not belong to ${actorId}`);
  const mechanic = citedMechanic(move);
  const { rulePack, source } = mechanic;
  if (mechanic.kind === GM_ADJUDICATED || !mechanic.rule.deterministic) {
    const { reason, issues } =
      mechanic.kind === GM_ADJUDICATED ? mechanic : { reason: 'AdjudicatedCapability', issues: [] };
    return commitSystem(store, move, [
      [ADJUDICATED, { mode: GM_ADJUDICATED, citation, rulePack, source, reason, issues }],
    ]);
  }
  const result = resolveAction({ actionId, rule: mechanic.rule.rule, sheet, rng, modifiers });
  requireValid(actionId, result.ok || result.error.code !== INVALID_ACTION, 'sheet or modifiers are invalid');
  const resolution = result.ok
    ? { ok: true, changes: result.changes, events: result.events, rolls: result.rolls }
    : result;
  return commitSystem(store, move, [[RESOLVED, { citation, rulePack, source, modifiers, resolution }]]);
};
