import {
  type MechanicResult,
  type MechanicReveal,
  toVisualizationEvent,
  type ViewerScope,
  type VisualizationEvent,
  type VisualizationPreference,
} from '../../../packages/client-protocol/src/visualization.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import type { RollEvent } from '../../../packages/rules/src/dice.ts';
import type { PoolRoll } from '../../../packages/rules/src/dice-pool-lite.ts';

export const DICE_MECHANIC = 'dice';
export const POOL_MECHANIC = 'dice-pool';

const revealsOf = ({ pool, draws }: RollEvent): MechanicReveal[] =>
  pool.dice.flatMap(({ sides }, index) => (draws[index] ?? []).map((face) => ({ kind: 'die', sides, face }) as const));

export const rollResult = (roll: RollEvent, visibility: Visibility, outcome?: string): MechanicResult => ({
  resultId: roll.rollId,
  mechanic: DICE_MECHANIC,
  visibility,
  reveals: revealsOf(roll),
  modifier: roll.pool.modifier,
  total: roll.total,
  ...(outcome === undefined ? {} : { outcome }),
});

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
