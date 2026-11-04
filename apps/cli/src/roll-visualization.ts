import {
  type MechanicResult,
  type MechanicReveal,
  toVisualizationEvent,
  type ViewerScope,
  type VisualizationEvent,
  type VisualizationPreference,
} from '../../../packages/client-protocol/src/visualization.ts';
import type { CampaignEvent, CharacterId } from '../../../packages/domain/src/campaign.ts';
import { parseCharacterProfile } from '../../../packages/domain/src/character.ts';
import type { Visibility } from '../../../packages/domain/src/entity.ts';
import { profileOf } from '../../../packages/engine/src/character.ts';
import { type Check, campaignConfigOf } from '../../../packages/engine/src/turn.ts';
import { parseCampaignConfig } from '../../../packages/intent/src/config.ts';
import {
  ATTRIBUTE_MAX,
  ATTRIBUTE_MIN,
  ATTRIBUTES,
  type Attribute,
  attemptCheck,
  checkBonus,
  createSheet,
  D20_LITE_MANIFEST,
  DEFAULT_CHECK_ATTRIBUTE,
  DEFAULT_CHECK_DC,
} from '../../../packages/rules/src/d20-lite.ts';
import { type RollEvent, replayRoll } from '../../../packages/rules/src/dice.ts';
import {
  DEFAULT_POOL_CONFIG,
  DICE_POOL_LITE_MANIFEST,
  type PoolRoll,
  rollPool,
} from '../../../packages/rules/src/dice-pool-lite.ts';
import type { ActionResolution } from '../../../packages/rules/src/resolve.ts';
import { isRecord, type ManifestIssue, type RulePackManifest } from '../../../packages/rules/src/rulepack.ts';

export const DICE_MECHANIC = 'dice';
export const POOL_MECHANIC = 'dice-pool';

const NO_BONUS = 0;
const VISUALIZATION_OFF: VisualizationPreference = { enabled: false };
const DICE_FIELD = 'dice';
const DICE_OFF = 'off';
const ATTEMPT_WORDS = new Set(['try', 'tries', 'attempt', 'attempts', 'roll', 'rolls']);
const WORD_SEPARATOR = /[^\p{L}]+/u;
const BASE_POOL_DICE = 2;
const ISSUE_SEPARATOR = '; ';

const rolled = <T>(result: { ok: true; roll: T } | { ok: false; issues: ManifestIssue[] }): T => {
  if (!result.ok) throw new RangeError(result.issues.map(({ message }) => message).join(ISSUE_SEPARATOR));
  return result.roll;
};

const isScore = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= ATTRIBUTE_MIN && Number(value) <= ATTRIBUTE_MAX;

const d20Check = (events: readonly CampaignEvent[], actorId: CharacterId): Check | undefined => {
  const parsed = parseCharacterProfile(profileOf(events, actorId));
  if (!parsed.ok) return undefined;
  const scores = new Map(parsed.profile.traits.map(({ id, value }) => [id, value]));
  const attributes = Object.fromEntries(ATTRIBUTES.map((id) => [id, scores.get(id)]));
  if (!ATTRIBUTES.every((id) => isScore(attributes[id]))) return undefined;
  const sheet = createSheet({ characterId: actorId, attributes: attributes as Record<Attribute, number> });
  const attribute = DEFAULT_CHECK_ATTRIBUTE;
  return (actionId, rng) => {
    const check = attemptCheck({ actionId, sheet, attribute, dc: DEFAULT_CHECK_DC, rng });
    if (!check.ok) throw new RangeError(check.error.issues.map(({ message }) => message).join(ISSUE_SEPARATOR));
    return { rolls: check.rolls, events: check.events, bonus: checkBonus({ sheet, attribute }) };
  };
};

const CHECKS: readonly (readonly [
  RulePackManifest,
  (events: readonly CampaignEvent[], actorId: CharacterId) => Check | undefined,
])[] = [
  [D20_LITE_MANIFEST, d20Check],
  [
    DICE_POOL_LITE_MANIFEST,
    () => (actionId, rng) => {
      const roll = rolled(rollPool({ actionId, dice: BASE_POOL_DICE, config: DEFAULT_POOL_CONFIG, rng }));
      return { rolls: roll.rolls, events: [{ event: roll.outcome }] };
    },
  ],
];

const isAttempt = (input: string) =>
  input
    .toLowerCase()
    .split(WORD_SEPARATOR)
    .some((word) => ATTEMPT_WORDS.has(word));

export const checkFor = (events: readonly CampaignEvent[], input: string, actorId: CharacterId): Check | undefined => {
  const saved = parseCampaignConfig(campaignConfigOf(events));
  if (!saved.ok || !isAttempt(input)) return undefined;
  const { values, capabilities, rulepack } = saved.config;
  if (values.dice === DICE_OFF || !capabilities.supported.includes(DICE_FIELD)) return undefined;
  return CHECKS.find(
    ([pack]) => pack.id === rulepack?.id && pack.edition === rulepack.edition && pack.revision === rulepack.revision,
  )?.[1](events, actorId);
};

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
  const bonus = Number.isFinite(resolution.bonus) ? Number(resolution.bonus) : NO_BONUS;
  return resolution.rolls.flatMap((stored) => {
    const replayed = replayRoll(stored);
    return replayed.ok ? [rollResult(replayed.event, visibility, outcome, bonus)] : [];
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
