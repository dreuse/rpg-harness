import type { Visibility } from '../../domain/src/entity.ts';
import { deepFreeze, PROTOCOL_VERSION, type ProtocolVersion } from './protocol.ts';

export const VISUALIZATION_EVENT = 'MechanicVisualized';

export const VIEWER_SCOPES = ['player', 'gm'] as const;
export type ViewerScope = (typeof VIEWER_SCOPES)[number];

const PLAYER_VISIBLE: readonly Visibility[] = ['public', 'player'];

export type MechanicReveal =
  | { readonly kind: 'die'; readonly sides: number; readonly face: number }
  | { readonly kind: 'token'; readonly label: string };

export type MechanicResult = {
  readonly resultId: string;
  readonly mechanic: string;
  readonly visibility: Visibility;
  readonly reveals: readonly MechanicReveal[];
  readonly modifier?: number;
  readonly total?: number;
  readonly outcome?: string;
};

export type VisualizationFrame = { readonly step: number; readonly reveal: MechanicReveal };

export type VisualizationFinal = {
  readonly total: number | undefined;
  readonly outcome: string | undefined;
  readonly modifier?: number;
};

export type VisualizationEvent = {
  readonly version: ProtocolVersion;
  readonly type: typeof VISUALIZATION_EVENT;
  readonly resultId: string;
  readonly mechanic: string;
  readonly frames: readonly VisualizationFrame[];
  readonly final: VisualizationFinal;
  readonly replayed?: true;
};

export type VisualizationPreference = { readonly enabled: boolean };

export const MOTION_SETTINGS = ['full', 'reduced', 'off'] as const;
export type MotionSetting = (typeof MOTION_SETTINGS)[number];
export const GENERIC_DIE = 'generic';
const DIE_SHAPES: readonly number[] = [4, 6, 8, 10, 12, 20];
const TUMBLE_STRIDE = 3;

export const dieShapeOf = (sides: number) => (DIE_SHAPES.includes(sides) ? `d${sides}` : GENERIC_DIE);

export const tumbleFaces = ({ sides, face }: Extract<MechanicReveal, { kind: 'die' }>, steps: number) => {
  if (!Number.isInteger(sides) || sides < 1 || steps < 1) return [face];
  const cosmetic = Array.from(
    { length: steps - 1 },
    (_, step) => ((face + (steps - step) * TUMBLE_STRIDE) % sides) + 1,
  );
  return [...cosmetic, face];
};

const canSee = (visibility: Visibility, viewer: ViewerScope) => viewer === 'gm' || PLAYER_VISIBLE.includes(visibility);

const copyReveal = (reveal: MechanicReveal): MechanicReveal =>
  reveal.kind === 'die'
    ? { kind: reveal.kind, sides: reveal.sides, face: reveal.face }
    : { kind: reveal.kind, label: reveal.label };

const OUTCOME_SEPARATOR = '.';

export const outcomeLabel = (outcome: string) => outcome.split(OUTCOME_SEPARATOR).at(-1) || outcome;

const finalOf = ({ total, outcome, modifier }: MechanicResult): VisualizationFinal =>
  modifier === undefined ? { total, outcome } : { total, outcome, modifier };

export const toVisualizationEvent = (
  result: MechanicResult,
  viewer: ViewerScope,
  preference: VisualizationPreference,
): VisualizationEvent | undefined => {
  if (!preference.enabled || !canSee(result.visibility, viewer)) return undefined;
  return deepFreeze({
    version: PROTOCOL_VERSION,
    type: VISUALIZATION_EVENT,
    resultId: result.resultId,
    mechanic: result.mechanic,
    frames: result.reveals.map((reveal, step) => ({ step, reveal: copyReveal(reveal) })),
    final: finalOf(result),
  });
};
