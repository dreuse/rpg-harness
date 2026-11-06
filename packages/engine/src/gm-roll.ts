import { type CampaignStore, type CommittedTurn, GM_ROLLED, type TurnVisibility } from '../../domain/src/campaign.ts';
import type { EntityKind, EntityStore, Visibility } from '../../domain/src/entity.ts';
import { createRoller, type DicePool, parseDiceExpression, type Rng } from '../../rules/src/dice.ts';
import {
  type EffectKind,
  type ModifierRequest,
  NO_VOCABULARY,
  resolveModifiers,
  summarizeModifiers,
} from '../../rules/src/modifiers.ts';
import { conditionModifiersOf, type ModifierPolicy, mergeModifiers } from './conditions.ts';
import { commitSystem, loadState, type PlayerAction, recorded, replayOf, requireValid, validate } from './turn.ts';

export const GM_ROLLER = 'gm';
export const PLAYER_ROLLER = 'player';
export const MAX_ROLL_SECTION_LENGTH = 120;
export const MAX_ROLL_REASON_LENGTH = 120;
export const MAX_ROLL_EXPRESSION_LENGTH = 40;
export const GM_ROLL_ACTION_INFIX = ':proposal:gm-roll:';
export const GM_ROLL_VISIBILITIES = ['shown', 'secret'] as const;
export type GmRollVisibility = (typeof GM_ROLL_VISIBILITIES)[number];

export type GmRollRequest = {
  readonly roller: string;
  readonly reason: string;
  readonly visibility: GmRollVisibility;
  readonly expression: string;
  readonly section?: string;
  readonly modifiers?: readonly ModifierRequest[];
};

export type GmRolling = PlayerAction & { readonly gmRoll: GmRollRequest };

const GM_ROLL_EFFECTS: readonly EffectKind[] = ['flat'];
const NPC_KIND: EntityKind = 'npc';
const ROLL_ID_SUFFIX = ':gm-roll';
const PLAYER_KNOWN: readonly Visibility[] = ['public', 'player'];
const EVENT_VISIBILITY: Readonly<Record<GmRollVisibility, TurnVisibility>> = { shown: 'player', secret: 'gm' };

export const gmRollIdOf = (actionId: string): string | undefined => {
  const at = actionId.lastIndexOf(GM_ROLL_ACTION_INFIX);
  return at < 0 ? undefined : actionId.slice(at + GM_ROLL_ACTION_INFIX.length);
};

export const rollForGm = (
  store: CampaignStore,
  entities: EntityStore,
  input: GmRolling,
  rng: Rng,
  policy?: ModifierPolicy,
): CommittedTurn => {
  const { campaignId, actionId, gmRoll } = input;
  const { roller, reason, visibility, expression, section, modifiers = [] } = gmRoll;
  const state = loadState(store, campaignId);
  const stored = replayOf(store, state, input, recorded(GM_ROLLED, { roller, reason, visibility, expression }));
  if (stored !== undefined) return stored;
  validate(state, input);
  requireValid(actionId, reason.trim() !== '', 'roll reason is blank');
  requireValid(actionId, reason.length <= MAX_ROLL_REASON_LENGTH, 'roll reason is too long');
  requireValid(actionId, expression.length <= MAX_ROLL_EXPRESSION_LENGTH, 'dice expression is too long');
  const unnamed = roller === GM_ROLLER || roller === PLAYER_ROLLER;
  const npc = unnamed ? undefined : entities.getEntity(campaignId, roller);
  requireValid(actionId, unnamed || npc?.kind === NPC_KIND, `roller ${roller} is not an npc`);
  requireValid(actionId, roller !== PLAYER_ROLLER || visibility === 'shown', 'a player roll is always shown');
  requireValid(actionId, (section?.length ?? 0) <= MAX_ROLL_SECTION_LENGTH, 'rule section is too long');
  requireValid(
    actionId,
    visibility === 'secret' || npc === undefined || PLAYER_KNOWN.includes(npc.visibility),
    `npc ${roller} is not known to the player`,
  );
  const pool = parseDiceExpression(expression);
  requireValid(actionId, pool !== undefined, `dice expression ${expression} is invalid`);
  requireValid(actionId, modifiers.length === 0 || policy !== undefined, 'modifiers need a rulepack');
  const resolved = resolveModifiers(
    policy?.vocabulary ?? NO_VOCABULARY,
    modifiers,
    policy?.strictness ?? 'as-written',
    GM_ROLL_EFFECTS,
    policy?.cites,
  );
  requireValid(actionId, resolved.ok, resolved.ok ? '' : resolved.issues.map(({ message }) => message).join('; '));
  const fromConditions =
    policy === undefined || section === undefined
      ? []
      : roller === PLAYER_ROLLER
        ? conditionModifiersOf(state.events, input.actorId, section).filter(({ effect }) =>
            GM_ROLL_EFFECTS.includes(effect.kind),
          )
        : [];
  const applied = mergeModifiers(resolved.ok ? resolved.applied : [], fromConditions);
  const summary = summarizeModifiers(applied);
  requireValid(
    actionId,
    applied.every(({ effect }) => effect.kind === 'flat'),
    'a gm roll takes flat modifiers only',
  );
  const rolled = createRoller(rng)(`${actionId}${ROLL_ID_SUFFIX}`, {
    ...(pool as DicePool),
    modifier: (pool as DicePool).modifier + summary.flat,
  });
  if (!rolled.ok) throw new RangeError(rolled.issues.map(({ message }) => message).join('; '));
  return commitSystem(store, input, [
    [
      GM_ROLLED,
      {
        roller,
        ...(npc === undefined ? {} : { rollerName: npc.name }),
        reason,
        visibility,
        expression,
        ...(section === undefined ? {} : { section }),
        resolution: {
          ok: true,
          rolls: [rolled.roll],
          events: [],
          ...(applied.length === 0 ? {} : { modifiers: applied }),
        },
      },
      EVENT_VISIBILITY[visibility],
    ],
  ]);
};
