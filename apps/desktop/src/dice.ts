import { contentText } from '../../../packages/client-protocol/src/content-names.ts';
import { PROTOCOL_VERSION } from '../../../packages/client-protocol/src/protocol.ts';
import {
  breakdownLines,
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
import { ATTRIBUTE_LABELS } from '../../../packages/rules/src/d20-lite.ts';
import { translate } from './accessibility.ts';
import { escapeHtml } from './view.ts';

export const ROLL_MS = 900;
export const SETTLE_MS = 1200;
export const ROLL_HISTORY = 5;
export const ROLL_COLLAPSE_MS = 4000;
export const TUMBLE_STEPS = 8;
const STILL_MS = 0;
const STILL_STEPS = 1;
const PART_SEPARATOR = ', ';

export type DiceGroup = { readonly shape: string; readonly sides: number; readonly dice: number[][] };
export type RollPlan = {
  readonly resultId: string;
  readonly actionId?: string | undefined;
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
    ...(event.actionId === undefined ? {} : { actionId: event.actionId }),
    mechanic: event.mechanic,
    animated,
    durationMs: animated ? ROLL_MS : STILL_MS,
    groups,
    tokens,
    final: event.final,
  };
};

export const signed = (value: number) => (value < 0 ? String(value) : `+${value}`);
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

const attributeLabel = (id: string, locale: string) => {
  const label = Object.hasOwn(ATTRIBUTE_LABELS, id) ? ATTRIBUTE_LABELS[id as keyof typeof ATTRIBUTE_LABELS] : undefined;
  return label === undefined ? id : contentText(locale, 'stat', label, label);
};

const labelled = (final: VisualizationFinal, locale: string): VisualizationFinal => {
  const { breakdown } = final;
  return breakdown?.attribute === undefined
    ? final
    : {
        ...final,
        breakdown: {
          ...breakdown,
          attribute: { ...breakdown.attribute, id: attributeLabel(breakdown.attribute.id, locale) },
        },
      };
};

const rollBreakdown = ({ groups, final }: RollPlan, locale: string) => {
  const faces =
    final.breakdown?.kept === undefined
      ? []
      : groups.flatMap(({ dice }) => dice.flatMap((die) => finalFace(die) ?? []));
  const lines = breakdownLines(faces, labelled(final, locale), translate, locale);
  return lines.length === 0
    ? ''
    : `<ul data-roll-breakdown>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
};

const rollRoller = ({ roller }: VisualizationFinal, locale: string) =>
  roller === undefined
    ? ''
    : `<span data-roller>${escapeHtml(translate(locale, 'roll.roller', { name: roller }))}</span>`;

const rollReportedBadge = ({ source }: VisualizationFinal, locale: string) =>
  source === undefined ? '' : `<span data-reported-badge>${escapeHtml(translate(locale, 'roll.reported'))}</span>`;

export const renderRoll = (plan: RollPlan, locale: string) =>
  `<figure data-roll data-animated="${plan.animated}"${plan.final.source === undefined ? '' : ' data-reported'}><div data-roll-result><div data-dice>${plan.groups
    .map(
      ({ shape, sides, dice }) => `<div data-dice-group="${shape}">${dice.map(dieHtml(shape, sides)).join('')}</div>`,
    )
    .join(
      '',
    )}${plan.tokens.map((label) => `<span data-token>${escapeHtml(label)}</span>`).join('')}</div>${rollTotal(plan.final)}${rollOutcome(plan.final, locale)}${rollReportedBadge(plan.final, locale)}${rollRoller(plan.final, locale)}</div>${rollBreakdown(plan, locale)}<figcaption>${escapeHtml(rollSummary(plan, locale))}</figcaption>${plan.animated ? `<button type="button" data-roll-skip>${escapeHtml(translate(locale, 'roll.skip'))}</button>` : ''}</figure>`;

const badgeResult = (plan: RollPlan, locale: string) => {
  const { total, outcome } = plan.final;
  const parts = [total, outcome === undefined ? undefined : outcomeText(translate, locale, outcome)].filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? rollSummary(plan, locale) : parts.join(PART_SEPARATOR);
};

export const renderRollBadge = (plan: RollPlan, locale: string, fresh: boolean) => {
  const { total, outcome } = plan.final;
  const shape = plan.groups[0]?.shape ?? GENERIC_DIE;
  const label = escapeHtml(translate(locale, 'roll.badge', { result: badgeResult(plan, locale) }));
  const attributes = outcome === undefined ? '' : ` data-outcome="${escapeHtml(outcomeLabel(outcome))}"`;
  return `<button type="button" data-roll-badge${fresh ? ' data-fresh' : ''} aria-label="${label}"${attributes}><svg viewBox="0 0 100 100" aria-hidden="true">${SHAPES[shape] ?? SHAPES[GENERIC_DIE]}</svg><span aria-hidden="true">${total ?? ''}</span></button>`;
};

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
    isOptional(final.roller, 'string') &&
    (final.breakdown === undefined || (isRecord(final.breakdown) && Array.isArray(final.breakdown.modifiers)));
  return valid ? (message as VisualizationEvent) : undefined;
};
