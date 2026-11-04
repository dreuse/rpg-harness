import { creationRulesOf } from './character-builder.ts';
import { createRoller, MAX_DICE_PER_TERM, MAX_SIDES, MIN_SIDES, type Rng, type TrustedRoll } from './dice.ts';
import {
  isNonEmptyString,
  isRecord,
  type ManifestIssue,
  NON_EMPTY_STRING,
  RULEPACK_CONTRACT_VERSION,
  type RulePackManifest,
} from './rulepack.ts';

export const DEFAULT_SIDES = 6;
export const DEFAULT_SUCCESS_THRESHOLD = 5;
export const DEFAULT_COMPLICATION_FACE = 1;
export const NO_COMPLICATIONS = 0;

const MIN_FACE = 1;
const MIN_DICE = 0;
const POOL_ROLL_SUFFIX = ':pool';

export const DICE_POOL_LITE_MANIFEST: RulePackManifest = {
  contractVersion: RULEPACK_CONTRACT_VERSION,
  id: 'dice-pool-lite',
  edition: 'original',
  revision: '1',
  capabilities: { checks: true },
  sourceRefs: [],
};

export const DICE_POOL_LITE_CREATION = creationRulesOf(DICE_POOL_LITE_MANIFEST);

export type PoolConfig = {
  readonly sides: number;
  readonly successThreshold: number;
  readonly complicationFace: number;
};
export type PoolOutcome = 'success' | 'mixed' | 'complication' | 'failure';
export type PoolRoll = {
  faces: number[];
  successes: number;
  complications: number;
  outcome: PoolOutcome;
  rolls: TrustedRoll[];
};
export type PoolConfigResult = { ok: true; config: PoolConfig } | { ok: false; issues: ManifestIssue[] };
export type PoolRollResult = { ok: true; roll: PoolRoll } | { ok: false; issues: ManifestIssue[] };
export type OpposedResult = { winner: 'first' | 'second' | 'tie'; margin: number };

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  sides: DEFAULT_SIDES,
  successThreshold: DEFAULT_SUCCESS_THRESHOLD,
  complicationFace: DEFAULT_COMPLICATION_FACE,
};

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

const range = (min: number, max: number) => `must be an integer from ${min} to ${max}`;

export const validatePoolConfig = (input: unknown): PoolConfigResult => {
  if (!isRecord(input)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  const { sides, successThreshold, complicationFace } = input;
  const issues: ManifestIssue[] = [];
  if (!isIntegerIn(sides, MIN_SIDES, MAX_SIDES)) issues.push({ path: 'sides', message: range(MIN_SIDES, MAX_SIDES) });
  const maxFace = isIntegerIn(sides, MIN_SIDES, MAX_SIDES) ? sides : MAX_SIDES;
  if (!isIntegerIn(successThreshold, MIN_FACE, maxFace)) {
    issues.push({ path: 'successThreshold', message: range(MIN_FACE, maxFace) });
  }
  const maxComplication = (isIntegerIn(successThreshold, MIN_FACE, maxFace) ? successThreshold : maxFace) - MIN_FACE;
  if (!isIntegerIn(complicationFace, NO_COMPLICATIONS, maxComplication)) {
    issues.push({ path: 'complicationFace', message: range(NO_COMPLICATIONS, maxComplication) });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config: { sides, successThreshold, complicationFace } as PoolConfig };
};

const classify = (successes: number, complications: number): PoolOutcome => {
  if (successes > 0) return complications > 0 ? 'mixed' : 'success';
  return complications > 0 ? 'complication' : 'failure';
};

const tally = (faces: number[], config: PoolConfig, rolls: TrustedRoll[]): PoolRoll => {
  const successes = faces.filter((face) => face >= config.successThreshold).length;
  const complications = faces.filter((face) => face <= config.complicationFace).length;
  return { faces, successes, complications, outcome: classify(successes, complications), rolls };
};

export type PoolInput = { actionId: string; dice: number; config: PoolConfig; rng: Rng };

export const rollPool = ({ actionId, dice, config, rng }: PoolInput): PoolRollResult => {
  const parsed = validatePoolConfig(config);
  const issues = [
    ...(isNonEmptyString(actionId) ? [] : [{ path: 'actionId', message: NON_EMPTY_STRING }]),
    ...(isIntegerIn(dice, MIN_DICE, MAX_DICE_PER_TERM)
      ? []
      : [{ path: 'dice', message: range(MIN_DICE, MAX_DICE_PER_TERM) }]),
    ...(parsed.ok ? [] : parsed.issues.map((issue) => ({ ...issue, path: `config.${issue.path}` }))),
  ];
  if (!parsed.ok || issues.length > 0) return { ok: false, issues };
  if (dice === MIN_DICE) return { ok: true, roll: tally([], parsed.config, []) };
  const rolled = createRoller(rng)(`${actionId}${POOL_ROLL_SUFFIX}`, {
    dice: [{ count: dice, sides: parsed.config.sides }],
    modifier: 0,
  });
  if (!rolled.ok) return rolled;
  return { ok: true, roll: tally([...rolled.roll.draws.flat()], parsed.config, [rolled.roll]) };
};

export const opposedCheck = (first: PoolRoll, second: PoolRoll): OpposedResult => {
  const difference = first.successes - second.successes;
  const winner = difference > 0 ? 'first' : difference < 0 ? 'second' : 'tie';
  return { winner, margin: Math.abs(difference) };
};
