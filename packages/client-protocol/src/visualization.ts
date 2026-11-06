import type { Visibility } from '../../domain/src/entity.ts';
import { deepFreeze, PROTOCOL_VERSION, type ProtocolVersion } from './protocol.ts';

export const VISUALIZATION_EVENT = 'MechanicVisualized';
export const PLAYER_ROLLED = 'player';

export const VIEWER_SCOPES = ['player', 'gm'] as const;
export type ViewerScope = (typeof VIEWER_SCOPES)[number];

const PLAYER_VISIBLE: readonly Visibility[] = ['public', 'player'];

export type MechanicReveal =
  | { readonly kind: 'die'; readonly sides: number; readonly face: number }
  | { readonly kind: 'token'; readonly label: string };

export type RollModifierLine = {
  readonly id: string;
  readonly reason: string;
  readonly kind: 'flat' | 'dice' | 'keep' | 'step';
  readonly value?: number;
  readonly which?: 'highest' | 'lowest';
};

export type RollBreakdown = {
  readonly attribute?: { readonly id: string; readonly value: number };
  readonly modifiers: readonly RollModifierLine[];
  readonly target?: number;
  readonly kept?: number;
};

export type MechanicResult = {
  readonly resultId: string;
  readonly mechanic: string;
  readonly visibility: Visibility;
  readonly reveals: readonly MechanicReveal[];
  readonly modifier?: number;
  readonly total?: number;
  readonly outcome?: string;
  readonly source?: typeof PLAYER_ROLLED;
  readonly roller?: string;
  readonly breakdown?: RollBreakdown;
};

export type VisualizationFrame = { readonly step: number; readonly reveal: MechanicReveal };

export type VisualizationFinal = {
  readonly total: number | undefined;
  readonly outcome: string | undefined;
  readonly modifier?: number;
  readonly source?: typeof PLAYER_ROLLED;
  readonly roller?: string;
  readonly breakdown?: RollBreakdown;
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
const OUTCOME_KEY = 'outcome.';

export const outcomeLabel = (outcome: string) => outcome.split(OUTCOME_SEPARATOR).at(-1) || outcome;

export const outcomeText = (translate: (locale: string, key: string) => string, locale: string, outcome: string) => {
  const label = outcomeLabel(outcome);
  const key = `${OUTCOME_KEY}${label}`;
  const text = translate(locale, key);
  return text === key ? label : text;
};

const finalOf = ({ total, outcome, modifier, source, roller, breakdown }: MechanicResult): VisualizationFinal => ({
  total,
  outcome,
  ...(modifier === undefined ? {} : { modifier }),
  ...(source === undefined ? {} : { source }),
  ...(roller === undefined ? {} : { roller }),
  ...(breakdown === undefined ? {} : { breakdown: structuredClone(breakdown) }),
});

type Translate = (locale: string, key: string, params?: Record<string, string | number>) => string;

const SIGN_POSITIVE = '+';
const signed = (value: number) => (value < 0 ? String(value) : `${SIGN_POSITIVE}${value}`);

const modifierLine = (translate: Translate, locale: string, line: RollModifierLine) => {
  const { id, reason, kind, value, which } = line;
  const effect =
    kind === 'keep'
      ? translate(locale, `roll.breakdown.keep.${which}`)
      : translate(locale, `roll.breakdown.${kind}`, { value: signed(value ?? 0) });
  return translate(locale, 'roll.breakdown.modifier', { id, effect, reason });
};

export const breakdownLines = (
  faces: readonly number[],
  final: VisualizationFinal,
  translate: Translate,
  locale: string,
): string[] => {
  const { breakdown, total } = final;
  if (breakdown === undefined) return [];
  const { kept } = breakdown;
  const die = kept !== undefined && faces.length > 1 ? `${kept} (${faces.join(', ')})` : faces.join(', ');
  return [
    ...(die === '' ? [] : [translate(locale, 'roll.breakdown.die', { value: die })]),
    ...(breakdown.attribute === undefined
      ? []
      : [
          translate(locale, 'roll.breakdown.attribute', {
            name: breakdown.attribute.id,
            value: signed(breakdown.attribute.value),
          }),
        ]),
    ...breakdown.modifiers.map((line) => modifierLine(translate, locale, line)),
    ...(total === undefined
      ? []
      : [
          breakdown.target === undefined
            ? translate(locale, 'roll.breakdown.total', { total })
            : translate(locale, 'roll.breakdown.against', { total, target: breakdown.target }),
        ]),
  ];
};

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
