import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import {
  dieShapeOf,
  GENERIC_DIE,
  type MotionSetting,
  outcomeLabel,
  outcomeText,
  tumbleFaces,
  VISUALIZATION_EVENT,
  type VisualizationEvent,
  type VisualizationFinal,
} from '../../../packages/client-protocol/src/visualization.ts';
import { translate } from './accessibility.ts';
import { escapeHtml } from './view.ts';

export const ROLL_MS = 900;
export const SETTLE_MS = 1200;
export const ROLL_HISTORY = 5;
export const TUMBLE_STEPS = 8;
const STILL_MS = 0;
const STILL_STEPS = 1;
const PART_SEPARATOR = ', ';

export type DiceGroup = { readonly shape: string; readonly sides: number; readonly dice: number[][] };
export type RollPlan = {
  readonly resultId: string;
  readonly mechanic: string;
  readonly animated: boolean;
  readonly durationMs: number;
  readonly groups: readonly DiceGroup[];
  readonly tokens: readonly string[];
  readonly final: VisualizationFinal;
};

const SHAPES: Readonly<Record<string, string>> = {
  d4: '<polygon points="50,6 94,88 6,88"/>',
  d6: '<rect x="10" y="10" width="80" height="80" rx="10"/>',
  d8: '<polygon points="50,4 94,50 50,96 6,50"/>',
  d10: '<polygon points="50,4 94,40 50,96 6,40"/>',
  d12: '<polygon points="50,4 95,37 78,92 22,92 5,37"/>',
  d20: '<polygon points="50,3 93,27 93,73 50,97 7,73 7,27"/>',
  [GENERIC_DIE]: '<circle cx="50" cy="50" r="45"/>',
};

export const effectiveMotion = (setting: MotionSetting, prefersReduced: boolean): MotionSetting =>
  setting === 'full' && prefersReduced ? 'reduced' : setting;

export const rollPlan = (event: VisualizationEvent, motion: MotionSetting): RollPlan => {
  const animated = motion === 'full';
  const steps = animated ? TUMBLE_STEPS : STILL_STEPS;
  const groups: DiceGroup[] = [];
  const tokens: string[] = [];
  for (const { reveal } of event.frames) {
    if (reveal.kind === 'token') {
      tokens.push(reveal.label);
      continue;
    }
    const group = groups.find(({ sides }) => sides === reveal.sides);
    const faces = tumbleFaces(reveal, steps);
    if (group === undefined) groups.push({ shape: dieShapeOf(reveal.sides), sides: reveal.sides, dice: [faces] });
    else group.dice.push(faces);
  }
  return {
    resultId: event.resultId,
    mechanic: event.mechanic,
    animated,
    durationMs: animated ? ROLL_MS : STILL_MS,
    groups,
    tokens,
    final: event.final,
  };
};

const signed = (value: number) => (value < 0 ? String(value) : `+${value}`);
const finalFace = (faces: readonly number[]) => faces.at(-1);

export const rollSummary = ({ groups, tokens, final }: RollPlan, locale: string) =>
  [
    ...groups.map(({ sides, dice }) => `d${sides} ${dice.map(finalFace).join(' ')}`),
    ...tokens,
    ...(final.modifier === undefined ? [] : [translate(locale, 'roll.modifier', { value: signed(final.modifier) })]),
    ...(final.total === undefined ? [] : [translate(locale, 'roll.total', { value: final.total })]),
    ...(final.outcome === undefined ? [] : [outcomeText(translate, locale, final.outcome)]),
    ...(final.source === undefined ? [] : [translate(locale, 'roll.reported')]),
    ...(final.roller === undefined ? [] : [translate(locale, 'roll.roller', { name: final.roller })]),
  ].join(PART_SEPARATOR);

const dieHtml = (shape: string, sides: number) => (faces: readonly number[]) =>
  `<span role="img" data-die="${shape}" aria-label="d${sides}: ${finalFace(faces)}"><svg viewBox="0 0 100 100" aria-hidden="true">${SHAPES[shape] ?? SHAPES[GENERIC_DIE]}</svg><span data-reel aria-hidden="true"><span data-strip>${[
    ...faces,
  ]
    .reverse()
    .map((face) => `<span>${face}</span>`)
    .join('')}</span></span></span>`;

const rollTotal = ({ total }: VisualizationFinal) =>
  total === undefined ? '' : `<span data-roll-total aria-hidden="true">${total}</span>`;

const rollOutcome = ({ outcome }: VisualizationFinal, locale: string) => {
  if (outcome === undefined) return '';
  const word = escapeHtml(outcomeText(translate, locale, outcome));
  return `<strong data-outcome="${escapeHtml(outcomeLabel(outcome))}" aria-hidden="true">${word}</strong>`;
};

export const renderRoll = (plan: RollPlan, locale: string) =>
  `<figure data-roll data-animated="${plan.animated}"><div data-roll-result><div data-dice>${plan.groups
    .map(
      ({ shape, sides, dice }) => `<div data-dice-group="${shape}">${dice.map(dieHtml(shape, sides)).join('')}</div>`,
    )
    .join(
      '',
    )}${plan.tokens.map((label) => `<span data-token>${escapeHtml(label)}</span>`).join('')}</div>${rollTotal(plan.final)}${rollOutcome(plan.final, locale)}</div><figcaption>${escapeHtml(rollSummary(plan, locale))}</figcaption>${plan.animated ? `<button type="button" data-roll-skip>${escapeHtml(translate(locale, 'roll.skip'))}</button>` : ''}</figure>`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isOptional = (value: unknown, type: 'number' | 'string') => value === undefined || typeof value === type;

const isFrame = (frame: unknown) => {
  if (!isRecord(frame) || typeof frame.step !== 'number' || !isRecord(frame.reveal)) return false;
  const { kind, sides, face, label } = frame.reveal;
  return kind === 'die'
    ? Number.isFinite(sides) && Number.isFinite(face)
    : kind === 'token' && typeof label === 'string';
};

export const parseVisualization = (message: Record<string, unknown>): VisualizationEvent | undefined => {
  const { version, type, resultId, mechanic, frames, final } = message;
  const valid =
    version === PROTOCOL_VERSION &&
    type === VISUALIZATION_EVENT &&
    typeof resultId === 'string' &&
    typeof mechanic === 'string' &&
    Array.isArray(frames) &&
    frames.every(isFrame) &&
    isRecord(final) &&
    isOptional(final.total, 'number') &&
    isOptional(final.outcome, 'string') &&
    isOptional(final.modifier, 'number') &&
    isOptional(final.roller, 'string');
  return valid ? (message as VisualizationEvent) : undefined;
};
