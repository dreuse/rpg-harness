import {
  type MechanicResult,
  type MechanicReveal,
  toVisualizationEvent,
  type ViewerScope,
  type VisualizationEvent,
  type VisualizationPreference,
} from '../../../packages/client-protocol/src/visualization.ts';
import type { CampaignEvent } from '../../../packages/domain/src/campaign.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import { type RollEvent, replayRoll } from '../../../packages/rules/src/dice.ts';
import type { PoolRoll } from '../../../packages/rules/src/dice-pool-lite.ts';
import type { ActionResolution } from '../../../packages/rules/src/resolve.ts';
import { isRecord } from '../../../packages/rules/src/rulepack.ts';

export const DICE_MECHANIC = 'dice';
export const POOL_MECHANIC = 'dice-pool';

const NO_BONUS = 0;
const VISUALIZATION_OFF: VisualizationPreference = { enabled: false };

const revealsOf = ({ pool, draws }: RollEvent): MechanicReveal[] =>
  pool.dice.flatMap(({ sides }, index) => (draws[index] ?? []).map((face) => ({ kind: 'die', sides, face }) as const));

export const rollResult = (
  roll: RollEvent,
  visibility: Visibility,
  outcome?: string,
  bonus = NO_BONUS,
): MechanicResult => ({
  resultId: roll.rollId,
  mechanic: DICE_MECHANIC,
  visibility,
  reveals: revealsOf(roll),
  modifier: roll.pool.modifier + bonus,
  total: roll.total + bonus,
  ...(outcome === undefined ? {} : { outcome }),
});

const outcomeOf = ({ ok, events, error }: Readonly<Record<string, unknown>>) => {
  const source = ok === true ? (Array.isArray(events) ? events[0] : undefined) : error;
  const named = isRecord(source) ? (ok === true ? source.event : source.code) : undefined;
  return typeof named === 'string' ? named : undefined;
};

export const checkResult = (check: ActionResolution, bonus: number, visibility: Visibility): MechanicResult[] => {
  const [d20] = check.rolls;
  return d20 === undefined ? [] : [rollResult(d20, visibility, outcomeOf(check), bonus)];
};

export const resultsOf = (payload: unknown, visibility: Visibility): MechanicResult[] => {
  const resolution = isRecord(payload) ? payload.resolution : undefined;
  if (!isRecord(resolution) || !Array.isArray(resolution.rolls)) return [];
  const outcome = outcomeOf(resolution);
  return resolution.rolls.flatMap((stored) => {
    const replayed = replayRoll(stored);
    return replayed.ok ? [rollResult(replayed.event, visibility, outcome)] : [];
  });
};

export const visualizationPreferenceOf = (events: readonly CampaignEvent[]): VisualizationPreference => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  return saved.ok ? { enabled: saved.config.values.diceVisualization } : VISUALIZATION_OFF;
};

export const poolResult = (resultId: string, roll: PoolRoll, visibility: Visibility): MechanicResult => ({
  resultId,
  mechanic: POOL_MECHANIC,
  visibility,
  reveals: roll.rolls.flatMap(revealsOf),
  total: roll.successes,
  outcome: roll.outcome,
});

export const emitVisualizations = (
  results: readonly MechanicResult[],
  viewer: ViewerScope,
  preference: VisualizationPreference,
): VisualizationEvent[] => results.flatMap((result) => toVisualizationEvent(result, viewer, preference) ?? []);
